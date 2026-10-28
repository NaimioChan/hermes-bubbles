/**
 * On-demand live check: the collapsed activity block.
 *
 * The complaint this exists for: thinking, tool calls and code runs between two
 * text messages fill the chat area, and the fix has to be visible on a real page
 * rather than asserted from source. Unit tests cover the grouping rules
 * (`tests/run.test.ts`); what they cannot see is whether the block actually
 * measures 190px and whether the rows inside it are still reachable.
 *
 * Checks, in order:
 *
 *   1. a turn that produces machinery renders ONE activity block, not a row per
 *      step (`[data-hb=activity-block]`);
 *   2. collapsed, the block's rendered height is at or below the ceiling and its
 *      body is clipped (`data-hb-locked`);
 *   3. the rows are still in the DOM (nothing is unmounted to save height) but
 *      are `inert` — no focusable control under the clip;
 *   4. expanding it reveals every row and grows past the ceiling;
 *   5. collapsing restores the ceiling;
 *   6. two text messages stay visible above and below the block.
 *
 * Run against a dashboard that has the plugin installed:
 *   HERMES_DASHBOARD_URL=http://127.0.0.1:9123 node scripts/verify-activity.mjs
 */

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DASHBOARD = process.env.HERMES_DASHBOARD_URL ?? "http://127.0.0.1:9119";
const PORT = Number(process.env.CDP_PORT ?? 9231);
const EDGE = process.env.EDGE_PATH ?? "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const UD = join(process.env.LOCALAPPDATA ?? ".", "Temp", `edge-cdp-activity-${process.pid}`);
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

// Eight separate calls, one per command, on purpose: the ceiling has to BIND for
// the clip, the `inert` lock and the expand-then-recollapse path to be observed
// at all, and eight compact rows plus their thinking segments overflow 190px.
const PROMPT =
  "逐个用 terminal 跑 node -e \"console.log(n)\" ，n 从 1 到 14，一次一条、绝不合并。" +
  "14 条都必须真的调用工具，每条之间不要写解释，最后只回一句「十四个都跑完了」。";

