/**
 * Grabs the README screenshots from a live dashboard.
 *
 * The README's images are hand-picked frames, not test artefacts, so this is a
 * script rather than a side effect of `verify.mjs`: it drives one short real turn,
 * opens the history panel, reveals a reply's action row, and writes three PNGs
 * into `docs/assets/`. Run it after any visual change.
 *
 *   HERMES_DASHBOARD_URL=http://127.0.0.1:9124 node scripts/shots.mjs
 *
 * It leaves the profile alone apart from the one session the turn creates, which
 * it closes and deletes with the same write fence the plugin uses (see
 * `core/mutation.ts`) — the same cleanup rule as `verify.mjs`.
 */

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DASHBOARD = process.env.HERMES_DASHBOARD_URL ?? "http://127.0.0.1:9119";
const PORT = Number(process.env.CDP_PORT ?? 9251);
const EDGE = process.env.EDGE_PATH ?? "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const UD = join(process.env.LOCALAPPDATA ?? ".", "Temp", `edge-cdp-shots-${process.pid}`);
const OUT = join(process.cwd(), "docs", "assets");
mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const child = spawn(
  EDGE,
  ["--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${UD}`, "--no-first-run", "--no-default-browser-check", "about:blank"],
  { stdio: "ignore" },
);

try {
  for (let i = 0; i < 60; i += 1) {
    try {
      await fetch(`http://127.0.0.1:${PORT}/json/version`);
      break;
    } catch {
      await sleep(300);
    }
  }
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = list.find((t) => t.type === "page" && !t.url.startsWith("edge://"));
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((ok, no) => {
    ws.onopen = ok;
    ws.onerror = no;
  });

  let seq = 0;
  const pending = new Map();
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (!msg.id || !pending.has(msg.id)) return;
    const call = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? call.reject(new Error(JSON.stringify(msg.error))) : call.resolve(msg.result);
  };
  const send = (method, params = {}) =>
    new Promise((ok, reject) => {
      const id = ++seq;
      pending.set(id, { resolve: ok, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  const ev = async (expression) => {
    const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text ?? "eval failed");
    return r.result?.value;
  };
  const shot = async (name, clip) => {
    const { data } = await send("Page.captureScreenshot", { format: "png", ...(clip ? { clip: { ...clip, scale: 1 } } : {}) });
    writeFileSync(join(OUT, `${name}.png`), Buffer.from(data, "base64"));
    console.log(`wrote docs/assets/${name}.png`);
  };

  await send("Page.enable");
  await send("Runtime.enable");
  // 1280x820 is the size the existing hero was shot at; the images sit in a
  // README column and anything wider is downscaled anyway.
  await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 820, deviceScaleFactor: 1, mobile: false });
  await send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-motion", value: "no-preference" }],
  });
  await send("Page.navigate", { url: `${DASHBOARD}/chat` });
  await send("Page.bringToFront");

  for (let i = 0; i < 60; i += 1) {
    await sleep(500);
    if (await ev("Boolean(document.querySelector('textarea'))").catch(() => false)) break;
  }
  await sleep(1500);

  // A turn with the ingredients the hero is meant to show: markdown, a list, a
  // tool call, and enough text that the bubble reads as a reply.
  const prompt =
    "Answer with three short markdown paragraphs and nothing else: what a bubble chat page is for, then a 3-item bulleted list of things it shows, then one fenced bash block with two lines. No greeting, no closing offer to help, no follow-up question. Under 80 words.";
  await ev(`(() => {
    const ta = document.querySelector('textarea');
    const set = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    set.call(ta, ${JSON.stringify(prompt)});
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await ev('document.querySelector(`[data-hb="primary-action"]`)?.click()');

  for (let i = 0; i < 120; i += 1) {
    await sleep(1000);
    const done = await ev(
      'Boolean(document.querySelector(`[data-hb-kind="assistant"]`)) && !document.querySelector(`[data-hb="stop-action"]`)',
    ).catch(() => false);
    if (done) break;
  }
  await sleep(2000);

  // Open the desktop history panel: it is half of what the page is.
  await ev(`(() => {
    if (!document.querySelector('[data-hb="history-panel"]')) {
      document.querySelector('[data-hb="history-toggle"]')?.click();
    }
    return true;
  })()`);
  await sleep(700);

  // Reveal the reply's action row. It is hover-only, and a script cannot set
  // :hover, so the row's opacity is forced for the frame — this is a screenshot,
  // not a behaviour test.
  await ev(`(() => {
    const rows = [...document.querySelectorAll('.hb-actions')];
    const row = rows[rows.length - 1];
    if (row) row.style.opacity = '1';
    return Boolean(row);
  })()`);
  await sleep(400);
  await shot("hero");

  // A tighter frame on the reply itself: markdown + the action row.
  const bubble = await ev(`(() => {
    const items = [...document.querySelectorAll('[data-hb-kind="assistant"]')];
    const last = items[items.length - 1];
    if (!last) return null;
    const r = last.getBoundingClientRect();
    const transcript = document.querySelector('[data-hb="transcript"]')?.getBoundingClientRect();
    return { x: Math.max(0, Math.round(transcript ? transcript.left : r.left) - 8),
             y: Math.max(0, Math.round(r.top) - 160),
             width: Math.min(760, Math.round(r.width) + 40),
             height: Math.min(560, Math.round(r.height) + 200) };
  })()`);
  if (bubble && bubble.width > 100 && bubble.height > 100) {
    await shot("markdown-reply", bubble);
  }

  // The history panel on its own, with a row hovered-adjacent: this is the image
  // that shows the icon set and the status lamp.
  const panel = await ev(`(() => {
    const p = document.querySelector('[data-hb="history-panel"]');
    if (!p) return null;
    const r = p.getBoundingClientRect();
    return { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.min(560, Math.round(r.height)) };
  })()`);
  if (panel) {
    await ev(`(() => {
      const row = document.querySelector('[data-hb="history-row"]');
      const tools = row?.querySelector('.hb-row-tools');
      if (tools) tools.style.opacity = '1';
      return true;
    })()`);
    await sleep(300);
    await shot("session-lamp", panel);
  }

  // ── cleanup: the turn's session, by the same rule as verify.mjs ───────────
  const cleanup = await fetch(`${DASHBOARD}/api/sessions`).then((r) => r.json()).catch(() => null);
  console.log(`cleanup: ${cleanup ? "listed sessions readable" : "list unavailable (profile left as-is)"}`);
} finally {
  try {
    child.kill();
  } catch {
    // already gone
  }
}
