/** Measure the actual contrast of the bubbles in the live page. */

import { spawn } from "node:child_process";
import { join } from "node:path";

const PORT = 9228;
const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const USER_DATA = join(process.env.LOCALAPPDATA ?? ".", "Temp", "edge-cdp-contrast");
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
  let id = 0; const pending = new Map();
  ws.onmessage = (e) => { const f = JSON.parse(e.data); if (f.id !== undefined) { const c = pending.get(f.id); if (c) { pending.delete(f.id); c(f); } } };
  const send = (m, p = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
  const ev = async (expr, awaitPromise = false) => (await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise })).result?.result?.value;

  await send("Page.enable"); await send("Runtime.enable");
  await send("Page.navigate", { url: "http://127.0.0.1:9119/chat" });
  await sleep(3000);

  await ev(`(() => {
    const ta = document.querySelector('textarea');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, '说三个字：收到了');
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    return 'sent';
  })()`);

  for (let i = 0; i < 60; i++) {
    await sleep(2000);
    if (await ev(`[...document.querySelectorAll('button')].some(b => b.textContent.trim() === '发送')`)) break;
  }

  console.log(await ev(`(() => {
    const root = getComputedStyle(document.documentElement);
    const vars = {};
    for (const name of ['--color-card','--color-card-foreground','--color-muted','--color-muted-foreground',
                        '--color-primary','--color-primary-foreground','--color-background','--color-foreground',
                        '--color-destructive','--radius','--font-sans','--font-mono','--midground']) {
      vars[name] = root.getPropertyValue(name).trim();
    }

    // Sample the real painted pixels of each bubble via a canvas draw of the page
    // is not possible; instead read computed color/background pairs.
    const blocks = [...document.querySelectorAll('div')].filter(d => {
      const s = d.getAttribute('style') ?? '';
      return s.includes('border-radius') && (s.includes('background') || s.includes('box-shadow'));
    }).map(d => {
      const cs = getComputedStyle(d);
      return {
        text: d.innerText.slice(0, 24).replace(/\\n/g, ' '),
        color: cs.color,
        background: cs.backgroundColor,
        border: cs.borderLeftColor,
        fontSize: cs.fontSize,
      };
    });
    return JSON.stringify({ vars, blocks }, null, 1);
  })()`));
} finally {
  child.kill();
}
