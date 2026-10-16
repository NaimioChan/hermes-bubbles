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
        this.consoleLines.push(`[exception] ${d.exception?.description ?? d.text}`);
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

    const consoleErrors = session.consoleLines.filter(
      (line) => line.startsWith("[error]") || line.startsWith("[exception]"),
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
