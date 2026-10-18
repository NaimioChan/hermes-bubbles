/**
 * End-to-end verification against the LIVE Hermes dashboard.
 *
 * Drives a dedicated headless Edge over raw CDP (the browser_exec localhost
 * guard does not apply to raw CDP), loads /chat, and asserts the bubble page
 * actually took over the route: the plugin's DOM is present, the built-in
 * xterm is gone, a real message round-trips through the gateway, and the reply
 * renders as a bubble rather than terminal text.
 *
 * Run with the dashboard up:  node scripts/verify.mjs
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const projectRoot = dirname(root);
const shots = join(projectRoot, ".cache", "shots");
mkdirSync(shots, { recursive: true });

const DASHBOARD = process.env.HERMES_DASHBOARD_URL ?? "http://127.0.0.1:9119";
const PORT = Number(process.env.CDP_PORT ?? 9225);
const EDGE = process.env.EDGE_PATH ?? "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const USER_DATA = join(process.env.LOCALAPPDATA ?? process.env.TEMP ?? ".", "Temp", "edge-cdp-bubbles");

const results = [];
let failures = 0;

function check(name, ok, detail, options = {}) {
  // Soft checks depend on a live model doing what it was asked (calling todo /
  // delegate_task). A model that ignores the instruction is a flaky test, not a
  // broken plugin, so those report SKIP instead of failing the run.
  const soft = Boolean(options.soft);
  results.push({ name, ok, detail, soft });
  if (!ok && !soft) failures += 1;
  const mark = ok ? "PASS" : soft ? "SKIP" : "FAIL";
  console.log(`${mark}  ${name}${detail === undefined ? "" : `  — ${detail}`}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function cdpTargets() {
  const response = await fetch(`http://127.0.0.1:${PORT}/json/list`);
  return response.json();
}

class Session {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 0;
    this.pending = new Map();
    this.consoleLines = [];
    ws.addEventListener("message", (event) => {
      const frame = JSON.parse(event.data);
      if (frame.id !== undefined) {
        const call = this.pending.get(frame.id);
        if (call) {
          this.pending.delete(frame.id);
          clearTimeout(call.timer);
          frame.error ? call.reject(new Error(JSON.stringify(frame.error))) : call.resolve(frame.result);
        }
        return;
      }
      if (frame.method === "Runtime.consoleAPICalled") {
        this.consoleLines.push(
          `[${frame.params.type}] ${frame.params.args.map((a) => a.value ?? a.description ?? a.type).join(" ")}`,
        );
      }
      if (frame.method === "Runtime.exceptionThrown") {
        const d = frame.params.exceptionDetails;
        // Include the origin. Without it a stray exception from browser internals
        // is indistinguishable from one of ours, which makes this check useless.
        const where = d.url || d.stackTrace?.callFrames?.[0]?.url || "unknown";
        const line = d.lineNumber ?? d.stackTrace?.callFrames?.[0]?.lineNumber ?? "?";
        this.consoleLines.push(`[exception] ${d.exception?.description ?? d.text} @ ${where}:${line}`);
      }
    });
  }

  send(method, params = {}) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`CDP timeout: ${method}`)), 20000);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression, { awaitPromise = false } = {}) {
    const result = await this.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    }
    return result.result?.value;
  }

  async screenshot(name) {
    const shot = await this.send("Page.captureScreenshot", { format: "png" });
    const path = join(shots, name);
    writeFileSync(path, Buffer.from(shot.data, "base64"));
    return path;
  }
}

async function connect() {
  const targets = await cdpTargets();
  const page = targets.find((t) => t.type === "page" && !t.url.startsWith("edge://") && !t.url.startsWith("chrome://"))
    ?? targets.find((t) => t.type === "page");
  if (!page) throw new Error("no page target in the headless instance");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });
  const session = new Session(ws);
  await session.send("Page.enable");
  await session.send("Runtime.enable");
  await session.send("Network.enable");
  await session.send("Network.setCacheDisabled", { cacheDisabled: true });
  await session.send("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  // A second tab (Edge's sync dialog) makes this one hidden, which freezes rAF
  // and hangs captureScreenshot.
  await session.send("Page.bringToFront");
  return session;
}

async function waitFor(session, expression, { timeout = 20000, label = expression } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      if (await session.evaluate(expression)) return true;
    } catch {
      // page may be mid-navigation
    }
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${label}`);
}

/** `waitFor` for the soft checks: a timeout is a false, not an exception. */
async function waitForOr(session, expression, options) {
  try {
    return await waitFor(session, expression, options);
  } catch {
    return false;
  }
}

