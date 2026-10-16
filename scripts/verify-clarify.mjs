/**
 * On-demand live check: the request cards (approval / clarify).
 *
 * These only appear when the MODEL decides to ask the user something, so this is
 * NOT part of `verify.mjs` — a check that depends on the model's choice would
 * fail randomly. The parsing and answer-shaping logic is unit-tested in
 * `tests/requests.test.ts`; this script proves the RENDERED card against a real
 * one, end to end, when a human wants to see it.
 *
 * Run: node scripts/verify-clarify.mjs   (needs the dashboard on 9119)
 */

import { spawn } from "node:child_process";
import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";

const PORT = 9254;
const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const UD = join(process.env.LOCALAPPDATA ?? ".", "Temp", "edge-cdp-clarify");
const OUT = join(process.cwd(), ".cache", "shots");
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const child = spawn(EDGE, [
  "--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${UD}`,
  "--no-first-run", "about:blank",
], { stdio: "ignore" });

try {
  for (let i = 0; i < 40; i++) { try { await fetch(`http://127.0.0.1:${PORT}/json/version`); break; } catch { await sleep(300); } }
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = list.find((t) => t.type === "page" && !t.url.startsWith("edge://"));
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0; const pending = new Map();
  ws.onmessage = (e) => { const f = JSON.parse(e.data); if (f.id !== undefined) { const c = pending.get(f.id); if (c) { pending.delete(f.id); c(f); } } };
  const send = (m, p = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
  const ev = async (expr, ap = false) => (await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: ap })).result?.result?.value;

  await send("Page.enable"); await send("Runtime.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 950, deviceScaleFactor: 1, mobile: false });
  await send("Page.navigate", { url: "http://127.0.0.1:9119/chat" });
  await sleep(8000);

  // Ask the model to use the clarify tool — the same "ask the user" mechanism the
  // desktop app uses, so it exercises the real server→client request path.
  const PROMPT = [
    "请使用 clarify 工具向我提一个问题，确认我接下来想做什么。",
    "选项给出「写代码」和「查资料」两个，让用户在两者中选择。",
    "不要自己回答，必须真的调用工具。",
  ].join("\n");

  await ev(`(() => {
    const ta = document.querySelector('textarea');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, ${JSON.stringify(PROMPT)});
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    return 'sent';
  })()`);

  let card = null;
  const deadline = Date.now() + 150000;
  while (Date.now() < deadline && !card) {
    await sleep(2500);
    card = await ev(`(() => {
      const el = document.querySelector('[data-hb="request-card"]');
      if (!el) return null;
      const groups = [...el.querySelectorAll('[data-hb-choice]')];
      return {
        text: (el.innerText || '').slice(0, 200),
        buttons: groups.map(b => ({ label: b.textContent.trim(), choice: b.getAttribute('data-hb-choice'), selected: b.getAttribute('data-hb-selected') })),
        hasSubmit: Boolean(el.querySelector('[data-hb="clarify-submit"]')),
        submitDisabled: el.querySelector('[data-hb="clarify-submit"]')?.disabled ?? null,
        inputs: el.querySelectorAll('[data-hb-input]').length,
      };
    })()`);
  }

  if (!card) {
    console.log("NO CLARIFY CARD APPEARED within 150s");
    console.log("transcript tail:", await ev(`(() => {
      const sc = [...document.querySelectorAll('div')].find(d => d.className.includes('hb-scroll'));
      return (sc?.innerText || '').slice(-400);
    })()`));
  } else {
    console.log("=== ITEM 4: clarify card rendered ===");
    console.log(JSON.stringify(card, null, 1));

    // Pick a choice: the submit button must become enabled.
    console.log("\\n=== choosing an option enables Submit ===");
    await ev(`(() => {
      const el = document.querySelector('[data-hb="request-card"]');
      const first = el.querySelector('[data-hb-choice]');
      first?.click();
      return 'clicked';
    })()`);
    await sleep(600);
    console.log(await ev(`(() => {
      const el = document.querySelector('[data-hb="request-card"]');
      if (!el) return 'card gone';
      const submit = el.querySelector('[data-hb="clarify-submit"]');
      return JSON.stringify({
        submitDisabled: submit?.disabled,
        selected: [...el.querySelectorAll('[data-hb-choice]')].map(b => b.getAttribute('data-hb-selected')),
      });
    })()`));

    const shot = await send("Page.captureScreenshot", { format: "png" });
    writeFileSync(join(OUT, "09-clarify-card.png"), Buffer.from(shot.result.data, "base64"));
    console.log("shot: 09-clarify-card.png");

    // Submit and confirm the card retires and the turn continues.
    console.log("\\n=== submitting retires the card and the turn resumes ===");
    await ev(`(() => {
      document.querySelector('[data-hb="clarify-submit"]')?.click();
      return 'submitted';
    })()`);
    await sleep(3000);
    console.log(await ev(`JSON.stringify({
      cardStillThere: Boolean(document.querySelector('[data-hb="request-card"]')),
      running: Boolean(document.querySelector('[data-hb="stop-action"]')),
    })`));
  }
} finally {
  child.kill();
}