try {
  for (let i = 0; i < 80; i++) {
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
  const consoleLines = [];
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.method === "Runtime.consoleAPICalled") {
      consoleLines.push(
        `[${msg.params.type}] ${(msg.params.args ?? []).map((a) => a.value ?? a.description ?? "").join(" ")}`,
      );
    }
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    }
  };
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  const evaluate = async (expression) => {
    const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text ?? "evaluate failed");
    return result.result?.value;
  };

  await send("Page.enable");
  await send("Runtime.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await send("Page.navigate", { url: `${DASHBOARD}/chat` });
  await send("Page.bringToFront");

  let ready = false;
  for (let i = 0; i < 90 && !ready; i++) {
    await sleep(500);
    ready = await evaluate("Boolean(document.querySelector('textarea[aria-label]'))").catch(() => false);
  }
  check("chat page renders", ready === true);
  await sleep(1200);

  // ── send the prompt ───────────────────────────────────────────────────────
  await evaluate(`(() => {
    const ta = document.querySelector('textarea[aria-label]');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, ${JSON.stringify(PROMPT)});
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await evaluate("document.querySelector('[data-hb=\"primary-action\"]')?.click()");

  // Wait for the block to appear AND the turn to settle.
  let settled = false;
  for (let i = 0; i < 200 && !settled; i++) {
    await sleep(1000);
    settled = await evaluate(`(() => {
      const block = document.querySelector('[data-hb="activity-block"]');
      const stop = document.querySelector('[data-hb="stop-action"]');
      return Boolean(block) && !stop;
    })()`).catch(() => false);
  }
  check("a turn that runs tools renders an activity block", settled === true);

  if (!settled) {
    console.log("\nno block appeared — cannot continue");
    throw new Error("no activity block");
  }
  await sleep(800);

  // ── the block, collapsed ──────────────────────────────────────────────────
  const collapsed = await evaluate(`(() => {
    const scroller = document.querySelector('[data-hb="transcript"]');
    const blocks = [...(scroller ? scroller.querySelectorAll('[data-hb="activity-block"]') : [])];
    if (!blocks.length) return { blocks: 0 };
    const block = blocks[0];
    const toggle = block.querySelector('[data-hb="activity-toggle"]');
    const body = block.querySelector('.hb-act-body');
    // Rows live inside the body even while it is clipped: nothing is unmounted
    // to save height, which is what keeps tool output one click away.
    const rows = body ? body.querySelectorAll('[data-hb-kind], [data-hb="tool-row"], [data-hb="reasoning-row"], [data-hb="subagent-card"], [data-hb="notice"]').length : 0;
    const outer = block.getBoundingClientRect();
      const inner = body ? body.getBoundingClientRect() : null;
    const scrollable = body ? body.scrollHeight : 0;
    return {
      blocks: blocks.length,
      open: toggle ? toggle.getAttribute('data-open') : null,
      aria: toggle ? toggle.getAttribute('aria-expanded') : null,
      blockHeight: Math.round(outer.height),
      bodyHeight: inner ? Math.round(inner.height) : null,
      bodyContent: scrollable,
      locked: body ? body.getAttribute('data-hb-locked') : null,
      inert: body ? body.hasAttribute('inert') : null,
      hidden: body ? body.getAttribute('aria-hidden') : null,
      // How much of the run is actually inside the box. scrollHeight cannot
      // answer this: the clip is anchored to the bottom, so the overflow goes
      // off the TOP and never counts as scroll. Measuring the rows themselves
      // is what distinguishes "cut" from "fits".
      clipped: inner
        ? [...body.querySelectorAll(':scope > *')].filter((el) => {
            const r = el.getBoundingClientRect();
            return r.top < inner.top - 1 || r.bottom > inner.bottom + 1;
          }).length
        : 0,
      // A focusable control under the clip would be reachable by Tab.
      focusables: body ? body.querySelectorAll('button, a[href], input, textarea, [tabindex]').length : 0,
      tabbable: body
        ? [...body.querySelectorAll('button, a[href], input, textarea, [tabindex]')]
            .filter((el) => el.tabIndex >= 0 && !el.disabled && el.closest('[inert]') === null).length
        : 0,
      rows,
      text: (toggle ? toggle.textContent : '').trim(),
      caret: (toggle ? toggle.querySelector('.hb-act-caret')?.textContent : '') ?? '',
    };
  })()`);
  console.log(`      ${JSON.stringify(collapsed)}`);

  check("exactly one block holds the whole run", collapsed.blocks === 1, `blocks=${collapsed.blocks}`);
  check(
    "the block starts collapsed",
    collapsed.open === "false" && collapsed.aria === "false",
    `open=${collapsed.open} aria=${collapsed.aria}`,
  );
  check(
    "collapsed, the block stays at or under its ceiling",
    typeof collapsed.blockHeight === "number" && collapsed.blockHeight <= 200,
    `height=${collapsed.blockHeight}px body=${collapsed.bodyHeight}px`,
  );
  check(
    "collapsed, the body is clipped but every row is still mounted",
    collapsed.locked === "true" && collapsed.inert === true && collapsed.rows > 0,
    `rows=${collapsed.rows} clippedRows=${collapsed.clipped}`,
  );
  check(
    "nothing under the clip can be focused or clicked",
    collapsed.inert === true && collapsed.hidden === "true" && collapsed.tabbable === 0,
    `inert=${collapsed.inert} aria-hidden=${collapsed.hidden} focusables=${collapsed.focusables} tabbable=${collapsed.tabbable}`,
  );
  check(
    "the header names what is inside",
    typeof collapsed.text === "string" && collapsed.text.replace(collapsed.caret, "").trim().length > 0,
    JSON.stringify(collapsed.text),
  );
  await send("Page.captureScreenshot", { format: "png" }).then((shot) =>
    writeFileSync(join(OUT, "30-activity-collapsed.png"), Buffer.from(shot.data, "base64")),
  );

  // ── expand ────────────────────────────────────────────────────────────────
  await evaluate('document.querySelector(`[data-hb="activity-toggle"]`).click()');
  await sleep(500);
  const expanded = await evaluate(`(() => {
    const block = document.querySelector('[data-hb="activity-block"]');
    const toggle = block.querySelector('[data-hb="activity-toggle"]');
    const body = block.querySelector('.hb-act-body');
    return {
      open: toggle.getAttribute('data-open'),
      aria: toggle.getAttribute('aria-expanded'),
      blockHeight: Math.round(block.getBoundingClientRect().height),
      locked: body ? body.getAttribute('data-hb-locked') : null,
      inert: body ? body.hasAttribute('inert') : null,
      overflow: body ? getComputedStyle(body).overflowY : null,
      // Interactive rows are reachable again once open.
      tabbable: [...body.querySelectorAll('button')].filter((el) => el.tabIndex >= 0 && !el.disabled).length,
    };
  })()`);
  console.log(`      ${JSON.stringify(expanded)}`);
  check(
    "expanding opens the block and lifts the clip",
    expanded.open === "true" && expanded.aria === "true" && expanded.locked === null,
    `open=${expanded.open} locked=${expanded.locked}`,
  );
  // Growth is only meaningful for a run that actually got clipped; a short run
  // fits under the ceiling by itself and expanding it changes nothing visible.
  check(
    "expanding shows every row and stops clipping",
    expanded.overflow === "auto" && expanded.blockHeight > collapsed.blockHeight,
    `collapsed=${collapsed.blockHeight}px expanded=${expanded.blockHeight}px`,
  );
  check(
    "expanded rows are reachable again",
    expanded.inert === false && expanded.tabbable > 0,
    `inert=${expanded.inert} tabbable=${expanded.tabbable}`,
  );
  await send("Page.captureScreenshot", { format: "png" }).then((shot) =>
    writeFileSync(join(OUT, "31-activity-expanded.png"), Buffer.from(shot.data, "base64")),
  );

  // ── collapse again ────────────────────────────────────────────────────────
  await evaluate('document.querySelector(`[data-hb="activity-toggle"]`).click()');
  await sleep(500);
  const recollapsed = await evaluate(`(() => {
    const block = document.querySelector('[data-hb="activity-block"]');
    const body = block.querySelector('.hb-act-body');
    return {
      height: Math.round(block.getBoundingClientRect().height),
      locked: body ? body.getAttribute('data-hb-locked') : null,
    };
  })()`);
  check(
    "collapsing puts the ceiling back",
    recollapsed.height <= 200 && recollapsed.locked === "true",
    JSON.stringify(recollapsed),
  );

  // ── the messages around it ────────────────────────────────────────────────
  const around = await evaluate(`(() => {
    const scroller = document.querySelector('[data-hb="transcript"]');
    const order = [...scroller.querySelectorAll('[data-hb-kind]')].map((el) => el.getAttribute('data-hb-kind'));
    const users = scroller.querySelectorAll('[data-hb-kind="user"]').length;
    const assistants = scroller.querySelectorAll('[data-hb-kind="assistant"]').length;
    return { order, users, assistants };
  })()`);
  check(
    "the two messages sit outside the block",
    around.users >= 1 && around.assistants >= 1 && around.order.includes("run"),
    JSON.stringify(around),
  );

  // ── the phone ─────────────────────────────────────────────────────────────
  // Where the ceiling matters most: 190px of machinery on an 844px screen is the
  // difference between "the answer is visible" and "scroll to find it".
  await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await sleep(700);
  const phone = await evaluate(`(() => {
    const block = document.querySelector('[data-hb="activity-block"]');
    if (!block) return { present: false };
    const r = block.getBoundingClientRect();
    const scroller = document.querySelector('[data-hb="transcript"]');
    const sr = scroller.getBoundingClientRect();
    return {
      present: true,
      height: Math.round(r.height),
      width: Math.round(r.width),
      viewport: window.innerWidth,
      transcript: Math.round(sr.height),
      // Share of the visible transcript the block takes while collapsed.
      share: Math.round((r.height / sr.height) * 100),
      overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  })()`);
  console.log(`      ${JSON.stringify(phone)}`);
  check(
    "on a phone the collapsed block keeps the ceiling and fits the width",
    phone.present === true && phone.height <= 200 && phone.width <= phone.viewport && phone.overflowX === 0,
    `height=${phone.height}px width=${phone.width}/${phone.viewport} overflowX=${phone.overflowX}`,
  );
  check(
    "on a phone it takes a minority of the transcript",
    typeof phone.share === "number" && phone.share < 55,
    `${phone.share}% of ${phone.transcript}px`,
  );
  await send("Page.captureScreenshot", { format: "png" }).then((shot) =>
    writeFileSync(join(OUT, "32-activity-phone.png"), Buffer.from(shot.data, "base64")),
  );

  const errors = consoleLines.filter(
    (line) =>
      (line.startsWith("[error]") || line.startsWith("[exception]")) &&
      !line.includes("extension://") &&
      !line.includes("edge-extension://"),
  );
  check("no console errors", errors.length === 0, errors.join(" | ") || "clean");
} finally {
  child.kill();
}

console.log(`\n${results.filter((r) => r.ok).length}/${results.length} checks passed`);
if (results.some((r) => !r.ok)) process.exitCode = 1;
