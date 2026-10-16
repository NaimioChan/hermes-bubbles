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

function check(name, ok, detail) {
  results.push({ name, ok, detail });
  if (!ok) failures += 1;
  const mark = ok ? "PASS" : "FAIL";
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
      const tabs = [...document.querySelectorAll('button')].filter(b => b.title === '关闭' || b.title === '新对话');
      const tabTop = tabs.length ? Math.min(...tabs.map(b => b.getBoundingClientRect().top)) : -1;
      const hist = [...document.querySelectorAll('button')].find(b => (b.title || '').includes('历史会话'));
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
      const b = [...document.querySelectorAll('button')].find(x => (x.title || '').includes('历史会话'));
      b?.click();
      return 'clicked';
    })()`);
    await sleep(1200);
    const panel = await session.evaluate(`(() => {
      const ps = [...document.querySelectorAll('span')].filter(s => (s.textContent || '').trim() === '历史会话');
      const p = ps.map(s => s.getBoundingClientRect()).sort((a, b) => b.width - a.width)[0];
      return p ? { left: Math.round(p.left), right: Math.round(p.right), windowW: window.innerWidth }
               : { left: -1, right: -1, windowW: window.innerWidth };
    })()`);
    check(
      "history panel opens on the right half",
      panel.left > panel.windowW * 0.5,
      JSON.stringify(panel),
    );

    const tabCount = () => session.evaluate(`(() => {
      // The close control is a span (a button inside a button is invalid HTML),
      // so count by title across all elements rather than only <button>.
      return document.querySelectorAll('[title="关闭"]').length;
    })()`);
    const tabsBefore = await tabCount();
    await session.evaluate(`(() => {
      const b = [...document.querySelectorAll('button')].find(x => x.title === '新对话');
      b?.click();
      return 'clicked';
    })()`);
    await sleep(3000);
    const tabsAfter = await tabCount();
    check("new-session button opens another tab", tabsAfter > tabsBefore, `${tabsBefore} -> ${tabsAfter}`);

    // ── item 3: @ path completions ─────────────────────────────────────────
    await session.evaluate(`(() => {
      const ta = document.querySelector('textarea');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      setter.call(ta, '@');
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      return 'typed';
    })()`);
    let atRows = 0;
    for (let i = 0; i < 12; i += 1) {
      await sleep(400);
      atRows = await session.evaluate(`(() => {
        const ta = document.querySelector('textarea');
        const under = [...document.querySelectorAll('button')].filter(b => {
          const r = b.getBoundingClientRect();
          return ta && r.bottom <= ta.getBoundingClientRect().top && (b.textContent || '').trim().length > 0;
        });
        return under.length;
      })()`);
      if (atRows > 0) break;
    }
    check("typing @ opens the path-reference menu", atRows > 0, `${atRows} rows`);

    // ── v0.2: attachments ──────────────────────────────────────────────────
    const attachUi = await session.evaluate(`(() => ({
      plus: [...document.querySelectorAll('button')].some(b => b.textContent.trim() === '+'),
      fileInput: Boolean(document.querySelector('input[type=file]')),
    }))()`);
    check("composer has a + button backed by a file input", attachUi.plus && attachUi.fileInput, JSON.stringify(attachUi));

    // ── v0.2: model / reasoning pickers ────────────────────────────────────
    await session.evaluate(`(() => {
      const b = [...document.querySelectorAll('button')].find(x => (x.title || '').startsWith('模型：'));
      b?.click();
      return 'clicked';
    })()`);
    await sleep(2500);
    const picker = await session.evaluate(`(() => {
      const text = document.body.innerText;
      const panel = document.querySelector('.hb-max-h-70vh');
      const rows = panel ? panel.querySelectorAll('button').length : 0;
      return {
        open: text.includes('模型与思考强度'),
        hasReasoning: text.includes('思考强度'),
        // Provider headers plus model rows; a bare modal would be ~2 buttons.
        modelRows: rows,
        hasProvider: /Mixture of Agents|Qwen|DeepSeek|OpenAI|Anthropic|custom/i.test(text),
      };
    })()`);
    check("model picker opens and lists providers/models", picker.open && picker.modelRows > 4 && picker.hasProvider, JSON.stringify(picker));
    check("model picker exposes reasoning levels", picker.hasReasoning === true);

    await session.evaluate(`(() => {
      document.querySelector('div[class*="fixed"]')?.click();
      return 'closed';
    })()`);
    await sleep(400);

    // ── markdown rendering ─────────────────────────────────────────────────
    // The reply must become real elements, not literal asterisks and pipes. A
    // literal `**` on screen is the exact symptom of markdown not applying.
    const mdPrompt = "原样输出这段 markdown，不要解释，不要用代码围栏包裹整段：\n# 标题\n\n**粗体**和`代码`\n\n- 甲\n- 乙\n\n```py\nprint(1)\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |";
    await session.evaluate(`(() => {
      const ta = document.querySelector('textarea');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      setter.call(ta, ${JSON.stringify(mdPrompt)});
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      return 'sent';
    })()`);

    let md = null;
    const mdDeadline = Date.now() + 120000;
    while (Date.now() < mdDeadline && !md) {
      await sleep(2500);
      md = await session.evaluate(`(() => {
        const all = [...document.querySelectorAll('.hb-md')];
        const el = all[all.length - 1];
        if (!el) return null;
        const q = (s) => el.querySelectorAll(s).length;
        // Wait for the fenced block and table, or we measure a half-streamed
        // reply and under-report the block types.
        if (q('.hb-md-codeblock') === 0 || q('table') === 0) return null;
        const text = el.innerText;
        return {
          h1: q('h1'), strong: q('strong'), inlineCode: q('code'),
          listItems: q('li'), codeBlocks: q('.hb-md-codeblock'),
          tables: q('table'), td: q('td'),
          hasLiteralBold: text.includes('**'),
          hasLiteralPipeRow: text.includes('|---'),
          hasLiteralFence: text.includes(String.fromCharCode(96).repeat(3)),
        };
      })()`);
    }

    check(
      "markdown renders real elements (heading / bold / code / list / table)",
      md !== null && md.h1 >= 1 && md.strong >= 1 && md.inlineCode >= 1 &&
        md.listItems >= 2 && md.codeBlocks >= 1 && md.tables >= 1 && md.td >= 2,
      md ? JSON.stringify(md) : "never saw a fully-markdowned reply",
    );
    check(
      "markdown markers are consumed, not shown literally",
      md !== null && !md.hasLiteralBold && !md.hasLiteralPipeRow && !md.hasLiteralFence,
      md ? JSON.stringify({ bold: md.hasLiteralBold, pipe: md.hasLiteralPipeRow, fence: md.hasLiteralFence }) : "n/a",
    );

    // Block surfaces must actually paint: a bare `var(--color-background)` is not
    // defined by this host and resolved to transparent.
    const mdStyle = await session.evaluate(`(() => {
      const all = [...document.querySelectorAll('.hb-md')];
      const el = all[all.length - 1];
      if (!el) return null;
      const pre = el.querySelector('.hb-md-pre');
      const code = el.querySelector('code');
      const th = el.querySelector('th');
      const first = el.firstElementChild;
      return {
        preBg: pre ? getComputedStyle(pre).backgroundColor : null,
        codeFont: code ? getComputedStyle(code).fontFamily : null,
        thBorder: th ? getComputedStyle(th).borderBottomWidth : null,
        firstMarginTop: first ? getComputedStyle(first).marginTop : null,
      };
    })()`);
    const transparent = (v) => !v || v === "rgba(0, 0, 0, 0)" || v === "transparent";
    check(
      "code block has a visible surface (not transparent)",
      mdStyle !== null && !transparent(mdStyle.preBg),
      JSON.stringify(mdStyle),
    );
    check(
      "inline code is monospace and the table is bordered",
      mdStyle !== null && /mono|Courier|Consolas|Menlo/i.test(mdStyle.codeFont ?? "") && mdStyle.thBorder === "1px",
      JSON.stringify(mdStyle),
    );
    check(
      "the bubble has no leading gap from block margins",
      mdStyle !== null && mdStyle.firstMarginTop === "0px",
      `first child margin-top=${mdStyle?.firstMarginTop}`,
    );

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

    // ── item 7: mid-turn input ─────────────────────────────────────────────
    // Fire a deliberately slow turn, then inspect the composer WHILE it runs.
    // Checking at idle proves nothing: the requirement is that a running turn
    // still accepts text, so the model can be corrected mid-flight.
    await session.evaluate(`(() => {
      const ta = document.querySelector('textarea');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      setter.call(ta, '用 terminal 运行 sleep 12，完成后只回复两个字：完成');
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      return 'sent';
    })()`);

    let running = null;
    const runDeadline = Date.now() + 30000;
    while (Date.now() < runDeadline && !running) {
      await sleep(600);
      running = await session.evaluate(`(() => {
        const ta = document.querySelector('textarea');
        if (!ta) return null;
        const btns = [...document.querySelectorAll('button')];
        const insert = btns.find(b => b.textContent.trim() === '插入');
        const stop = btns.find(b => b.textContent.trim() === '停止');
        if (!insert && !stop) return null;
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
      "the running state offers both 插入 and 停止",
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
        const btn = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === '插入');
        return { value: ta.value, sendEnabled: btn ? !btn.disabled : false };
      })()`);
      check(
        "a mid-turn message can actually be submitted",
        typedMidTurn.value.includes("顺便") && typedMidTurn.sendEnabled === true,
        JSON.stringify(typedMidTurn),
      );
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
      const reasoning = [...scroller.querySelectorAll('button')].find(b => (b.textContent || '').includes('思考'));
      const reasoningBlock = reasoning ? reasoning.parentElement : null;
      return {
        usageSize: usage ? parseFloat(getComputedStyle(usage).fontSize) : null,
        reasoningSize: reasoning ? parseFloat(getComputedStyle(reasoning).fontSize) : null,
        reasoningMarginTop: reasoningBlock ? parseFloat(getComputedStyle(reasoningBlock).marginTop) : null,
      };
    })()`);
    check(
      "usage line is no larger than the reasoning text",
      typeof type.usageSize === "number" && typeof type.reasoningSize === "number" && type.usageSize <= type.reasoningSize + 0.01,
      JSON.stringify(type),
    );
    check(
      "reasoning block has real spacing above it",
      typeof type.reasoningMarginTop === "number" && type.reasoningMarginTop >= 6,
      `margin-top=${type.reasoningMarginTop}px`,
    );

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

  console.log(`\n${results.length - failures}/${results.length} checks passed`);
  if (failures > 0) {
    console.log("\nFailed:");
    for (const r of results.filter((x) => !x.ok)) console.log(`  - ${r.name}: ${r.detail}`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error("verify crashed:", error);
  process.exitCode = 1;
});
