/**
 * On-demand live check: a request card belongs to ONE session, not to every tab.
 *
 * The bug this exists for: with several sessions open, an `approval` / `clarify`
 * asked by session A was drawn in whichever transcript was focused — so a
 * background session's question appeared in the conversation on screen, and
 * answering it there answered A's card. `core/cards.ts` now scopes each card to
 * the tab that owns its `session_id`, and the tab strip marks the session that is
 * waiting.
 *
 * Like `verify-clarify.mjs` this depends on the MODEL deciding to call the
 * clarify tool, so it is not part of `verify.mjs` — it is run by hand.
 *
 * Run: HERMES_DASHBOARD_URL=http://127.0.0.1:9121 node scripts/verify-cards.mjs
 */

import { spawn } from "node:child_process";
import { join } from "node:path";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";

const DASHBOARD = process.env.HERMES_DASHBOARD_URL ?? "http://127.0.0.1:9119";
const PORT = Number(process.env.CDP_PORT ?? 9227);
const EDGE = process.env.EDGE_PATH ?? "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const UD = join(process.env.LOCALAPPDATA ?? ".", "Temp", `edge-cdp-cards-${process.pid}`);
const OUT = join(process.cwd(), ".cache", "shots");
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail === undefined ? "" : `  — ${detail}`}`);
}

const child = spawn(
  EDGE,
  ["--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${UD}`, "--no-first-run", "about:blank"],
  { stdio: "ignore" },
);

