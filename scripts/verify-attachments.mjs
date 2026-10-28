/**
 * On-demand live check: a sent message keeps its attachments, and staging is
 * visible while the bytes travel.
 *
 * Two things the unit tests cannot see:
 *
 *   1. a photo sent with a caption still renders as a square thumbnail in the
 *      transcript afterwards (before this, the bubble showed only the text and
 *      the file vanished without a trace);
 *   2. a file being staged shows WHERE it is — reading off disk (a real
 *      percentage) then uploading (an indeterminate sweep). Over a remote
 *      dashboard the upload is where the seconds go, and the old chip said "…"
 *      for the whole of it.
 *
 * Attaching goes through the real `<input type=file>` via CDP's
 * `DOM.setFileInputFiles`, so the whole pick → stage → send path runs.
 *
 * Run with a dashboard up:
 *   HERMES_DASHBOARD_URL=http://127.0.0.1:9121 node scripts/verify-attachments.mjs
 */

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const DASHBOARD = process.env.HERMES_DASHBOARD_URL ?? "http://127.0.0.1:9119";
const PORT = Number(process.env.CDP_PORT ?? 9230);
const EDGE = process.env.EDGE_PATH ?? "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const UD = join(process.env.LOCALAPPDATA ?? ".", "Temp", `edge-cdp-att-${process.pid}`);
const OUT = join(process.cwd(), ".cache", "shots");
const FIXTURES = join(process.cwd(), ".cache", "probe");
mkdirSync(OUT, { recursive: true });
mkdirSync(FIXTURES, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PNG = resolve(FIXTURES, "probe-shot.png");
const TXT = resolve(FIXTURES, "probe-notes.txt");

// Fixtures: a real 96×72 PNG (so a thumbnail has something to show) and a small
// text file, both written fresh per run.
writeFileSync(TXT, "probe attachment\n");
writeFileSync(PNG, await makePng(96, 72, [92, 158, 214]));

async function makePng(width, height, rgb) {
  const { deflateSync } = await import("node:zlib");
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolour
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: width * 3 }, (_, i) => rgb[i % 3]))]);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

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
  await send("DOM.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await send("Page.navigate", { url: `${DASHBOARD}/chat` });
  await send("Page.bringToFront");

  let ready = false;
  for (let i = 0; i < 90 && !ready; i++) {
    await sleep(500);
    ready = await evaluate("Boolean(document.querySelector('textarea'))").catch(() => false);
  }
  check("page renders", ready === true);

  // ── stage both files through the real file input ─────────────────────────
  const { root } = await send("DOM.getDocument", { depth: -1 });
  const { nodeId } = await send("DOM.querySelector", {
    nodeId: root.nodeId,
    selector: 'input[type="file"]',
  });
  check("file input is in the DOM", nodeId > 0, `nodeId=${nodeId}`);

  // Tray state immediately after picking: it must say it is working, not "…".
  await send("DOM.setFileInputFiles", { nodeId, files: [PNG, TXT] });
  await sleep(250);
  const staging = await evaluate(`(() => {
    const chips = [...document.querySelectorAll('[data-hb="attachment-chip"]')];
    return {
      count: chips.length,
      kinds: chips.map((c) => c.getAttribute("data-kind")),
      phases: chips.map((c) => (c.querySelector('.hb-att-phase')?.textContent ?? "").trim()),
      bars: document.querySelectorAll('[data-hb="attachment-progress"]').length,
      thumbs: document.querySelectorAll('.hb-att-thumb').length,
      names: chips.map((c) => (c.querySelector('.hb-att-name')?.textContent ?? "").trim()),
    };
  })()`);
  check("both picks appear in the tray", staging.count === 2, JSON.stringify(staging));
  check("an image gets a thumbnail, a text file a glyph", staging.thumbs === 1, `thumbs=${staging.thumbs}`);
  check(
    "each staging chip says where it is",
    staging.phases.length === 2 && staging.phases.every((p) => p.length > 0),
    JSON.stringify(staging.phases),
  );
  check("staging shows a progress rail", staging.bars === 2, `bars=${staging.bars}`);
  await shot("30-staging-progress");

  // Wait for the backend to accept both.
  let settled = false;
  for (let i = 0; i < 120 && !settled; i++) {
    await sleep(500);
    settled = await evaluate(
      `[...document.querySelectorAll('[data-hb="attachment-chip"]')].every((c) => c.getAttribute('data-status') !== 'staging')`,
    ).catch(() => false);
  }
  const settledState = await evaluate(`(() => {
    const chips = [...document.querySelectorAll('[data-hb="attachment-chip"]')];
    return {
      statuses: chips.map((c) => c.getAttribute("data-status")),
      bars: document.querySelectorAll('[data-hb="attachment-progress"]').length,
      sendEnabled: !document.querySelector('[data-hb="primary-action"]')?.disabled,
    };
  })()`);
  check("both attachments settle as ready", settledState.statuses.every((s) => s === "ready"), JSON.stringify(settledState.statuses));
  check("the progress rail disappears once staged", settledState.bars === 0);
  // An attachment-only turn must be sendable (no caption typed yet).
  check("a staged file alone enables Send", settledState.sendEnabled === true);

  // ── send with a caption, then read the bubble ────────────────────────────
  await evaluate(`(() => {
    const ta = document.querySelector('textarea');
    const set = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    set.call(ta, 'what colour is this');
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await sleep(200);
  await evaluate('document.querySelector(`[data-hb="primary-action"]`)?.click()');

  let bubble = null;
  for (let i = 0; i < 60 && !bubble; i++) {
    await sleep(500);
    bubble = await evaluate(`(() => {
      const row = document.querySelector('[data-hb="message-attachments"]');
      if (!row) return null;
      const tiles = [...row.querySelectorAll('[data-hb="message-attachment"]')];
      return {
        count: tiles.length,
        kinds: tiles.map((t) => t.getAttribute("data-kind")),
        images: row.querySelectorAll('.hb-msg-att-image').length,
        names: tiles.map((t) => (t.querySelector('.hb-msg-att-name')?.textContent ?? "").trim()),
        square: tiles.filter((t) => {
          const r = t.getBoundingClientRect();
          return Math.abs(r.width - r.height) <= 1 && r.width > 40;
        }).length,
        text: (document.querySelector('[data-hb-kind="user"] .hb-bubble-text')?.textContent ?? "").trim(),
      };
    })()`).catch(() => null);
  }
  check("the sent message shows its attachments", bubble?.count === 2, JSON.stringify(bubble));
  check("the image is a square thumbnail", bubble?.square >= 1, `squares=${bubble?.square}`);
  check("the text file shows its name", (bubble?.names ?? []).some((n) => n.includes("probe-notes")), JSON.stringify(bubble?.names));
  check("the caption stays the caption", (bubble?.text ?? "").startsWith("what colour is this"), JSON.stringify(bubble?.text?.slice(0, 60)));
  await shot("31-sent-with-attachments");

  // ── reload: the row's trailing `@file:` comes back as an attachment ──────
  // A reopened session has no object URLs; what survives is the reference the
  // gateway stored on the row. The bubble must still show the file by name
  // rather than dumping `@file:...` into the prose.
  //
  // A reload opens a FRESH draft (every page load mints a session), so the turn
  // has to be reopened from the list — that is also the path a phone user takes.
  await send("Page.reload", { ignoreCache: false });
  await sleep(3000);
  let ready2 = false;
  for (let i = 0; i < 60 && !ready2; i++) {
    await sleep(500);
    ready2 = await evaluate("Boolean(document.querySelector('textarea'))").catch(() => false);
  }
  await evaluate("document.querySelector('[data-hb=\"drawer-toggle\"]')?.click()");
  await sleep(1500);
  // The most recent row is the turn just sent (its title is derived from it).
  const picked = await evaluate(`(() => {
    const row = [...document.querySelectorAll('[data-hb="history-row"]')].find((r) =>
      (r.textContent ?? "").includes("what colour is this"),
    );
    if (!row) return null;
    row.click();
    return (row.textContent ?? "").trim().slice(0, 40);
  })()`);
  check("the sent turn appears in the session list", picked !== null, JSON.stringify(picked));

  let restored = null;
  for (let i = 0; i < 60 && !restored; i++) {
    await sleep(700);
    restored = await evaluate(`(() => {
      const rows = [...document.querySelectorAll('[data-hb-kind="user"]')];
      for (const row of rows) {
        const atts = row.querySelector('[data-hb="message-attachments"]');
        if (!atts) continue;
        return {
          names: [...atts.querySelectorAll('[data-hb="message-attachment"]')].map((t) =>
            (t.querySelector('.hb-msg-att-name')?.textContent ?? "").trim(),
          ),
          text: (row.querySelector('.hb-bubble-text')?.textContent ?? "").trim(),
        };
      }
      return null;
    })()`).catch(() => null);
  }
  check(
    "a reopened session keeps the file attachment (and no @file in the prose)",
    restored !== null && restored.names.some((n) => n.includes("probe-notes")) && !restored.text.includes("@file:"),
    JSON.stringify(restored),
  );
  await shot("32-reloaded-attachments");

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
