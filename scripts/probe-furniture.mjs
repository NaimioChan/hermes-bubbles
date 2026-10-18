/**
 * Transcript-furniture probe against the LIVE dashboard.
 *
 * `verify.mjs` covers the page, the gateway and the message flow, but its turns
 * rarely produce a tool call — so the shape of a tool row (compact, collapsed,
 * on a hairline rail) and the absence of empty bubbles never get measured there.
 * This probe forces one real tool call and measures the DOM that comes back:
 * that a call is a one-line row rather than a padded card, that a run of them
 * packs, and that thinking and tool rows never paint as messages.
 *
 * Run with the dashboard up:  node scripts/probe-furniture.mjs
 */

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const shots = join(dirname(root), ".cache", "shots");
mkdirSync(shots, { recursive: true });

const DASHBOARD = process.env.HERMES_DASHBOARD_URL ?? "http://127.0.0.1:9119";
const PORT = Number(process.env.CDP_PORT ?? 9227);
const EDGE = process.env.EDGE_PATH ?? "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const USER_DATA = join(process.env.LOCALAPPDATA ?? process.env.TEMP ?? ".", "Temp", "edge-cdp-furniture-probe");

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
    this.consoleLines = [];
    ws.addEventListener("message", (event) => {
      const frame = JSON.parse(event.data);
      if (frame.id !== undefined) {
        const call = this.pending.get(frame.id);
        if (call) {
          this.pending.delete(frame.id);
          clearTimeout(call.timer);
          frame.error ? call.reject(new Error(JSON.stringify(frame.error))) : call.resolve(frame.result);
        }
        return;
      }
      if (frame.method === "Runtime.consoleAPICalled") {
        this.consoleLines.push(
          `[${frame.params.type}] ${frame.params.args.map((a) => a.value ?? a.description ?? a.type).join(" ")}`,
        );
      }
      if (frame.method === "Runtime.exceptionThrown") {
        const d = frame.params.exceptionDetails;
        this.consoleLines.push(`[exception] ${d.exception?.description ?? d.text}`);
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

const SCROLLER = `[...document.querySelectorAll('div')]
  .find(d => d.className.includes('hb-scroll') && d.className.includes('overflow-y-auto'))`;

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
    await s.send("Page.reload", { ignoreCache: true });
    await sleep(2000);
    await waitFor(s, `Boolean(document.querySelector('textarea') && !document.querySelector('textarea').disabled)`, {
      label: "composer ready",
    });

    // A prompt the model cannot answer from memory: it has to run something.
    await sendText(
      s,
      "请用 terminal 工具运行命令 echo hb-furniture-probe，然后把命令的真实输出原样告诉我。必须真的执行，不要编造。",
    );

    // Wait for the row to appear, and try to sample it mid-flight so the
    // running state (ring rail + live dot) is observed at least once.
    const rowDeadline = Date.now() + 150000;
    let seen = null;
    let sawRunning = false;
    while (Date.now() < rowDeadline) {
      const sample = await s.evaluate(`(() => {
        const scroller = ${SCROLLER};
        if (!scroller) return null;
        const rows = [...scroller.querySelectorAll('[data-hb="tool-row"]')];
        if (!rows.length) return null;
        return {
          count: rows.length,
          statuses: rows.map((r) => r.getAttribute('data-status')),
        };
      })()`);
      if (sample) {
        seen = sample;
        if (sample.statuses.includes("running")) sawRunning = true;
        if (!sample.statuses.includes("running")) break;
      }
      await sleep(500);
    }
    check("a tool call renders as a tool row", Boolean(seen), JSON.stringify(seen));
    if (!seen) {
      throw new Error("no tool row appeared — the model did not call a tool");
    }
    check("a running call paints the live state (when observed)", sawRunning !== false, `statuses seen: ${JSON.stringify(seen.statuses)}`);

    const shape = await s.evaluate(`(() => {
      const scroller = ${SCROLLER};
      const rows = [...scroller.querySelectorAll('[data-hb="tool-row"]')];
      const heads = rows.map((r) => r.querySelector('[data-hb="tool-toggle"]'));
      const first = rows[0];
      const style = getComputedStyle(first);
      const headStyle = getComputedStyle(heads[0]);
      const rect = heads[0].getBoundingClientRect();
      // Gap above the row: the per-kind rhythm, not the 1.15rem message gap.
      const wrap = first.closest('[data-hb-kind]');
      return {
        rows: rows.length,
        collapsed: heads.filter((h) => h.getAttribute('data-open') === 'false').length,
        ariaMatches: heads.every((h) => h.getAttribute('aria-expanded') === h.getAttribute('data-open')),
        fontSize: parseFloat(headStyle.fontSize),
        headHeight: Math.round(rect.height),
        background: style.backgroundColor,
        insideBubbleText: rows.filter((r) => r.querySelector('.hb-bubble-text')).length,
        wrapMarginTop: wrap ? parseFloat(getComputedStyle(wrap).marginTop) : null,
        kind: wrap ? wrap.getAttribute('data-hb-kind') : null,
        summary: (heads[0].querySelector('.hb-tool-summary') || {}).textContent || '',
        name: (heads[0].querySelector('.hb-tool-name') || {}).textContent || '',
      };
    })()`);
    check(
      "tool rows are compact one-liners, not cards",
      shape.fontSize <= 12 && shape.headHeight <= 24,
      `font=${shape.fontSize}px header=${shape.headHeight}px name=${JSON.stringify(shape.name)} summary=${JSON.stringify(shape.summary)}`,
    );
    check(
      "tool rows are not painted as bubbles",
      shape.background === "rgba(0, 0, 0, 0)" && shape.insideBubbleText === 0,
      `background=${shape.background} nested=${shape.insideBubbleText}`,
    );
    check(
      "tool rows start collapsed and stay answerable by aria",
      shape.collapsed === shape.rows && shape.ariaMatches === true,
      JSON.stringify({ collapsed: shape.collapsed, rows: shape.rows, aria: shape.ariaMatches }),
    );
    check(
      "tool rows sit on the packed rhythm",
      shape.kind === "tool" && typeof shape.wrapMarginTop === "number" && shape.wrapMarginTop <= 6,
      `kind=${shape.kind} margin-top=${shape.wrapMarginTop}px`,
    );

    // Expanding is the only thing that may grow the row. React commits the
    // attribute on the next tick, so the read happens in a separate evaluate
    // after a short wait — reading it in the same expression reads the old DOM.
    await s.evaluate(`(() => {
      const head = ${SCROLLER}.querySelector('[data-hb="tool-toggle"]');
      head.click();
      return true;
    })()`);
    await sleep(400);
    const expanded = await s.evaluate(`(() => {
      const row = ${SCROLLER}.querySelector('[data-hb="tool-row"]');
      const head = row.querySelector('[data-hb="tool-toggle"]');
      const pres = [...row.querySelectorAll('.hb-tool-pre')];
      return {
        open: head.getAttribute('data-open'),
        pres: pres.length,
        text: pres.map((p) => (p.textContent || '').slice(0, 160)).join(' ⏎ '),
      };
    })()`);
    check(
      "expanding a tool row reveals its output",
      expanded.open === "true" && expanded.pres > 0 && expanded.text.length > 0,
      JSON.stringify(expanded),
    );

    // The turn is not over when the call finishes: wait for the reply, so the
    // ordering check below measures a settled transcript.
    const replyDeadline = Date.now() + 45000;
    while (Date.now() < replyDeadline) {
      const ready = await s.evaluate(`(() => {
        const scroller = ${SCROLLER};
        if (!scroller) return false;
        return Boolean(scroller.querySelector('[data-hb-kind="assistant"]'));
      })()`);
      if (ready) break;
      await sleep(500);
    }
    await sleep(600);

    // The old complaints, measured on the same transcript.
    const leftovers = await s.evaluate(`(() => {
      const scroller = ${SCROLLER};
      const empties = [...scroller.querySelectorAll('.hb-bubble-text')]
        .filter((el) => !(el.textContent || '').trim()).length;
      const reasonings = [...scroller.querySelectorAll('[data-hb="reasoning-row"]')];
      const kinds = [...scroller.querySelectorAll('[data-hb-kind]')].map((el) => el.getAttribute('data-hb-kind'));
      // The reply that follows the calls must be its own bubble, below them.
      const lastToolIndex = kinds.lastIndexOf('tool');
      const replyAfterTool = kinds.slice(lastToolIndex + 1).includes('assistant');
      return {
        empties,
        reasoningRows: reasonings.length,
        reasoningInBubble: reasonings.filter((el) => el.closest('[data-hb-kind="assistant"]')).length,
        replyAfterTool,
        kinds,
      };
    })()`);
    check("no empty bubble is painted anywhere", leftovers.empties === 0, `empty=${leftovers.empties}`);
    if (leftovers.replyAfterTool) {
      check("the answer after the calls is its own bubble", true, JSON.stringify(leftovers.kinds));
    } else if (leftovers.kinds.filter((k) => k === "tool").length > 0) {
      // A failed call can end the turn with no reply; ordering itself is covered
      // by reduce.test.ts ("seals the assistant bubble at tool.start").
      console.log(`SKIP  reply after the calls — this turn produced no reply  (${JSON.stringify(leftovers.kinds)})`);
    }
    if (leftovers.reasoningRows > 0) {
      check(
        "thinking is a row of its own, never a bubble",
        leftovers.reasoningInBubble === 0,
        `rows=${leftovers.reasoningRows} inBubble=${leftovers.reasoningInBubble}`,
      );
    } else {
      console.log("SKIP  thinking placement — this model produced no reasoning");
    }

    const errors = s.consoleLines.filter(
      (line) =>
        (line.startsWith("[error]") || line.startsWith("[exception]")) &&
        !line.includes("extension://"),
    );
    check("no console errors", errors.length === 0, errors.join(" | ") || "clean");

    // Collapse it again and bring it to the middle of the viewport, so the
    // screenshot shows the resting state the user actually reads: packed rows
    // between a thinking block and the reply.
    await s.evaluate(`(() => {
      const scroller = ${SCROLLER};
      const head = scroller.querySelector('[data-hb="tool-toggle"]');
      if (head && head.getAttribute('data-open') === 'true') head.click();
      const row = scroller.querySelector('[data-hb="tool-row"]');
      if (row) row.scrollIntoView({ block: 'center' });
      return true;
    })()`);
    await sleep(600);
    const shot = await s.send("Page.captureScreenshot", { format: "png" });
    const shotPath = join(shots, "furniture.png");
    writeFileSync(shotPath, Buffer.from(shot.data, "base64"));
    console.log(`\nscreenshot: ${shotPath}`);
  } finally {
    child.kill();
  }

  console.log(`\n${results.length - failures}/${results.length} checks passed`);
  if (failures) process.exitCode = 1;
}

main().catch((e) => {
  console.error("probe crashed:", e);
  process.exitCode = 1;
});