let ev = () => undefined;
try {
  for (let i = 0; i < 60; i++) {
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
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = rej;
  });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (e) => {
    const f = JSON.parse(e.data);
    if (f.id === undefined) return;
    const done = pending.get(f.id);
    if (done) {
      pending.delete(f.id);
      done(f);
    }
  };
  const send = (m, p = {}) =>
    new Promise((res) => {
      const i = ++id;
      pending.set(i, res);
      ws.send(JSON.stringify({ id: i, method: m, params: p }));
    });
  ev = async (expr, awaitPromise = false) =>
    (await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise })).result?.result?.value;

  await send("Page.enable");
  await send("Runtime.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 950, deviceScaleFactor: 1, mobile: false });
  await send("Page.navigate", { url: `${DASHBOARD}/chat` });

  // The plugin has to take over the route before anything below means anything.
  let ready = false;
  for (let i = 0; i < 40; i++) {
    await sleep(1000);
    if (await ev(`Boolean(document.querySelector('[data-hb=transcript]'))`)) {
      ready = true;
      break;
    }
  }
  if (!ready) throw new Error("the bubble page never rendered");
  await sleep(2000);

  const tabState = () =>
    ev(`JSON.stringify([...document.querySelectorAll('[data-hb=tab]')].map(el => ({
      key: el.getAttribute('data-hb-key'),
      label: (el.innerText || '').replace(/\\s+/g, ' ').trim(),
      active: el.style.background !== 'transparent',
      waiting: Boolean(el.querySelector('[data-hb=tab-waiting]')),
      running: Boolean(el.querySelector('.hb-caret')),
    })))`);

  check("one tab after load", JSON.parse(await tabState()).length === 1, await tabState());

  // ── open a second session and keep it in the background ────────────────────
  await ev(`document.querySelector('[data-hb=tab-new]')?.click()`);
  await sleep(3500);
  const two = JSON.parse(await tabState());
  check("the + button opens a second tab", two.length === 2, await tabState());

  const keys = two.map((t) => t.key);
  const firstKey = keys[0];
  const secondKey = keys[1];

  // Focus the FIRST tab and ask for a question. The second tab stays open in the
  // background — that is the situation the bug needed.
  await ev(`document.querySelector('[data-hb=tab][data-hb-key="${firstKey}"]')?.click()`);
  await sleep(800);

  const PROMPT = [
    "请调用 clarify 工具向我提一个问题，确认我接下来想做什么。",
    "选项给出「写代码」和「查资料」两个，让用户在两者中选择。",
    "不要自己回答，必须真的调用工具。",
  ].join("\\n");

  await ev(`(() => {
    const ta = document.querySelector('textarea');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, ${JSON.stringify(PROMPT)});
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    return 'sent';
  })()`);

  // The card appears in the tab that asked. Wait for it there, then switch away.
  let appeared = false;
  for (let i = 0; i < 60; i++) {
    await sleep(2500);
    if (await ev(`Boolean(document.querySelector('[data-hb=request-card]'))`)) {
      appeared = true;
      break;
    }
  }
  if (!appeared) {
    console.log("NO CARD APPEARED — the model did not call clarify; the rest of this run is meaningless");
    console.log("transcript tail:", await ev(`(document.querySelector('[data-hb=transcript]')?.innerText || '').slice(-400)`));
  } else {
    check("the card renders in the session that asked", true);

    // Switch to the OTHER session while the request is still open.
    await ev(`document.querySelector('[data-hb=tab][data-hb-key="${secondKey}"]')?.click()`);
    await sleep(1200);

    const cardsHere = await ev(`document.querySelectorAll('[data-hb=request-card]').length`);
    check("the other session shows NO card", cardsHere === 0, `cards=${cardsHere}`);

    const leakedText = await ev(`(() => {
      const t = document.querySelector('[data-hb=transcript]')?.innerText || '';
      return t.includes('写代码') || t.includes('查资料') ? t.slice(0, 200) : '';
    })()`);
    check("the other session's transcript has no question in it", leakedText === "", leakedText);

    const tabsNow = JSON.parse(await tabState());
    const first = tabsNow.find((t) => t.key === firstKey);
    const second = tabsNow.find((t) => t.key === secondKey);
    check("the tab that asked carries the waiting marker", first?.waiting === true, JSON.stringify(first));
    check("the focused tab does not", second?.waiting === false, JSON.stringify(second));

    const shot = await send("Page.captureScreenshot", { format: "png" });
    writeFileSync(join(OUT, "10-cards-other-session.png"), Buffer.from(shot.result.data, "base64"));
    console.log("shot: 10-cards-other-session.png");

    // Going back to the asking tab must show the card again.
    await ev(`document.querySelector('[data-hb=tab][data-hb-key="${firstKey}"]')?.click()`);
    await sleep(1200);
    const back = await ev(`document.querySelectorAll('[data-hb=request-card]').length`);
    check("the card is back in its own session", back === 1, `cards=${back}`);

    // Answer it: the card retires and the waiting marker clears.
    await ev(`(() => {
      const el = document.querySelector('[data-hb=request-card]');
      el?.querySelector('[data-hb-choice]')?.click();
      return 'picked';
    })()`);
    await sleep(500);
    await ev(`document.querySelector('[data-hb=clarify-submit]')?.click()`);
    await sleep(3000);
    const after = await ev(`JSON.stringify({
      cards: document.querySelectorAll('[data-hb=request-card]').length,
      waiting: Boolean(document.querySelector('[data-hb=tab-waiting]')),
    })`);
    const parsed = JSON.parse(after);
    check("answering retires the card", parsed.cards === 0, after);
    check("answering clears the waiting marker", parsed.waiting === false, after);

    const shot2 = await send("Page.captureScreenshot", { format: "png" });
    writeFileSync(join(OUT, "11-cards-answered.png"), Buffer.from(shot2.result.data, "base64"));
    console.log("shot: 11-cards-answered.png");
  }
} catch (error) {
  check("run completed", false, error && error.message);
} finally {
  // Leave no trace: this run creates real sessions on a real gateway. Close the
  // live one first, then delete the row (close first, or the row re-persists:
  // AGENTS.md 铁律 19). The probe text is the judge, never a list diff.
  try {
    const cleaned = await ev(
      `(async () => {
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
        const listed = await req('session.list', { limit: 30 });
        const rows = (listed.result?.sessions ?? []).filter((row) => {
          const text = (row.preview || '') + (row.title || '');
          // The clarify probe prompt, plus an empty session: this run's own.
          return text.includes('clarify 工具') || (text.trim() === '' && (row.message_count ?? 0) === 0);
        });
        const out = { matched: rows.length, deleted: 0 };
        for (const row of rows) {
          await req('session.close', { session_id: row.resolved_id ?? row.id });
          // 0.22.5 fences session mutations behind a receipt: a bare DELETE is
          // answered 409 client_upgrade_required and the row stays. Read the
          // snapshot AFTER the close (closing advances the revision) and send all
          // three fence fields. A close leaves a short session_busy window, so
          // re-read the fence and retry.
          let done = false;
          let last = '';
          for (let attempt = 0; attempt < 5 && !done; attempt += 1) {
            if (attempt > 0) await new Promise((r) => setTimeout(r, 400 * attempt));
            try {
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
              done = true;
            } catch (error) {
              last = String(error && error.message);
              if (!/session_busy|storage_unavailable|runtime_draining/.test(last)) break;
            }
          }
          if (done) out.deleted += 1;
          else out.lastError = last.slice(0, 120);
        }
        const after = await req('session.list', { limit: 30 });
        out.remaining = (after.result?.sessions ?? []).length;
        ws.close();
        return JSON.stringify(out);
      })()`,
      true,
    );
    console.log("cleanup:", cleaned);
  } catch (error) {
    console.log("cleanup skipped:", error && error.message);
  }
  child.kill();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      rmSync(UD, { recursive: true, force: true });
      break;
    } catch {
      await sleep(1000);
    }
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
}
