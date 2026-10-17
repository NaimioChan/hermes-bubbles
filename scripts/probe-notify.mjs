/**
 * Desktop-notification probe against the LIVE dashboard.
 *
 * Headless can verify everything except the OS toast itself: whether the
 * permission gate is honoured, whether the switch reports the state honestly,
 * and whether the plugin constructs a Notification with the expected
 * title/body/tag/flags when a turn finishes out of sight. A stub stands in for
 * `window.Notification` so the assertions can read what would have been shown.
 *
 * Run with the dashboard up:  node scripts/probe-notify.mjs
 */

import { spawn } from "node:child_process";
import { join } from "node:path";

const DASHBOARD = process.env.HERMES_DASHBOARD_URL ?? "http://127.0.0.1:9119";
const PORT = Number(process.env.CDP_PORT ?? 9226);
const EDGE = process.env.EDGE_PATH ?? "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const USER_DATA = join(process.env.LOCALAPPDATA ?? process.env.TEMP ?? ".", "Temp", "edge-cdp-notify-probe");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
let failures = 0;
function check(name, ok, detail) {
  results.push({ name, ok });
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail === undefined ? "" : `  — ${detail}`}`);
}

class Session {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 0;
    this.pending = new Map();
    ws.addEventListener("message", (event) => {
      const frame = JSON.parse(event.data);
      if (frame.id !== undefined) {
        const call = this.pending.get(frame.id);
        if (call) {
          this.pending.delete(frame.id);
          clearTimeout(call.timer);
          frame.error ? call.reject(new Error(JSON.stringify(frame.error))) : call.resolve(frame.result);
        }
      }
      if (frame.method === "Runtime.exceptionThrown") {
        const d = frame.params.exceptionDetails;
        console.log("  [exception]", d.exception?.description ?? d.text);
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
    const result = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    }
    return result.result?.value;
  }
}

async function connect() {
  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page =
    targets.find((t) => t.type === "page" && t.url.includes("127.0.0.1")) ??
    targets.find((t) => t.type === "page" && !t.url.startsWith("edge://") && !t.url.startsWith("chrome://"));
  if (!page) throw new Error("no usable page target");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });
  const session = new Session(ws);
  await session.send("Page.enable");
  await session.send("Runtime.enable");
  await session.send("Page.bringToFront");
  return session;
}

async function waitFor(session, expression, { timeout = 20000, label = expression } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      if (await session.evaluate(expression)) return true;
    } catch {
      /* mid-navigation */
    }
    await sleep(300);
  }
  throw new Error(`timed out waiting for ${label}`);
}

const toggle = `(() => {
  const btn = document.querySelector('[data-hb="notify-toggle"]');
  return btn ? btn.getAttribute('data-state') : null;
})()`;

async function main() {
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
    { stdio: "ignore" },
  );

  try {
    const deadline = Date.now() + 20000;
    let up = false;
    while (Date.now() < deadline && !up) {
      try {
        await fetch(`http://127.0.0.1:${PORT}/json/version`);
        up = true;
      } catch {
        await sleep(300);
      }
    }
    if (!up) throw new Error("headless Edge never came up");

    const s = await connect();
    await s.send("Page.navigate", { url: `${DASHBOARD}/chat` });
    await sleep(2500);
    // A reused profile remembers an earlier run's preference; start from the
    // default a new user gets.
    await s.evaluate(`localStorage.removeItem('hb-notify')`);
    await s.send("Page.reload", { ignoreCache: true });
    await sleep(2000);
    await waitFor(s, `Boolean(document.querySelector('textarea') && !document.querySelector('textarea').disabled)`, {
      label: "composer ready",
    });
    await waitFor(s, `Boolean(document.querySelector('[data-hb="notify-toggle"]'))`, { label: "notify switch" });

    // ① a fresh browser has not granted permission, so the switch must not say on
    const initial = await s.evaluate(`JSON.stringify({
      permission: window.Notification ? window.Notification.permission : 'none',
      state: document.querySelector('[data-hb="notify-toggle"]').getAttribute('data-state'),
      on: document.querySelector('[data-hb="notify-toggle"]').getAttribute('data-on'),
      title: document.querySelector('[data-hb="notify-toggle"]').title,
    })`);
    const first = JSON.parse(initial);
    check(
      "switch does not claim on before permission is granted",
      first.permission === "granted" ? first.state === "on" : first.state !== "on",
      initial,
    );

    // ② granting permission (what the browser prompt does) must flip it to on
    await s.send("Browser.grantPermissions", { origin: DASHBOARD, permissions: ["notifications"] });
    await s.evaluate(`window.dispatchEvent(new Event('focus'))`);
    await sleep(400);
    const afterGrant = await s.evaluate(toggle);
    check("switch turns on once permission is granted", afterGrant === "on", String(afterGrant));

    // ③ capture what the plugin would show
    await s.evaluate(`(() => {
      window.__hbNotifs = [];
      class FakeNotification {
        static permission = 'granted';
        static requestPermission() { return Promise.resolve('granted'); }
        constructor(title, opts) {
          window.__hbNotifs.push({
            title,
            body: opts && opts.body,
            tag: opts && opts.tag,
            sticky: Boolean(opts && opts.requireInteraction),
          });
        }
        close() {}
      }
      window.Notification = FakeNotification;
      try { Object.defineProperty(document, 'hasFocus', { value: () => false, configurable: true }); } catch (e) {}
      return true;
    })()`);

    // ④ toggling off then on must end in a real toast as proof of the path
    await s.evaluate(`document.querySelector('[data-hb="notify-toggle"]').click()`);
    await sleep(400);
    const offState = await s.evaluate(toggle);
    const storedOff = await s.evaluate(`localStorage.getItem('hb-notify')`);
    check("switch turns off and persists", offState === "off" && storedOff === "off", `${offState}/${storedOff}`);

    await s.evaluate(`document.querySelector('[data-hb="notify-toggle"]').click()`);
    await sleep(600);
    const onState = await s.evaluate(toggle);
    const testToast = await s.evaluate(
      `JSON.stringify((window.__hbNotifs || []).filter((n) => n.tag === 'hb-test'))`,
    );
    check("switch turns back on", onState === "on", String(onState));
    check("enabling fires a confirmation toast", JSON.parse(testToast).length === 1, testToast);

    // ⑤ a turn that finishes while the window is out of sight notifies
    await s.evaluate(`window.__hbNotifs.length = 0`);
    await sendText(s, "只回复两个字：收到");

    const capDeadline = Date.now() + 120000;
    let turnToast = [];
    while (Date.now() < capDeadline) {
      turnToast = JSON.parse(await s.evaluate(`JSON.stringify(window.__hbNotifs || [])`));
      if (turnToast.some((n) => n.tag.startsWith("hb-turn-"))) break;
      await sleep(1000);
    }
    const finished = turnToast.find((n) => n.tag.startsWith("hb-turn-"));
    check("a finished turn raises a notification", Boolean(finished), JSON.stringify(turnToast));
    check(
      "the notification quotes the reply and is not sticky",
      Boolean(finished) && finished.body.length > 0 && finished.sticky === false,
      finished ? JSON.stringify(finished) : "no toast",
    );

    // ⑥ and stays quiet while the window is in front
    await s.evaluate(`(() => {
      Object.defineProperty(document, 'hasFocus', { value: () => true, configurable: true });
      window.__hbNotifs.length = 0;
      return true;
    })()`);
    await sendText(s, "只回复两个字：在的");
    await sleep(15000);
    const quiet = await s.evaluate(`JSON.stringify(window.__hbNotifs || [])`);
    check("no notification while the window is in front", JSON.parse(quiet).length === 0, quiet);
  } finally {
    child.kill();
  }

  console.log(`\n${results.length - failures}/${results.length} checks passed`);
  if (failures) process.exitCode = 1;
}

async function sendText(session, text) {
  await session.evaluate(`(() => {
    const ta = document.querySelector('textarea');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, ${JSON.stringify(text)});
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await sleep(200);
  await session.evaluate(
    `document.querySelector('textarea').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`,
  );
}

main().catch((e) => {
  console.error("probe crashed:", e);
  process.exitCode = 1;
});
