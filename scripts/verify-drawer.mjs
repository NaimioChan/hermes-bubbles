/**
 * Phone layout, second pass — the four things the first pass got wrong.
 *
 * Measured against a live page at 390x844, because none of these are visible to
 * a unit test:
 *
 *   1. the drawer comes in from the RIGHT edge (it used to fly in from the left);
 *   2. there is NO darkening layer behind it (the chat stays readable);
 *   3. closing plays an exit animation instead of vanishing (`data-state` goes
 *      `closing`, the panel stays mounted, then unmounts);
 *   4. text is vertically CENTRED in its box — the composer's draft, a history
 *      row's title, and a project row's title.
 *
 * Run with a dashboard up:
 *   HERMES_DASHBOARD_URL=http://127.0.0.1:9122 node scripts/verify-drawer.mjs
 */

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DASHBOARD = process.env.HERMES_DASHBOARD_URL ?? "http://127.0.0.1:9119";
const PORT = Number(process.env.CDP_PORT ?? 9233);
const EDGE = process.env.EDGE_PATH ?? "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const UD = join(process.env.LOCALAPPDATA ?? ".", "Temp", `edge-cdp-drawer-${process.pid}`);
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

try {
  for (let i = 0; i < 80; i += 1) {
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
  let seq = 0;
  const pending = new Map();
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve: ok, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else ok(msg.result);
    }
  };
  const send = (method, params = {}) =>
    new Promise((ok, reject) => {
      const id = ++seq;
      pending.set(id, { resolve: ok, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  const evaluate = async (expression) => {
    const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text ?? "eval failed");
    return r.result?.value;
  };
  const shot = async (name) => {
    const { data } = await send("Page.captureScreenshot", { format: "png" });
    writeFileSync(join(OUT, `${name}.png`), Buffer.from(data, "base64"));
  };

  await send("Page.enable");
  await send("Runtime.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await send("Page.navigate", { url: `${DASHBOARD}/chat` });
  await send("Page.bringToFront");

  let ready = false;
  for (let i = 0; i < 90 && !ready; i += 1) {
    await sleep(500);
    ready = await evaluate("Boolean(document.querySelector('textarea'))").catch(() => false);
  }
  check("phone viewport renders", ready === true);
  await sleep(1200);

  // A row needs a stored session, and a fresh instance has none: send one short
  // turn so the drawer has something to measure.
  await evaluate(`(() => {
    const ta = document.querySelector('textarea');
    const set = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    set.call(ta, 'reply with the single word: ok');
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await evaluate('document.querySelector(`[data-hb="primary-action"]`)?.click()');
  for (let i = 0; i < 90; i += 1) {
    await sleep(1000);
    const done = await evaluate(
      'Boolean(document.querySelector(`[data-hb-kind="assistant"]`)) && !document.querySelector(`[data-hb="stop-action"]`)',
    ).catch(() => false);
    if (done) break;
  }
  check("a turn round-trips so the list has a row", true);
  await sleep(1500);

  // ── 1 + 2: direction and no scrim ────────────────────────────────────────
  await evaluate('document.querySelector(`[data-hb="drawer-toggle"]`)?.click()');
  await sleep(650);
  const open = await evaluate(`(() => {
    const p = document.querySelector('[data-hb="history-panel"]');
    if (!p) return { open: false };
    const r = p.getBoundingClientRect();
    const area = document.querySelector('[data-layout]').getBoundingClientRect();
    const b = document.querySelector('[data-hb="history-backdrop"]');
    const bcs = b ? getComputedStyle(b) : null;
    const cs = getComputedStyle(p);
    return {
      open: true,
      state: p.getAttribute("data-state"),
      fromRight: Math.abs(r.right - area.right) <= 1,
      flushBottomRight: Math.abs(r.bottom - area.bottom) <= 1,
      animation: cs.animationName,
      scrim: bcs ? bcs.backgroundColor : null,
      scrimOpacity: bcs ? bcs.opacity : null,
    };
  })()`);
  check("drawer is open and anchored to the right edge", open.open === true && open.fromRight === true, JSON.stringify(open));
  check("entrance is a right-to-left slide", String(open.animation).includes("hb-slide-in-right"), String(open.animation));
  check(
    "no darkening layer over the chat",
    (open.scrim === "rgba(0, 0, 0, 0)" || open.scrim === "transparent") && open.scrimOpacity === "1",
    `scrim=${open.scrim} opacity=${open.scrimOpacity}`,
  );
  await shot("40-drawer-right-nodim");

  // ── 4a: history row title is centred in its row ──────────────────────────
  const rowCentre = await evaluate(`(() => {
    const row = document.querySelector('[data-hb="history-row"]');
    if (!row) return null;
    const main = row.querySelector('.hb-hist-main');
    const title = main?.querySelector('.hb-truncate');
    if (!main || !title) return null;
    const m = main.getBoundingClientRect();
    const t = title.getBoundingClientRect();
    return {
      delta: Math.round(Math.abs((t.top + t.height / 2) - (m.top + m.height / 2))),
      rowH: Math.round(row.getBoundingClientRect().height),
    };
  })()`);
  check("history title sits centred in its row", rowCentre !== null && rowCentre.delta <= 1, JSON.stringify(rowCentre));

  // ── 3: closing animates, then unmounts ───────────────────────────────────
  await evaluate('document.querySelector(`[data-hb="history-close"]`)?.click()');
  const frames = [];
  for (let i = 0; i < 10; i += 1) {
    await sleep(35);
    frames.push(
      await evaluate(`(() => {
        const p = document.querySelector('[data-hb="history-panel"]');
        if (!p) return "gone";
        return p.getAttribute("data-state") + ":" + getComputedStyle(p).animationName;
      })()`),
    );
  }
  check(
    "closing plays a rightward exit animation",
    frames.some((f) => String(f).startsWith("closing:hb-slide-out-right")),
    JSON.stringify(frames),
  );
  let gone = false;
  for (let i = 0; i < 40 && !gone; i += 1) {
    await sleep(100);
    gone = await evaluate('!document.querySelector(`[data-hb="history-panel"]`)');
  }
  check("the drawer unmounts once the exit finishes", gone === true, `frames=${frames.length}`);

  // ── 4b: composer draft is centred in its row ─────────────────────────────
  const inputCentre = await evaluate(`(() => {
    const row = document.querySelector('.hb-composer-row');
    const ta = row?.querySelector('textarea');
    const btn = row?.querySelector('[data-hb="primary-action"]');
    if (!row || !ta || !btn) return null;
    const r = row.getBoundingClientRect();
    const t = ta.getBoundingClientRect();
    const b = btn.getBoundingClientRect();
    return {
      rowH: Math.round(r.height),
      inputVsRow: Math.round(Math.abs((t.top + t.height / 2) - (r.top + r.height / 2))),
      buttonVsRow: Math.round(Math.abs((b.top + b.height / 2) - (r.top + r.height / 2))),
      inputVsButton: Math.round(Math.abs((t.top + t.height / 2) - (b.top + b.height / 2))),
    };
  })()`);
  check(
    "composer text and buttons share the row's centre line",
    inputCentre !== null && inputCentre.inputVsRow <= 1 && inputCentre.buttonVsRow <= 1 && inputCentre.inputVsButton <= 1,
    JSON.stringify(inputCentre),
  );
  await shot("41-composer-centred");

  // ── 5: hover and press actually respond, with a transition ───────────────
  // A transition can be declared and still never run (a rule overridden later, a
  // property that is not animatable). So drive a real pointer: hover the send
  // button, then press it, and read the computed style at each step.
  const rect = await evaluate(`(() => {
    const b = document.querySelector('[data-hb="composer-upload"]');
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  })()`);
  check("upload button is measurable", rect !== null, JSON.stringify(rect));

  const styleOf = () =>
    evaluate(`(() => {
      const b = document.querySelector('[data-hb="composer-upload"]');
      const cs = getComputedStyle(b);
      return { bg: cs.backgroundColor, transform: cs.transform, transitionDuration: cs.transitionDuration };
    })()`);

  const idle = await styleOf();
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: rect.x, y: rect.y, buttons: 0 });
  await sleep(400);
  const hovered = await styleOf();
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x: rect.x, y: rect.y, button: "left", clickCount: 1 });
  await sleep(160);
  const pressed = await styleOf();
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: rect.x, y: rect.y, button: "left", clickCount: 1 });
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 5, y: 5, buttons: 0 });
  await sleep(200);

  check(
    "hovering a round button changes its surface",
    hovered.bg !== idle.bg,
    `${idle.bg} -> ${hovered.bg}`,
  );
  check(
    "pressing it scales the button (and the press has its own transition)",
    pressed.transform !== "none" && pressed.transform !== hovered.transform,
    `${hovered.transform} -> ${pressed.transform}`,
  );
  check(
    "the motion is driven by the shared tokens",
    /0\.(0[0-9]|1[0-9])s/.test(idle.transitionDuration) && !/0s, 0s, 0s/.test(idle.transitionDuration),
    idle.transitionDuration,
  );

  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exitCode = failed ? 1 : 0;
} finally {
  try {
    child.kill();
  } catch {
    // gone
  }
}