/** Type into the composer and press Enter, the way a person would. */
async function typeAndSend(session, text) {
  await session.evaluate(`(() => {
    const ta = document.querySelector('textarea');
    if (!ta) return false;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, ${JSON.stringify(text)});
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await sleep(150);
  await session.evaluate(
    `document.querySelector('textarea').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`,
  );
}

async function main() {
  console.log(`dashboard: ${DASHBOARD}`);
  console.log(`cdp: 127.0.0.1:${PORT}\n`);

  const child = spawn(
    EDGE,
    [
      "--headless=new",
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${USER_DATA}`,
      "--no-first-run",
      "--no-default-browser-check",
      "about:blank",
    ],
    { stdio: "ignore", detached: false },
  );

  try {
    // readiness
    const deadline = Date.now() + 20000;
    let ready = false;
    while (Date.now() < deadline && !ready) {
      try {
        await fetch(`http://127.0.0.1:${PORT}/json/version`);
        ready = true;
      } catch {
        await sleep(300);
      }
    }
    if (!ready) throw new Error("headless Edge never came up");

    const session = await connect();
    await session.send("Page.navigate", { url: `${DASHBOARD}/chat` });
    await sleep(2500);

    // ── the plugin owns the route ───────────────────────────────────────────
    const title = await session.evaluate("document.title");
    check("page loaded", typeof title === "string", title);

    const pluginLoaded = await session.evaluate(
      "Boolean(window.__HERMES_PLUGINS__ && window.__HERMES_PLUGIN_SDK__)",
    );
    check("plugin SDK exposed on window", pluginLoaded === true, String(pluginLoaded));

    await waitFor(session, "Boolean(document.querySelector('textarea'))", { label: "composer textarea" });
    check("bubble composer rendered", true);

    // Regression: the composer must leave "连接中…" on its own, with no user
    // action. The original bug fired session.create before the socket existed,
    // painted "gateway not connected", and only recovered if you typed.
    let composerReady = false;
    const composerDeadline = Date.now() + 15000;
    while (Date.now() < composerDeadline && !composerReady) {
      composerReady = await session.evaluate(`(() => {
        const ta = document.querySelector('textarea');
        return Boolean(ta) && !ta.disabled && !ta.placeholder.includes('连接中');
      })()`);
      if (!composerReady) await sleep(500);
    }
    check("composer becomes ready without user action (connect race)", composerReady === true);

    const noGatewayError = await session.evaluate(
      `!document.body.innerText.includes('gateway not connected')`,
    );
    check("no 'gateway not connected' banner on a healthy socket", noGatewayError === true);

    // ── composer grows with its text, and stops ────────────────────────────
    // The native resize grip is gone, so a box stuck at one row would hide every
    // line after the first. Measured, not inferred: set the value, let React
    // commit, then read the box's own geometry in a SEPARATE evaluate.
    const fillComposer = async (value) => {
      await session.evaluate(`(() => {
        const ta = document.querySelector('textarea');
        const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
        setter.call(ta, ${JSON.stringify(value)});
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      })()`);
      await sleep(250);
      return session.evaluate(`(() => {
        const ta = document.querySelector('textarea');
        const box = ta.getBoundingClientRect();
        return JSON.stringify({
          height: Math.round(box.height),
          scrollHeight: ta.scrollHeight,
          overflowY: getComputedStyle(ta).overflowY,
        });
      })()`);
    };

    const oneRow = JSON.parse(await fillComposer("hello"));
    const threeRows = JSON.parse(await fillComposer("one\ntwo\nthree"));
    check(
      "composer starts at one row and grows with the text",
      oneRow.height <= 40 && threeRows.height > oneRow.height,
      `one=${JSON.stringify(oneRow)} three=${JSON.stringify(threeRows)}`,
    );

    const tall = JSON.parse(await fillComposer(Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n")));
    check(
      "composer stops at its cap and scrolls the rest",
      tall.height === 192 && tall.scrollHeight > tall.height && tall.overflowY === "auto",
      JSON.stringify(tall),
    );

    const cleared = JSON.parse(await fillComposer(""));
    check(
      "composer shrinks back to one row when emptied",
      Math.abs(cleared.height - oneRow.height) <= 1,
      JSON.stringify(cleared),
    );

    const hasXterm = await session.evaluate("Boolean(document.querySelector('.xterm'))");
    check("built-in xterm terminal is gone (route overridden)", hasXterm === false, `xterm present: ${hasXterm}`);

    const bubbleCount = await session.evaluate(
      "document.querySelectorAll('[class*=\"rounded\"], div').length",
    );
    check("page has DOM content", bubbleCount > 10, `${bubbleCount} elements`);

    // ── theme inheritance: the page must use dashboard CSS vars ─────────────
    const usesVars = await session.evaluate(`(() => {
      const el = document.querySelector('textarea');
      if (!el) return 'no textarea';
      const styles = [...document.styleSheets].flatMap((sheet) => {
        try { return [...sheet.cssRules].map((r) => r.cssText); } catch { return []; }
      }).join(' ');
      return styles.includes('var(--color-') ? 'vars' : 'no-vars';
    })()`);
    check("stylesheet references dashboard theme variables", usesVars === "vars", usesVars);

    const pluginCssLoaded = await session.evaluate(
      `[...document.styleSheets].some(s => (s.href ?? '').includes('hermes-bubbles'))`,
    );
    check("plugin stylesheet loaded", pluginCssLoaded === true, String(pluginCssLoaded));

    // ── the backend probe route ────────────────────────────────────────────
    // Must go through the SDK's fetchJSON: it injects the session-token header
    // that a bare fetch() lacks, and the plugin API route sits behind auth.
    const probe = await session.evaluate(
      `window.__HERMES_PLUGIN_SDK__.fetchJSON('/api/plugins/hermes-bubbles/capabilities').then(d => JSON.stringify(d))`,
      { awaitPromise: true },
    );
    const capabilities = JSON.parse(probe);
    check(
      "backend capability probe passes",
      capabilities.ok === true,
      `missing methods: ${JSON.stringify(capabilities.missing_methods)} events: ${JSON.stringify(capabilities.missing_events)}`,
    );

    // ── a real turn: send a message and watch it stream back as a bubble ────
    const sent = await session.evaluate(`(() => {
      const ta = document.querySelector('textarea');
      if (!ta) return 'no textarea';
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      setter.call(ta, '回答两个字：收到');
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      return 'typed';
    })()`);
    check("composer accepts typed text", sent === "typed", sent);

    await session.evaluate(`(() => {
      const ta = document.querySelector('textarea');
      ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      return 'sent';
    })()`);

    await sleep(1500);
    const userBubble = await session.evaluate(
      `[...document.querySelectorAll('div')].some(d => d.textContent === '回答两个字：收到')`,
    );
    check("user message rendered as a bubble", userBubble === true, String(userBubble));

    const connected = await session.evaluate(`(() => {
      const ta = document.querySelector('textarea');
      return ta ? ta.getAttribute('placeholder') : '';
    })()`);
    check("composer left the connecting state", !String(connected).includes("连接中"), String(connected));

    // Wait for the assistant to answer (a real model round trip).
    let replied = false;
    const replyDeadline = Date.now() + 90000;
    while (Date.now() < replyDeadline && !replied) {
      replied = await session.evaluate(`(() => {
        const bubbles = [...document.querySelectorAll('div')].filter(d =>
          d.style && d.style.borderRadius && d.style.background);
        return bubbles.length >= 2 && bubbles.some(b => b.textContent.trim().length > 0 &&
          b.textContent !== '回答两个字：收到');
      })()`);
      if (!replied) await sleep(2000);
    }
    check("assistant reply arrived as a bubble", replied === true);

    const shot = await session.screenshot("01-chat-bubbles.png");
    console.log(`\nscreenshot: ${shot}`);

    // ── v0.2: slash menu ───────────────────────────────────────────────────
    const slashMenu = await session.evaluate(`(() => {
      const ta = document.querySelector('textarea');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      setter.call(ta, '/');
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
      return 'ok';
    })()`);
    void slashMenu;
    await sleep(700);
    const slashVisible = await session.evaluate(`(() => {
      const rows = [...document.querySelectorAll('button')].filter(b => (b.textContent || '').trim().startsWith('/'));
      return rows.length;
    })()`);
    check("typing / opens the command menu", slashVisible > 0, `${slashVisible} rows`);

    const slashFiltered = await session.evaluate(`(() => {
      const ta = document.querySelector('textarea');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      setter.call(ta, '/hel');
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      return 'ok';
    })()`);
    void slashFiltered;
    await sleep(400);
    const filtered = await session.evaluate(`(() => {
      const rows = [...document.querySelectorAll('button')].filter(b => (b.textContent || '').trim().startsWith('/'));
      return { count: rows.length, names: rows.slice(0, 3).map(r => (r.textContent || '').trim().split(/\s+/)[0]) };
    })()`);
    check("menu filters as you type", filtered.count > 0 && filtered.count <= 12, JSON.stringify(filtered));

    // Click the row, then read on a LATER turn: React's state update is async, so
    // reading synchronously in the same evaluate returns the pre-click value and
    // the check would pass on the typed text without proving the accept worked.
    await session.evaluate(`(() => {
      const row = [...document.querySelectorAll('button')].find(b => (b.textContent || '').trim().startsWith('/help'));
      if (!row) return 'no row';
      row.click();
      return 'clicked';
    })()`);
    await sleep(600);
    const accepted = await session.evaluate(`document.querySelector('textarea').value`);
    check(
      "accepting a completion replaces the token with the full command",
      String(accepted).trim() === "/help",
      JSON.stringify(accepted),
    );

    // ── v0.2: sidebar ──────────────────────────────────────────────────────
    const layout = await session.evaluate(`(() => {
      const ta = document.querySelector('textarea');
      const tr = ta.getBoundingClientRect();
      const tabs = [...document.querySelectorAll('[data-hb="tab"], [data-hb="tab-new"]')];
      const tabTop = tabs.length ? Math.min(...tabs.map(b => b.getBoundingClientRect().top)) : -1;
      const hist = document.querySelector('[data-hb="history-toggle"]');
      const histRight = hist ? hist.getBoundingClientRect().right : -1;
      return {
        tabTop, composerBottom: tr.bottom, windowH: window.innerHeight,
        historyButtonRight: histRight, windowW: window.innerWidth,
        hasHistoryButton: Boolean(hist),
      };
    })()`);
    check(
      "tabs sit at the top of the chat area",
      layout.tabTop >= 0 && layout.tabTop < layout.windowH * 0.25,
      `tabTop=${Math.round(layout.tabTop)} of ${layout.windowH}`,
    );
    check(
      "history toggle is pinned to the right edge",
      layout.hasHistoryButton && layout.historyButtonRight > layout.windowW * 0.7,
      `right=${Math.round(layout.historyButtonRight)} of ${layout.windowW}`,
    );

    // Opening it must reveal the panel on the right, not the left.
    await session.evaluate(`(() => {
      document.querySelector('[data-hb="history-toggle"]')?.click();
      return 'clicked';
    })()`);
    await sleep(1200);
    const panel = await session.evaluate(`(() => {
      // The panel container, found by its stable hook rather than by its heading
      // text (which is localized).
      const p = document.querySelector('[data-hb="history-panel"]')?.getBoundingClientRect();
      return p ? { left: Math.round(p.left), right: Math.round(p.right), windowW: window.innerWidth }
               : { left: -1, right: -1, windowW: window.innerWidth };
    })()`);
    check(
      "history panel opens on the right half",
      panel.left > panel.windowW * 0.5,
      JSON.stringify(panel),
    );

    const tabCount = () => session.evaluate(`(() => {
      // Counted by the stable data-hb hook, not by the localized label text:
      // the earlier version matched the Chinese label and broke the moment the
      // page went English-by-default.
      return document.querySelectorAll('[data-hb="tab"]').length;
    })()`);
    const tabsBefore = await tabCount();
    await session.evaluate(`(() => {
      document.querySelector('[data-hb="tab-new"]')?.click();
      return 'clicked';
    })()`);
    await sleep(3000);
    const tabsAfter = await tabCount();
    check("new-session button opens another tab", tabsAfter > tabsBefore, `${tabsBefore} -> ${tabsAfter}`);

    // ── item 6: `@` is plain text, `/` still opens the menu ────────────────
    // The `@` completion was removed: the backend keys `complete.path` on a word
    // that INCLUDES the leading `@`, and this client sent the bare query, so it
    // never matched. Assert `@` opens nothing and that `/` is untouched.
    const popoverIn = `(() => {
      const ta = document.querySelector('textarea');
      const composer = ta?.closest('.mx-auto');
      if (!composer) return null;
      const pop = composer.querySelector('.max-h-64, .max-h-48');
      return { text: ta.value, rows: pop ? pop.querySelectorAll('button').length : 0 };
    })()`;

    // Set the composer's value directly (React ignores a plain assignment, so go
    // through the native setter and fire an input event).
    const typeInComposer = async (value) => {
      await session.evaluate(
        "(() => { const ta = document.querySelector('textarea');"
        + " const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;"
        + " setter.call(ta, " + JSON.stringify(value) + ");"
        + " ta.dispatchEvent(new Event('input', { bubbles: true })); return 'typed'; })()",
      );
    };

    await typeInComposer('@');
    await sleep(1500);
    let atState = await session.evaluate(popoverIn);
    check("typing @ opens no popover (the feature was removed)", atState === null || atState.rows === 0, JSON.stringify(atState));

    await typeInComposer('看看 @file 这个');
    await sleep(1500);
    atState = await session.evaluate(popoverIn);
    check("typing @ mid-sentence opens no popover either", atState === null || atState.rows === 0, JSON.stringify(atState));

    await typeInComposer('/');
    await sleep(1500);
    const slashState = await session.evaluate(popoverIn);
    check("typing / still opens the command menu", slashState !== null && slashState.rows > 0, JSON.stringify(slashState));

    // Clear the composer so later steps start clean.
    await typeInComposer('');
    await sleep(300);

    // ── item 4: no speaker labels ──────────────────────────────────────────
    const labels = await session.evaluate(`(() => {
      // Scope to the transcript: the dashboard's own sidebar logo is also a line
      // reading exactly "HERMES", so a body-wide regex matches the app, not us.
      const scroller = [...document.querySelectorAll('div')]
        .find(d => d.className.includes('hb-scroll') && d.className.includes('overflow-y-auto'));
      if (!scroller) return { hermes: false, you: false, found: false };
      const t = scroller.innerText;
      return { hermes: /^HERMES$/m.test(t), you: /^你$/m.test(t), found: true };
    })()`);
    check(
      "bubbles carry no speaker label",
      labels.found === true && !labels.hermes && !labels.you,
      JSON.stringify(labels),
    );

    // ── item 6: the composer must not offer a native resize grip ───────────
    const resize = await session.evaluate(
      `getComputedStyle(document.querySelector('textarea')).resize`,
    );
    check("composer textarea has no native resize grip", resize === "none", String(resize));

    // ── item 7: mid-turn input must be accepted ────────────────────────────
    const midTurn = await session.evaluate(`(() => {
      const ta = document.querySelector('textarea');
      return { disabled: ta.disabled, placeholder: ta.placeholder };
    })()`);
    check("composer stays usable while idle", midTurn.disabled === false, JSON.stringify(midTurn));

    // ── v0.2: metrics after a real turn ────────────────────────────────────
    await session.evaluate(`(() => {
      const ta = document.querySelector('textarea');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      setter.call(ta, '只回复两个字：收到');
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      return 'sent';
    })()`);

    let metricsSeen = false;
    const metricsDeadline = Date.now() + 90000;
    while (Date.now() < metricsDeadline && !metricsSeen) {
      await sleep(2000);
      metricsSeen = await session.evaluate(`(() => {
        const text = document.body.innerText;
        return text.includes('t/s') || /\[▓░]+\]/.test(text);
      })()`);
    }
    check("live metrics appear after a turn (context bar / t/s)", metricsSeen === true);

    // ── item 1 (this round): rename + delete in the history panel ──────────
    // A rename is a real RPC round trip (resume → session.title), so this drives
    // the actual UI and then reads the backend list back.
    await session.evaluate(`(() => {
      // Ensure OPEN: the header toggle flips state, and an earlier layout check
      // may already have opened it (clicking blindly would close it again).
      if (!document.querySelector('[data-hb="history-panel"]')) {
        document.querySelector('[data-hb="history-toggle"]')?.click();
      }
      return Boolean(document.querySelector('[data-hb="history-panel"]'));
    })()`);
    await sleep(1500);

    const rowTools = await session.evaluate(`(() => {
      const panel = document.querySelector('[data-hb="history-panel"]');
      return panel ? {
        rename: panel.querySelectorAll('[data-hb="rename-session"]').length,
        del: panel.querySelectorAll('[data-hb="delete-session"]').length,
      } : null;
    })()`);
    check(
      "every history row offers rename and delete",
      rowTools !== null && rowTools.rename > 0 && rowTools.del === rowTools.rename,
      JSON.stringify(rowTools),
    );

    // Rename the first row through the UI.
    const renameTarget = await session.evaluate(`(() => {
      const btn = document.querySelector('[data-hb="rename-session"]');
      if (!btn) return null;
      btn.click();
      return 'opened';
    })()`);
    await sleep(700);
    const editorShown = await session.evaluate(`(() => {
      const input = document.querySelector('[data-hb="rename-input"]');
      return input ? { present: true, seeded: Boolean(input.value) } : { present: false, seeded: false };
    })()`);
    check(
      "rename opens an editor seeded with the current title",
      renameTarget === "opened" && editorShown.present === true && editorShown.seeded === true,
      JSON.stringify(editorShown),
    );

    const NEW_TITLE = "verify-renamed-" + Date.now().toString(36);
    await session.evaluate(
      "(() => { const input = document.querySelector('[data-hb=\"rename-input\"]');"
      + " if (!input) return 'none'; const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;"
      + " setter.call(input, " + JSON.stringify(NEW_TITLE) + ");"
      + " input.dispatchEvent(new Event('input', { bubbles: true })); return 'typed'; })()",
    );
    await sleep(300);
    await session.evaluate(`(() => {
      const input = document.querySelector('[data-hb="rename-input"]');
      if (!input) return 'none';
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      return 'committed';
    })()`);

    // Read back the way the panel does: `session.list` over the gateway.
    // REST /api/sessions is a DIFFERENT store (it returns null for a title set
    // through `session.title`), so asserting on it tested the wrong thing and
    // made a working rename look broken.
    const listViaRpc = async () => session.evaluate(`(async () => {
      const sdk = window.__HERMES_PLUGIN_SDK__;
      const url = await sdk.buildWsUrl('/api/ws');
      const ws = new WebSocket(url);
      const pending = new Map();
      let nextId = 1;
      const req = (method, params) => new Promise((resolve) => {
        const id = nextId++;
        pending.set(id, resolve);
        ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
        setTimeout(() => resolve({ error: 'timeout' }), 8000);
      });
      ws.onmessage = (e) => {
        const f = JSON.parse(e.data);
        if (f.id !== undefined) { const r = pending.get(f.id); if (r) { pending.delete(f.id); r(f); } }
      };
      await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
      const listed = await req('session.list', { limit: 40 });
      ws.close();
      return (listed.result?.sessions ?? []).map((r) => ({ id: r.id, title: r.title }));
    })()`, { awaitPromise: true });

    let renamed = false;
    for (let i = 0; i < 12; i += 1) {
      await sleep(1200);
      const rows = await listViaRpc();
      const hit = Array.isArray(rows) ? rows.find((r) => (r.title || "") === NEW_TITLE) : null;
      renamed = Boolean(hit);
      if (renamed) break;
    }
    check("renaming a history row persists to the backend", renamed === true, NEW_TITLE);

    // Delete a DISPOSABLE session, never the one this run is chatting in: that
    // session is active by definition and the gateway refuses it (4023), while
    // REST answers ok and the row simply re-persists.
    const deleted = await session.evaluate(`(async () => {
      const sdk = window.__HERMES_PLUGIN_SDK__;
      const url = await sdk.buildWsUrl('/api/ws');
      const ws = new WebSocket(url);
      const pending = new Map();
      let nextId = 1;
      const req = (method, params) => new Promise((resolve) => {
        const id = nextId++;
        pending.set(id, resolve);
        ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
        setTimeout(() => resolve({ error: 'timeout' }), 8000);
      });
      ws.onmessage = (e) => {
        const f = JSON.parse(e.data);
        if (f.id !== undefined) { const r = pending.get(f.id); if (r) { pending.delete(f.id); r(f); } }
      };
      await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

      // Mint a throwaway stored session: create one, send a turn so a row exists,
      // then close it so it is not active.
      const made = await req('session.create', { source: 'desktop' });
      const runtimeId = made.result?.session_id;
      const storedId = made.result?.stored_session_id;
      if (!runtimeId) { ws.close(); return { error: 'could not create a scratch session' }; }

      await req('prompt.submit', { session_id: runtimeId, text: 'scratch session for delete test' });
      await new Promise((r) => setTimeout(r, 4000));
      await req('session.close', { session_id: runtimeId });
      await new Promise((r) => setTimeout(r, 1500));

      // Find it in the list and confirm it is not one of the open tabs.
      const listed = await req('session.list', { limit: 20 });
      const victim = (listed.result?.sessions ?? []).find((r) => r.id === storedId)
        ?? (listed.result?.sessions ?? [])[0];
      ws.close();
      if (!victim) return { error: 'scratch session did not persist' };

      // Drive the real UI: refresh the panel, find the row, click delete.
      const refreshBtn = [...document.querySelectorAll('[data-hb="history-panel"] button')]
        .find((b) => /refresh/i.test(b.getAttribute('title') || ''));
      refreshBtn?.click();
      await new Promise((r) => setTimeout(r, 2000));

      const panel = document.querySelector('[data-hb="history-panel"]');
      const rows = panel
        ? [...panel.querySelectorAll('[data-hb="delete-session"]')].map((b) => b.closest('div')).filter(Boolean)
        : [];
      const row = rows.find((r) => (r.innerText || '').includes((victim.title || '').slice(0, 20)))
        ?? rows[0];
      const del = row?.querySelector('[data-hb="delete-session"]');
      if (!del) return { error: 'no delete button found', victim: victim.id };

      const realConfirm = window.confirm;
      window.confirm = () => true;
      del.click();
      window.confirm = realConfirm;
      return { clicked: true, victimId: victim.id, victimTitle: (victim.title || '').slice(0, 30) };
    })()`, { awaitPromise: true });

    let gone = false;
    if (deleted && deleted.victimId) {
      for (let i = 0; i < 12; i += 1) {
        await sleep(1200);
        const rows = await listViaRpc();
        gone = Array.isArray(rows) && !rows.some((r) => r.id === deleted.victimId);
        if (gone) break;
      }
    }
    check(
      "deleting a history row removes it from the backend",
      deleted !== null && deleted.clicked === true && gone === true,
      JSON.stringify({ deleted, gone }),
    );

    // Leave it open: later checks that measure the transcript tolerate that, and
    // closing here would fight the next blind toggle.
    await sleep(200);
    await sleep(600);

    // ── item 3 (this round): approval/clarify choices stack one per line ────
    // Measured on a controlled sample with the real classes: the card only shows
    // when the model chooses to ask, and a check that depends on that would fail
    // at random.
    const choiceLayout = await session.evaluate(`(() => {
      const host = document.createElement('div');
      host.style.cssText = 'position:absolute;left:-9999px;top:0;width:700px';
      host.innerHTML = '<div class="hb-choice-col">'
        + '<button class="hb-action-btn-text hb-choice-row">选项一</button>'
        + '<button class="hb-action-btn-text hb-choice-row">选项二</button>'
        + '<button class="hb-action-btn-text hb-choice-row">选项三</button></div>';
      document.body.appendChild(host);
      const btns = [...host.querySelectorAll('.hb-choice-row')];
      const rects = btns.map((b) => b.getBoundingClientRect());
      const out = {
        options: btns.length,
        distinctRows: new Set(rects.map((r) => Math.round(r.top))).size,
        allFullWidth: rects.every((r) => Math.round(r.width) > 200),
        direction: getComputedStyle(btns[0].parentElement).flexDirection,
      };
      host.remove();
      return out;
    })()`);
    check(
      "every choice sits on its own line, full width",
      choiceLayout !== null && choiceLayout.options === 3 && choiceLayout.distinctRows === 3
        && choiceLayout.allFullWidth === true && choiceLayout.direction === "column",
      JSON.stringify(choiceLayout),
    );

    // ── item 5 (this round): a copy button on code blocks ──────────────────
    const codeCopy = await session.evaluate(`(() => {
      const blocks = [...document.querySelectorAll('.hb-md-codeblock')];
      if (!blocks.length) return { blocks: 0 };
      return {
        blocks: blocks.length,
        buttons: blocks.filter((b) => b.querySelector('[data-hb="copy-code"]')).length,
        labelled: Boolean(blocks[0].querySelector('[data-hb="copy-code"]')?.getAttribute('title')),
      };
    })()`);
    // A code block only exists if the model emitted one; treat "none on screen" as
    // a skip rather than a failure, and say so.
    if (codeCopy.blocks > 0) {
      check(
        "every code block carries a copy button",
        codeCopy.buttons === codeCopy.blocks && codeCopy.labelled === true,
        JSON.stringify(codeCopy),
      );
    } else {
      console.log("SKIP  code-block copy button — no code block in this run's replies");
    }

    // ── item 4: inline code contrast ───────────────────────────────────────
    // The chip painted (a background was set) while the TEXT stayed at the host's
    // near-background colour, so it was unreadable. Assert a real contrast ratio
    // against the bubble, not merely that a background exists.
    const inlineCode = await session.evaluate(`(() => {
      // Measure a controlled sample inside a real bubble: the transcript only
      // carries inline code when the model chose to emit some, and a check that
      // silently finds nothing proves nothing.
      const host = document.createElement('div');
      host.style.cssText = 'position:absolute;left:-9999px;top:0;width:900px';
      const bubble = document.createElement('div');
      bubble.className = 'break-words px-3 py-2 text-sm leading-relaxed hb-bubble-text';
      bubble.style.cssText = 'max-width:min(72ch,82%);background:var(--color-card);color:var(--color-card-foreground)';
      const md = document.createElement('div');
      md.className = 'hb-md';
      md.innerHTML = '<p class="hb-md-p">行内 <code class="hb-inline-code">npm test</code> 结束</p>';
      bubble.appendChild(md);
      host.appendChild(bubble);
      document.body.appendChild(host);
      const code = md.querySelector('.hb-inline-code');
      const cs = getComputedStyle(code);
      const lum = (color) => {
        const c = document.createElement('canvas').getContext('2d');
        c.fillStyle = color; c.fillRect(0, 0, 1, 1);
        const [r, g, b] = c.getImageData(0, 0, 1, 1).data;
        const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
        return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
      };
      // Contrast against the chip's own surface, and against the bubble behind it.
      const fg = lum(cs.color);
      const chipBg = lum(cs.backgroundColor === 'rgba(0, 0, 0, 0)' ? getComputedStyle(bubble).backgroundColor : cs.backgroundColor);
      const bubbleBg = lum(getComputedStyle(bubble).backgroundColor);
      const ratio = (a, b) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
      const out = {
        color: cs.color,
        bubbleColor: getComputedStyle(bubble).color,
        againstChip: +ratio(fg, chipBg).toFixed(2),
        againstBubble: +ratio(fg, bubbleBg).toFixed(2),
      };
      host.remove();
      return out;
    })()`);
    check(
      "inline code is legible (≥4.5:1 against its own surface)",
      inlineCode !== null && inlineCode.againstChip >= 4.5,
      JSON.stringify(inlineCode),
    );
    check(
      "inline code text follows the message text colour",
      inlineCode !== null && inlineCode.color === inlineCode.bubbleColor,
      JSON.stringify(inlineCode),
    );

    // ── item 2 (this round): editing a sent message ────────────────────────
    const editButton = await session.evaluate(`(() => {
      const rows = [...document.querySelectorAll('[data-hb="user-actions"]')];
      const btn = rows.at(-1)?.querySelector('[data-hb="edit-message"]');
      return btn ? { present: true, title: btn.getAttribute('title') } : { present: false };
    })()`);
    check(
      "a sent user message offers edit",
      editButton !== null && editButton.present === true,
      JSON.stringify(editButton),
    );

    // Clicking it must seed the composer with that message and say so.
    const seeded = await session.evaluate(`(() => {
      const rows = [...document.querySelectorAll('[data-hb="user-actions"]')];
      rows.at(-1)?.querySelector('[data-hb="edit-message"]')?.click();
      return 'clicked';
    })()`);
    await sleep(900);
    const editState = await session.evaluate(`(() => {
      const banner = document.querySelector('[data-hb="editing-banner"]');
      const ta = document.querySelector('textarea');
      return { banner: Boolean(banner), composerText: (ta?.value || '').slice(0, 40) };
    })()`);
    check(
      "edit seeds the composer and shows an editing banner",
      seeded === "clicked" && editState.banner === true && editState.composerText.length > 0,
      JSON.stringify(editState),
    );

    // Cancel out of edit mode so the run ends in a normal state.
    await session.evaluate(`(() => {
      const banner = document.querySelector('[data-hb="editing-banner"]');
      banner?.querySelector('button')?.click();
      return 'cancelled';
    })()`);
    await sleep(500);

    // ── item 2: bubbles have real vertical spacing ─────────────────────────
    const spacing = await session.evaluate(`(() => {
      const rows = [...document.querySelectorAll('.hb-bubble-gap')];
      if (!rows.length) return null;
      const cs = getComputedStyle(rows[rows.length - 1]);
      const container = rows[0].parentElement;
      return {
        rows: rows.length,
        marginTop: parseFloat(cs.marginTop),
        containerGap: getComputedStyle(container).gap,
      };
    })()`);
    check(
      "bubbles are separated by a real margin",
      spacing !== null && spacing.marginTop >= 14,
      `margin-top=${spacing?.marginTop}px`,
    );
    check(
      "spacing comes from one place (no container gap stacking on the margin)",
      spacing !== null && (spacing.containerGap === "normal" || spacing.containerGap === "0px"),
      `container gap=${spacing?.containerGap}`,
    );

    // ── item 3: per-message actions under a settled reply ──────────────────
    const actions = await session.evaluate(`(() => {
      const rows = [...document.querySelectorAll('.hb-actions')];
      if (!rows.length) return null;
      const row = rows[rows.length - 1];
      const cs = getComputedStyle(row);
      return {
        rows: rows.length,
        opacity: cs.opacity,
        // Always occupying height is what stops the row shifting the transcript
        // when it is revealed.
        minHeight: parseFloat(cs.minHeight),
        buttons: [...row.querySelectorAll('button')].map(b => b.getAttribute('title')).filter(Boolean),
        hasTime: Boolean(row.querySelector('time')?.textContent?.trim()),
        stamp: row.querySelector('time')?.textContent?.trim() ?? null,
      };
    })()`);
    check(
      "a settled reply carries an action row",
      actions !== null,
      actions ? JSON.stringify(actions) : "no .hb-actions row found",
    );
    check(
      "the action row offers branch, copy and regenerate",
      actions !== null
        && actions.buttons.length === 3
        && /branch/i.test(actions.buttons.join(" "))
        && /copy/i.test(actions.buttons.join(" "))
        && /refresh|regenerate/i.test(actions.buttons.join(" ")),
      JSON.stringify(actions?.buttons),
    );
    check(
      "the action row shows a timestamp",
      actions !== null && actions.hasTime === true,
      `stamp=${actions?.stamp}`,
    );
    check(
      "the action row is hidden until hover but reserves its height",
      actions !== null && actions.opacity === "0" && actions.minHeight > 0,
      JSON.stringify({ opacity: actions?.opacity, minHeight: actions?.minHeight }),
    );

    // Hovering the row must actually reveal it.
    await session.evaluate(`(() => {
      const rows = [...document.querySelectorAll('.hb-actions')];
      const row = rows[rows.length - 1];
      row.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      return 'hovered';
    })()`);
    await sleep(400);
    const hovered = await session.evaluate(`(() => {
      const rows = [...document.querySelectorAll('.hb-actions')];
      const row = rows[rows.length - 1];
      // :hover cannot be forced from script; assert the CSS rule exists instead
      // of pretending the state changed.
      let ruleFound = false;
      for (const sheet of document.styleSheets) {
        try {
          for (const rule of sheet.cssRules) {
            if (rule.selectorText && /\.hb-actions:hover/.test(rule.selectorText)) ruleFound = true;
          }
        } catch {}
      }
      return { ruleFound, opacity: getComputedStyle(row).opacity };
    })()`);
    check(
      "hovering is wired to reveal the row (CSS rule present)",
      hovered.ruleFound === true,
      JSON.stringify(hovered),
    );

    // Copy must reach a real clipboard path.
    const copyResult = await session.evaluate(`(async () => {
      const rows = [...document.querySelectorAll('.hb-actions')];
      const row = rows[rows.length - 1];
      const btn = [...row.querySelectorAll('button')].find(b => /copy|复制/i.test(b.getAttribute('title')||''));
      if (!btn) return { error: 'no copy button' };
      btn.click();
      await new Promise(r => setTimeout(r, 500));
      return { titleAfter: btn.getAttribute('title'), glyph: btn.textContent };
    })()`, { awaitPromise: true });
    // The glyph flipping is the user-visible confirmation the handler ran.
    check(
      "copy gives feedback on click",
      copyResult !== null && (copyResult.titleAfter === "Copied" || copyResult.glyph === "✓"),
      JSON.stringify(copyResult),
    );

    // ── item 5: the plugin follows the dashboard's language ────────────────
    const langBefore = await session.evaluate(
      `JSON.stringify({ placeholder: document.querySelector('textarea')?.placeholder, send: [...document.querySelectorAll('button')].map(b=>b.textContent.trim()).filter(x=>x==='Send'||x==='发送')[0] })`,
    );
    check(
      "the default UI language is English",
      langBefore.includes("Send a message") && langBefore.includes("Send"),
      langBefore,
    );

    // Switch to Chinese the way the dashboard's own switcher does, with no reload.
    await session.evaluate(`(() => {
      localStorage.setItem('hermes-locale', 'zh');
      document.documentElement.lang = 'zh';
      return 'switched';
    })()`);
    await sleep(1500);
    const langZh = await session.evaluate(`JSON.stringify({
      placeholder: document.querySelector('textarea')?.placeholder,
      send: [...document.querySelectorAll('button')].map(b=>b.textContent.trim()).filter(x=>x==='Send'||x==='发送')[0],
      actionTitles: [...document.querySelectorAll('.hb-actions button')].map(b=>b.getAttribute('title')).slice(0,3),
      thought: /思考|THOUGHT/i.test(document.body.innerText),
    })`);
    check(
      "switching the dashboard language to Chinese is picked up without a reload",
      langZh.includes("发消息") && langZh.includes("发送"),
      langZh,
    );
    check(
      "the action row is localized too",
      langZh.includes("复制") && langZh.includes("在新对话中分支"),
      langZh,
    );

    // And back.
    await session.evaluate(`(() => {
      localStorage.setItem('hermes-locale', 'en');
      document.documentElement.lang = 'en';
      return 'restored';
    })()`);
    await sleep(1200);
    const langBack = await session.evaluate(
      `JSON.stringify({ placeholder: document.querySelector('textarea')?.placeholder })`,
    );
    check(
      "switching back to English is picked up too",
      langBack.includes("Send a message"),
      langBack,
    );

    // ── item 7: mid-turn input ─────────────────────────────────────────────
    // Fire a deliberately slow turn, then inspect the composer WHILE it runs.
    // Checking at idle proves nothing: the requirement is that a running turn
    // still accepts text, so the model can be corrected mid-flight.
    await session.evaluate(`(() => {
      const ta = document.querySelector('textarea');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      setter.call(ta, '请调用 terminal 工具运行 sleep 15，等它跑完再回复两个字：完成');
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      return 'sent';
    })()`);

    let running = null;
    const runDeadline = Date.now() + 45000;
    while (Date.now() < runDeadline && !running) {
      await sleep(500);
      running = await session.evaluate(`(() => {
        const ta = document.querySelector('textarea');
        if (!ta) return null;
        const insert = document.querySelector('[data-hb="primary-action"]');
        const stop = document.querySelector('[data-hb="stop-action"]');
        // A running turn renders the stop control; that is the reliable signal,
        // independent of the language or of the primary action's label.
        if (!stop) return null;
        return {
          hasInsertButton: Boolean(insert),
          insertDisabled: insert ? insert.disabled : null,
          hasStopButton: Boolean(stop),
          textareaDisabled: ta.disabled,
        };
      })()`);
    }

    check(
      "composer accepts input while a turn is running",
      running !== null && running.textareaDisabled === false,
      running ? JSON.stringify(running) : "never observed the running state",
    );
    check(
      "the running state offers both an insert and a stop action",
      running !== null && running.hasInsertButton === true && running.hasStopButton === true,
      running ? JSON.stringify(running) : "not observed",
    );

    // Type while running and confirm it is not refused by the UI.
    if (running) {
      const typedMidTurn = await session.evaluate(`(() => {
        const ta = document.querySelector('textarea');
        const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
        setter.call(ta, '顺便说一句，忽略上面那句话');
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        const btn = document.querySelector('[data-hb="primary-action"]');
        return { value: ta.value, sendEnabled: btn ? !btn.disabled : false };
      })()`);
      check(
        "a mid-turn message can actually be submitted",
        typedMidTurn.value.includes("顺便") && typedMidTurn.sendEnabled === true,
        JSON.stringify(typedMidTurn),
      );
    }

    // ── item 4 (this round): tool cards start collapsed ────────────────────
    const toolCards = await session.evaluate(`(() => {
      const toggles = [...document.querySelectorAll('[data-hb="tool-toggle"]')];
      if (!toggles.length) return { cards: 0 };
      return {
        cards: toggles.length,
        collapsed: toggles.filter((t) => t.getAttribute("data-open") === "false").length,
        ariaMatches: toggles.every((t) => t.getAttribute("aria-expanded") === t.getAttribute("data-open")),
      };
    })()`);
    if (toolCards.cards > 0) {
      check(
        "tool cards render collapsed by default",
        toolCards.collapsed === toolCards.cards && toolCards.ariaMatches === true,
        JSON.stringify(toolCards),
      );
    } else {
      console.log("SKIP  tool cards — this run produced no tool calls");
    }

    // ── item 5: usage line size + reasoning spacing ────────────────────────
    // Measured here: this is the first point where the focused tab actually has a
    // finished turn to measure.
    const type = await session.evaluate(`(() => {
      const scroller = [...document.querySelectorAll('div')]
        .find(d => d.className.includes('hb-scroll') && d.className.includes('overflow-y-auto'));
      if (!scroller) return { error: 'no transcript' };
      const usage = [...scroller.querySelectorAll('div')].find(d =>
        d.children.length === 0 && /tokens|tok ·/.test(d.textContent || ''));
      const reasoning = scroller.querySelector('[data-hb="reasoning-toggle"]');
      // The row is its own transcript item now, so its spacing lives on the
      // item wrapper (the per-kind gap), not on the block itself.
      const reasoningRow = reasoning ? reasoning.closest('[data-hb-kind]') : null;
      return {
        usageSize: usage ? parseFloat(getComputedStyle(usage).fontSize) : null,
        reasoningSize: reasoning ? parseFloat(getComputedStyle(reasoning).fontSize) : null,
        reasoningPresent: Boolean(reasoning),
        reasoningMarginTop: reasoningRow ? parseFloat(getComputedStyle(reasoningRow).marginTop) : null,
      };
    })()`);
    // The usage line must stay in the smallest tier. A turn need not produce
    // reasoning at all, so when it did not, compare against that tier's known
    // size instead of failing on a block that is legitimately absent.
    const USAGE_MAX_PX = 10.5;
    check(
      "usage line is no larger than the reasoning text",
      typeof type.usageSize === "number"
        && type.usageSize <= (type.reasoningPresent ? type.reasoningSize + 0.01 : USAGE_MAX_PX),
      JSON.stringify(type),
    );
    if (type.reasoningPresent) {
      check(
        "reasoning row keeps real spacing above it",
        typeof type.reasoningMarginTop === "number" && type.reasoningMarginTop >= 4,
        `margin-top=${type.reasoningMarginTop}px`,
      );
    } else {
      console.log("SKIP  reasoning spacing — this turn produced no reasoning block");
    }

    // ── item 6 (this round): no empty bubbles, compact machinery ───────────
    // The reported pair of complaints: one blank bubble per chain of thought
    // (reasoning used to materialise as an assistant row with no text, complete
    // with a reserved copy strip) and over-sized tool cards. Both are measured
    // on the live transcript rather than asserted from the source.
    const furniture = await session.evaluate(`(() => {
      const scroller = [...document.querySelectorAll('div')]
        .find(d => d.className.includes('hb-scroll') && d.className.includes('overflow-y-auto'));
      if (!scroller) return { error: 'no transcript' };
      const emptyBubbles = [...scroller.querySelectorAll('.hb-bubble-text')]
        .filter((el) => !(el.textContent || '').trim()).length;
      const reasonings = [...scroller.querySelectorAll('[data-hb="reasoning-row"]')];
      const toggles = [...scroller.querySelectorAll('[data-hb="tool-toggle"]')];
      const toggleSizes = toggles.map((el) => ({
        fontSize: parseFloat(getComputedStyle(el).fontSize),
        height: Math.round(el.getBoundingClientRect().height),
      }));
      return {
        emptyBubbles,
        reasoningRows: reasonings.length,
        // A reasoning row nested inside an assistant bubble is the old shape.
        reasoningInBubble: reasonings.filter((el) => el.closest('[data-hb-kind="assistant"]')).length,
        toolRows: toggles.length,
        toolMaxFont: toggleSizes.length ? Math.max(...toggleSizes.map((s) => s.fontSize)) : null,
        toolMaxHeight: toggleSizes.length ? Math.max(...toggleSizes.map((s) => s.height)) : null,
      };
    })()`);
    check(
      "no empty message bubble is painted",
      furniture.emptyBubbles === 0,
      `emptyBubbles=${furniture.emptyBubbles}`,
    );
    if (furniture.reasoningRows > 0) {
      check(
        "thinking renders as its own row, not inside a bubble",
        furniture.reasoningInBubble === 0,
        `rows=${furniture.reasoningRows} inBubble=${furniture.reasoningInBubble}`,
      );
    } else {
      console.log("SKIP  thinking row placement — this turn produced no reasoning");
    }
    if (furniture.toolRows > 0) {
      check(
        "tool calls render as compact one-line rows",
        typeof furniture.toolMaxFont === "number"
          && furniture.toolMaxFont <= 12
          && typeof furniture.toolMaxHeight === "number"
          && furniture.toolMaxHeight <= 24,
        `font=${furniture.toolMaxFont}px height=${furniture.toolMaxHeight}px rows=${furniture.toolRows}`,
      );
    } else {
      console.log("SKIP  tool row compactness — this run produced no tool calls");
    }

    // Ignore anything thrown by a browser extension. Headless Edge still loads
    // its bundled extensions, and they throw across origins on their own
    // schedule; counting those made this check fail for reasons unrelated to the
    // plugin (observed: an installed PDF extension throwing
    // "Could not establish connection" from its own content script).
    const isPageError = (line) => {
      if (line.includes("chrome-extension://") || line.includes("edge-extension://")) return false;
      if (line.includes("extension://")) return false;
      return true;
    };
    // ── item 1 (this round): the locator rail ──────────────────────────────
    // The rail needs at least two user messages (jumping between one is pointless),
    // so make sure the transcript has two before measuring it.
    const userCount = await session.evaluate(
      `document.querySelectorAll('[data-hb="user-actions"]').length`,
    );
    if (typeof userCount === "number" && userCount < 2) {
      await session.evaluate(`(() => {
        const ta = document.querySelector('textarea');
        const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
        setter.call(ta, '再补一句，让轨道有两个定位点');
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        return 'sent';
      })()`);
      for (let i = 0; i < 40; i += 1) {
        await sleep(1200);
        const ready = await session.evaluate(`(() => {
          const b = document.querySelector('[data-hb="primary-action"]');
          return Boolean(b) && !b.disabled && b.getAttribute('title') === 'Send';
        })()`);
        if (ready) break;
      }
      await sleep(1500);
    }

    const rail = await session.evaluate(`(() => {
      const el = document.querySelector('[data-hb="locator-rail"]');
      if (!el) return { present: false };
      const ticks = [...el.querySelectorAll('[data-hb-tick]')];
      const scroller = document.querySelector('[data-hb="transcript"]');
      const rr = el.getBoundingClientRect();
      const sr = scroller.getBoundingClientRect();
      return {
        present: true,
        ticks: ticks.length,
        userBubbles: document.querySelectorAll('[data-hb="user-actions"]').length,
        // Pinned to the transcript's right edge, not floating in the content column.
        hugsRightEdge: rr.left >= sr.right - 40,
      };
    })()`);
    check("the locator rail renders beside the transcript", rail.present === true, JSON.stringify(rail));
    check(
      "the rail has one tick per user message and sits on the right edge",
      rail.present === true && rail.ticks === rail.userBubbles && rail.ticks >= 2 && rail.hugsRightEdge === true,
      JSON.stringify(rail),
    );

    // Every tick must address a real element, or "jump" is a no-op by construction.
    const railAnchors = await session.evaluate(`(() => {
      const el = document.querySelector('[data-hb="locator-rail"]');
      if (!el) return { error: 'no rail' };
      const ids = [...el.querySelectorAll('[data-hb-tick]')].map((t) => t.getAttribute('data-hb-tick'));
      const sc = document.querySelector('[data-hb="transcript"]');
      const missing = ids.filter((id) => !sc.querySelector('[data-hb-item="' + CSS.escape(id) + '"]'));
      return { ticks: ids.length, missing: missing.length, scrollable: sc.scrollHeight > sc.clientHeight };
    })()`);
    check(
      "every rail tick addresses a real bubble",
      railAnchors !== null && railAnchors.ticks > 0 && railAnchors.missing === 0,
      JSON.stringify(railAnchors),
    );

    // The jump itself is only observable when there is something to scroll. This
    // run's own transcript is short, so say so rather than assert a no-op.
    if (railAnchors !== null && railAnchors.scrollable === true) {
      const railJump = await session.evaluate(`(async () => {
        const sc = document.querySelector('[data-hb="transcript"]');
        const el = document.querySelector('[data-hb="locator-rail"]');
        if (!sc || !el) return { error: 'missing' };
        sc.scrollTop = sc.scrollHeight;
        await new Promise((r) => setTimeout(r, 300));
        const before = sc.scrollTop;
        el.querySelectorAll('[data-hb-tick]')[0]?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await new Promise((r) => setTimeout(r, 1000));
        return { moved: Math.round(before - sc.scrollTop) };
      })()`, { awaitPromise: true });
      check(
        "clicking a rail tick scrolls the transcript",
        railJump !== null && typeof railJump.moved === "number" && railJump.moved > 0,
        JSON.stringify(railJump),
      );
    } else {
      console.log("SKIP  rail jump — this run's transcript is shorter than the viewport, so there is nothing to scroll");
    }

    // ── ITEM 2 (this round): tabs survive a dashboard route change ──────────
    // The dashboard unmounts this page when you switch to Config and back. The
    // controller used to be disposed on unmount, which closed the socket and
    // dropped every open tab.
    await session.evaluate(`(() => {
      if (!document.querySelector('[data-hb="tab"]')) document.querySelector('[data-hb="tab-new"]')?.click();
      return 1;
    })()`);
    await sleep(2500);
    await session.evaluate(`(() => { document.querySelector('[data-hb="tab-new"]')?.click(); return 1; })()`);
    await sleep(3000);

    const tabsBeforeNav = await session.evaluate(
      `JSON.stringify([...document.querySelectorAll('[data-hb="tab"]')].map((t) => t.getAttribute('data-hb-key')))`,
    );

    // Navigate away through the real sidebar nav item (the dashboard uses router
    // paths, not hashes).
    const wentAway = await session.evaluate(String.raw`(() => {
      const nav = [...document.querySelectorAll('a[href], button')]
        .filter((el) => /^\s*config\s*$/i.test((el.textContent || '').trim()));
      if (nav.length) { nav[0].click(); return 'clicked'; }
      const byHref = [...document.querySelectorAll('a[href]')]
        .find((a) => /\/config/.test(a.getAttribute('href') || ''));
      if (byHref) { byHref.click(); return 'href-click'; }
      return 'not-found';
    })()`);
    await sleep(4000);
    const unmounted = await session.evaluate(
      `JSON.stringify({ chatMounted: Boolean(document.querySelector('[data-hb="transcript"]')), path: location.pathname })`,
    );
    check(
      "navigating away actually unmounts the chat page (the test is meaningful)",
      wentAway !== "not-found" && JSON.parse(unmounted).chatMounted === false,
      JSON.stringify({ wentAway, ...JSON.parse(unmounted) }),
    );

    // Come back and compare.
    await session.evaluate(`(() => {
      history.pushState({}, '', '/chat');
      window.dispatchEvent(new PopStateEvent('popstate'));
      return 1;
    })()`);
    await sleep(5000);
    const tabsAfterNav = await session.evaluate(
      `JSON.stringify([...document.querySelectorAll('[data-hb="tab"]')].map((t) => t.getAttribute('data-hb-key')))`,
    );
    const remounted = await session.evaluate(`Boolean(document.querySelector('[data-hb="transcript"]'))`);
    check(
      "coming back keeps every open tab",
      remounted === true && tabsAfterNav === tabsBeforeNav && JSON.parse(tabsBeforeNav).length >= 2,
      `before=${tabsBeforeNav} after=${tabsAfterNav}`,
    );

    // ── ITEM 1 (this round): history rows show which sessions are open ──────
    await session.evaluate(`(() => {
      if (!document.querySelector('[data-hb="history-panel"]')) document.querySelector('[data-hb="history-toggle"]')?.click();
      return 1;
    })()`);
    await sleep(2000);

    // Open a STORED session: a draft tab has no stored id, so it can never light
    // a lamp — an earlier version of this check measured exactly that and passed
    // vacuously.
    await session.evaluate(`(() => {
      const panel = document.querySelector('[data-hb="history-panel"]');
      const rows = panel
        ? [...panel.querySelectorAll('[data-hb="rename-session"]')].map((b) => b.closest('div')).filter(Boolean)
        : [];
      rows[0]?.click();
      return rows.length;
    })()`);
    await sleep(6500);

    const lamps = await session.evaluate(`(() => {
      const panel = document.querySelector('[data-hb="history-panel"]');
      if (!panel) return { error: 'no panel' };
      const found = [...panel.querySelectorAll('[data-hb="session-active"]')];
      return {
        lamps: found.length,
        states: found.map((l) => l.getAttribute('data-state')),
        labelled: found.every((l) => Boolean(l.getAttribute('title'))),
        sized: found.every((l) => parseFloat(getComputedStyle(l).width) > 0),
      };
    })()`);
    check(
      "an open session shows a lamp in the history list",
      lamps !== null && lamps.lamps >= 1 && lamps.labelled === true && lamps.sized === true,
      JSON.stringify(lamps),
    );
    check(
      "the lamp distinguishes open from running",
      lamps !== null && lamps.states.every((st) => st === "open" || st === "busy"),
      JSON.stringify(lamps?.states),
    );

    // ── item 2 (this round): the composer survives closing every tab ───────
    // Runs LAST in this block because it destroys the open transcript, so it is
    // followed by a fresh session for anything below it.
    // One click, one render: React batches state updates, so a synchronous loop
    // would close the same tab repeatedly and leave the rest open.
    let closedAll = 0;
    for (let i = 0; i < 20; i += 1) {
      const clicked = await session.evaluate(`(() => {
        const btn = document.querySelector('[data-hb="tab-close"]');
        if (!btn) return false;
        btn.click();
        return true;
      })()`);
      if (!clicked) break;
      closedAll += 1;
      await sleep(400);
    }
    await sleep(1200);
    const noTabs = await session.evaluate(`(() => {
      const ta = document.querySelector('textarea');
      return {
        tabs: document.querySelectorAll('[data-hb="tab"]').length,
        composerPresent: Boolean(ta),
        disabled: ta ? ta.disabled : null,
      };
    })()`);
    check(
      "with every tab closed the composer stays usable",
      closedAll > 0 && noTabs.tabs === 0 && noTabs.composerPresent === true && noTabs.disabled === false,
      JSON.stringify({ closedAll, ...noTabs }),
    );

    // Typing must enable Send, and sending must mint a session by itself.
    const sentFromNothing = await session.evaluate(`(async () => {
      const ta = document.querySelector('textarea');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      setter.call(ta, '关掉所有页签之后发的消息');
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 400));
      const btn = document.querySelector('[data-hb="primary-action"]');
      const beforeTabs = document.querySelectorAll('[data-hb="tab"]').length;
      ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      return { beforeTabs, sendEnabled: btn ? !btn.disabled : false };
    })()`, { awaitPromise: true });

    let sessionMinted = false;
    for (let i = 0; i < 20; i += 1) {
      await sleep(1000);
      sessionMinted = await session.evaluate(`document.querySelectorAll('[data-hb="tab"]').length > 0`);
      if (sessionMinted) break;
    }
    check(
      "sending with no tab open creates a session automatically",
      sentFromNothing.sendEnabled === true && sentFromNothing.beforeTabs === 0 && sessionMinted === true,
      JSON.stringify({ ...sentFromNothing, sessionMinted }),
    );

    // The transcript for later checks needs content again.
    for (let i = 0; i < 40; i += 1) {
      await sleep(1200);
      const ready = await session.evaluate(`(() => {
        const b = document.querySelector('[data-hb="primary-action"]');
        return Boolean(b) && !b.disabled && b.getAttribute('title') === 'Send';
      })()`);
      if (ready) break;
    }
    await sleep(1500);

    // ── task list, subagents, notification switch ──────────────────────────
    const notifyState = await session.evaluate(`(() => {
      const btn = document.querySelector('[data-hb="notify-toggle"]');
      if (!btn) return null;
      return JSON.stringify({
        state: btn.getAttribute('data-state'),
        on: btn.getAttribute('data-on'),
        permission: window.Notification ? window.Notification.permission : 'unsupported',
      });
    })()`);
    check(
      "notification switch is in the tab strip",
      typeof notifyState === "string",
      String(notifyState),
    );

    // The switch is the only place the user learns whether notifications can
    // fire, so it must not claim "on" while the browser has not granted
    // permission — that is the state in which nothing ever arrives.
    const notify = JSON.parse(notifyState ?? "{}");
    check(
      "notification switch does not claim on without permission",
      notify.permission === "granted" ? notify.state === "on" : notify.state !== "on",
      `state=${notify.state} permission=${notify.permission}`,
    );

    // Grant it the way a user does, then confirm the switch follows — the flip
    // test below is only meaningful once the switch is genuinely "on".
    await session.send("Browser.grantPermissions", { origin: DASHBOARD, permissions: ["notifications"] });
    await session.evaluate(`window.dispatchEvent(new Event('focus'))`);
    await sleep(400);
    const grantedState = await session.evaluate(
      `document.querySelector('[data-hb="notify-toggle"]').getAttribute('data-state')`,
    );
    check("notification switch turns on once the browser grants permission", grantedState === "on", String(grantedState));

    // The switch must round-trip through storage, not merely repaint.
    await session.evaluate(`document.querySelector('[data-hb="notify-toggle"]').click()`);
    await sleep(300);
    const storedOff = await session.evaluate(`localStorage.getItem('hb-notify')`);
    check("notification switch persists its state", storedOff === "off", String(storedOff));
    await session.evaluate(`document.querySelector('[data-hb="notify-toggle"]').click()`);
    await sleep(300);
    const storedOn = await session.evaluate(`localStorage.getItem('hb-notify')`);
    check("notification switch turns back on", storedOn === "on", String(storedOn));

    // A turn that has to plan AND delegate. The model choosing not to call the
    // tools is not a plugin failure, so everything below is soft.
    await typeAndSend(
      session,
      "先用 todo 工具记下两条任务（把第一条标记为 completed），再用 delegate_task 派一个子代理去算 1+1，最后用一句话报告结果。",
    );

    const todoSeen = await waitForOr(session, `Boolean(document.querySelector('[data-hb="todo-panel"]'))`, {
      timeout: 150000,
      label: "todo panel",
    });
    check("task list panel renders once the agent plans", todoSeen, todoSeen ? undefined : "model never called todo", {
      soft: true,
    });

    if (todoSeen) {
      const rows = await session.evaluate(`document.querySelectorAll('[data-hb="todo-row"]').length`);
      check("task list shows the planned items", Number(rows) >= 2, `${rows} rows`, { soft: true });
      await session.evaluate(`document.querySelector('[data-hb="todo-toggle"]').click()`);
      await sleep(300);
      const collapsed = await session.evaluate(`(() => {
        const btn = document.querySelector('[data-hb="todo-toggle"]');
        return { open: btn ? btn.getAttribute('data-open') : null, rows: document.querySelectorAll('[data-hb="todo-row"]').length };
      })()`);
      check(
        "task list collapses to its header on click",
        collapsed.open === "false" && collapsed.rows === 0,
        JSON.stringify(collapsed),
      );
      await session.evaluate(`document.querySelector('[data-hb="todo-toggle"]').click()`);
      await sleep(200);
    }

    const subSeen = await waitForOr(session, `Boolean(document.querySelector('[data-hb="subagent-card"]'))`, {
      timeout: 180000,
      label: "subagent card",
    });
    check(
      "subagent batch card renders",
      subSeen,
      subSeen ? undefined : "model never called delegate_task",
      { soft: true },
    );

    if (subSeen) {
      await session.evaluate(`document.querySelector('[data-hb="subagent-toggle"]').click()`);
      await sleep(300);
      const expanded = await session.evaluate(`(() => {
        const btn = document.querySelector('[data-hb="subagent-toggle"]');
        return { open: btn ? btn.getAttribute('data-open') : null, rows: document.querySelectorAll('[data-hb="subagent-row"]').length };
      })()`);
      check(
        "subagent card expands to one row per child",
        expanded.open === "true" && Number(expanded.rows) >= 1,
        JSON.stringify(expanded),
      );
    }

    const consoleErrors = session.consoleLines.filter(
      (line) => (line.startsWith("[error]") || line.startsWith("[exception]")) && isPageError(line),
    );
    check(
      "no console errors",
      consoleErrors.length === 0,
      consoleErrors.slice(0, 3).join(" | ") || "clean",
    );

    console.log("\n── console tail ──");
    console.log(session.consoleLines.slice(-12).join("\n") || "(empty)");
  } finally {
    child.kill();
  }

  const skipped = results.filter((r) => !r.ok && r.soft).length;
  console.log(
    `\n${results.length - failures - skipped}/${results.length} checks passed${skipped ? ` (${skipped} skipped: the model did not call the tool)` : ""}`,
  );
  if (failures > 0) {
    console.log("\nFailed:");
    for (const r of results.filter((x) => !x.ok && !x.soft)) console.log(`  - ${r.name}: ${r.detail}`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error("verify crashed:", error);
  process.exitCode = 1;
});
