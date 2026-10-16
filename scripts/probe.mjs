/** Quick probe: what does /chat actually render, and what does the console say? */

import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const projectRoot = dirname(root);
const DASHBOARD = process.env.HERMES_DASHBOARD_URL ?? "http://127.0.0.1:9119";
const PORT = Number(process.env.CDP_PORT ?? 9226);
const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const USER_DATA = join(process.env.LOCALAPPDATA ?? ".", "Temp", "edge-cdp-probe-bubbles");

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
    if (f.method === "Log.entryAdded") logs.push(`[log:${f.params.entry.level}] ${f.params.entry.text}`);
  };
  const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (expr) => (await send("Runtime.evaluate", { expression: expr, returnByValue: true })).result?.result?.value;

  await send("Page.enable"); await send("Runtime.enable"); await send("Log.enable");
  await send("Page.navigate", { url: `${DASHBOARD}/chat` });
  await sleep(4000);

  console.log("=== console ===");
  console.log(logs.join("\n") || "(empty)");

  console.log("\n=== plugin state ===");
  console.log(await ev(`JSON.stringify({
    sdk: Boolean(window.__HERMES_PLUGIN_SDK__),
    registry: Boolean(window.__HERMES_PLUGINS__),
    registered: window.__HERMES_PLUGINS__ ? Object.keys(window.__HERMES_PLUGINS__) : null,
    path: location.pathname,
    xterm: Boolean(document.querySelector('.xterm')),
    textareas: document.querySelectorAll('textarea').length,
  })`));

  console.log("\n=== body text (first 600) ===");
  console.log(await ev("document.body.innerText.slice(0, 600)"));

  console.log("\n=== main html (first 1500) ===");
  console.log(await ev("(document.querySelector('main')?.innerHTML ?? document.body.innerHTML).slice(0, 1500)"));

  console.log("\n=== plugin scripts ===");
  console.log(await ev(`JSON.stringify([...document.querySelectorAll('script[src]')].map(s => s.src))`));
} finally {
  child.kill();
}
