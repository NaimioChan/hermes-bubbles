/** Probe the transcript DOM after a full turn completes. */

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const projectRoot = dirname(root);
const shots = join(projectRoot, ".cache", "shots");
mkdirSync(shots, { recursive: true });

const DASHBOARD = "http://127.0.0.1:9119";
const PORT = 9227;
const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const USER_DATA = join(process.env.LOCALAPPDATA ?? ".", "Temp", "edge-cdp-probe2");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const child = spawn(EDGE, [
  "--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${USER_DATA}`,
  "--no-first-run", "--no-default-browser-check", "about:blank",
], { stdio: "ignore" });

try {
  for (let i = 0; i < 40; i++) {
    try { await fetch(`http://127.0.0.1:${PORT}/json/version`); break; } catch { await sleep(300); }
  }
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = list.find((t) => t.type === "page" && !t.url.startsWith("edge://"));
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

  let id = 0;
  const pending = new Map();
  const logs = [];
  ws.onmessage = (e) => {
    const f = JSON.parse(e.data);
    if (f.id !== undefined) { const c = pending.get(f.id); if (c) { pending.delete(f.id); c(f); } return; }
    if (f.method === "Runtime.consoleAPICalled") logs.push(`[${f.params.type}] ${f.params.args.map(a => a.value ?? a.description ?? a.type).join(" ")}`);
    if (f.method === "Runtime.exceptionThrown") logs.push(`[exception] ${f.params.exceptionDetails.exception?.description ?? f.params.exceptionDetails.text}`);
  };
  const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (expr, awaitPromise = false) => (await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise })).result?.result?.value;

  await send("Page.enable"); await send("Runtime.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await send("Page.bringToFront");
  await send("Page.navigate", { url: `${DASHBOARD}/chat` });
  await sleep(3000);

  // Send a message that forces a tool call, so a tool card appears.
  await ev(`(() => {
    const ta = document.querySelector('textarea');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, '用 terminal 跑 echo hi，然后一句话总结');
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    return 'sent';
  })()`);

  // Poll until the composer leaves the running state (Stop → Send).
  const deadline = Date.now() + 180000;
  let done = false;
  while (Date.now() < deadline && !done) {
    await sleep(3000);
    done = await ev(`(() => {
      const btns = [...document.querySelectorAll('button')];
      return btns.some(b => b.textContent.trim() === '发送');
    })()`);
  }
  console.log("turn finished:", done);

  console.log("\n=== transcript items ===");
  console.log(await ev(`(() => {
    const rows = [...document.querySelectorAll('div')].filter(d => {
      const s = d.getAttribute('style') ?? '';
      return s.includes('border-radius') && (s.includes('background') || s.includes('box-shadow'));
    });
    return JSON.stringify(rows.map(r => ({
      text: r.innerText.slice(0, 200),
      radius: (r.getAttribute('style') ?? '').match(/border-radius:[^;]+/)?.[0],
      width: Math.round(r.getBoundingClientRect().width),
    })), null, 1);
  })()`));

  console.log("\n=== console ===");
  console.log(logs.slice(-10).join("\n") || "(clean)");

  const shot = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(shots, "02-tool-turn.png"), Buffer.from(shot.result.data, "base64"));
  console.log("\nscreenshot: .cache/shots/02-tool-turn.png");

  console.log("\n=== composer geometry ===");
  console.log(await ev(`(() => {
    const ta = document.querySelector('textarea');
    const r = ta.getBoundingClientRect();
    const btn = [...document.querySelectorAll('button')].find(b => ['发送','停止'].includes(b.textContent.trim()));
    const br = btn ? btn.getBoundingClientRect() : null;
    return JSON.stringify({
      textarea: { left: Math.round(r.left), right: Math.round(r.right), width: Math.round(r.width) },
      button: br ? { left: Math.round(br.left), right: Math.round(br.right) } : null,
      overlap: br ? Math.round(r.right - br.left) : null,
      placeholder: ta.placeholder,
    });
  })()`));
} finally {
  child.kill();
}
