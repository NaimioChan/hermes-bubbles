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
import { mkdirSync, rmSync, writeFileSync } from "node:fs";

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
        // The free-text row must be the LAST child of the choice column, so it
        // reads as one more option rather than a form below the list.
        lastRowTag: (() => {
          const col = el.querySelector('.hb-choice-col');
          const last = col ? col.lastElementChild : null;
          return last ? last.tagName : null;
        })(),
        other: (() => {
          const input = el.querySelector('[data-hb="clarify-other"]');
          return input ? { placeholder: input.placeholder, tag: input.tagName } : null;
        })(),
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
    console.log(
      "\\n=== the free-text row: last in the list, and it can be answered ===",
    );
    // Typing a custom answer must un-pick a single-select choice and enable
    // Submit on its own — that is the whole point of the extra row.
    console.log(await ev(`(() => {
      const el = document.querySelector('[data-hb="request-card"]');
      const input = el.querySelector('[data-hb="clarify-other"]');
      if (!input) return "no free-text row";
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, 'verify: 我自己写的答案');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return 'typed';
    })()`));
    await sleep(600);
    console.log(await ev(`(() => {
      const el = document.querySelector('[data-hb="request-card"]');
      if (!el) return 'card gone';
      return JSON.stringify({
        value: el.querySelector('[data-hb="clarify-other"]')?.value ?? null,
        selected: [...el.querySelectorAll('[data-hb-choice]')].map(b => b.getAttribute('data-hb-selected')),
        submitDisabled: el.querySelector('[data-hb="clarify-submit"]')?.disabled ?? null,
      });
    })()`));

    // Pick a choice: the submit button must become enabled, and the typed text
    // must give way (single-select is mutually exclusive with free text).
    console.log("\\n=== choosing an option enables Submit and clears the typed answer ===");
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
  // Leave no trace: this script sends a real prompt to a real model, which mints
  // a real session. Same rule as verify.mjs — close the live one, then delete the
  // row (close first, or the row re-persists: AGENTS.md 铁律 19).
  try {
    const cleaned = await ev(`(async () => {
      const sdk = window.__HERMES_PLUGIN_SDK__;
      const url = await sdk.buildWsUrl('/api/ws');
      const ws = new WebSocket(url);
      const waiting = new Map(); let nextId = 1;
      const req = (method, params) => new Promise((resolve) => {
        const reqId = nextId++;
        waiting.set(reqId, resolve);
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: reqId, method, params }));
        setTimeout(() => resolve({}), 8000);
      });
      ws.onmessage = (e) => {
        const f = JSON.parse(e.data);
        if (f.id === undefined) return;
        const done = waiting.get(f.id);
        if (done) { waiting.delete(f.id); done(f); }
      };
      await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
      const listed = await req('session.list', { limit: 20 });
      const rows = (listed.result?.sessions ?? []).filter((row) =>
        ((row.preview || '') + (row.title || '')).includes('clarify'));
      const out = { matched: rows.length, deleted: 0 };
      for (const row of rows) {
        await req('session.close', { session_id: row.resolved_id ?? row.id });
        try {
          // 0.22.5 fences session mutations behind a receipt: a bare DELETE is
          // answered 409 client_upgrade_required and the row stays. Read the
          // snapshot AFTER the close (closing advances the revision) and send
          // all three fence fields.
          const snap = await sdk.fetchJSON(
            '/api/sessions/' + encodeURIComponent(row.id) + '/mutation-snapshot', { method: 'GET' });
          const fence = new URLSearchParams({
            request_id: 'hb-clean-' + Date.now() + '-' + Math.floor(Math.random() * 1e6),
            expected_revision: String(snap?.runtime_revision ?? 0),
          });
          if (typeof snap?.runtime_generation === 'number') {
            fence.set('expected_generation', String(snap.runtime_generation));
          }
          await sdk.fetchJSON(
            '/api/sessions/' + encodeURIComponent(row.id) + '?' + fence.toString(), { method: 'DELETE' });
          out.deleted += 1;
        } catch (error) { out.lastError = String(error && error.message).slice(0, 120); }
      }
      const after = await req('session.list', { limit: 20 });
      out.remaining = (after.result?.sessions ?? []).filter((row) =>
        ((row.preview || '') + (row.title || '')).includes('clarify')).length;
      ws.close();
      return JSON.stringify(out);
    })()`, true);
    console.log("cleanup:", cleaned);
  } catch (error) {
    console.log("cleanup skipped:", error && error.message);
  }
  child.kill();
  // The per-run browser profile is ~800 MB; leaving one behind is how the temp
  // dir grew to 107 copies / 18 GB. Removal can race Edge's own shutdown.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try { rmSync(UD, { recursive: true, force: true }); break; } catch { await sleep(1000); }
  }
}
