/**
 * Desktop history panel: does it open and close with motion?
 *
 * The panel was the last surface in the page that appeared and vanished by
 * cutting, while the phone's drawer had slid both ways since the mobile round.
 * This measures the desktop column specifically — width 0 → 17rem on the way in,
 * `[data-state="closing"]` + `hb-panel-out` on the way out, unmount only after
 * the animation ends — and grabs two screenshots for the README.
 *
 * It also re-checks the icon set where the last complaint was: a history row's
 * three tools and a reply's three tools must all be 24-grid SVGs at one size.
 *
 * Run with a dashboard up:
 *   HERMES_DASHBOARD_URL=http://127.0.0.1:9124 node scripts/verify-panel.mjs
 */

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DASHBOARD = process.env.HERMES_DASHBOARD_URL ?? "http://127.0.0.1:9119";
const PORT = Number(process.env.CDP_PORT ?? 9245);
const EDGE = process.env.EDGE_PATH ?? "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const UD = join(process.env.LOCALAPPDATA ?? ".", "Temp", `edge-cdp-panel-${process.pid}`);
const OUT = join(process.cwd(), ".cache", "shots");
mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail === undefined ? "" : `  — ${detail}`}`);
};

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
  const ev = async (expression) => {
    const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text ?? "eval failed");
    return r.result?.value;
  };
  const shot = async (name) => {
    const { data } = await send("Page.captureScreenshot", { format: "png" });
    writeFileSync(join(OUT, `${name}.png`), Buffer.from(data, "base64"));
    return name;
  };

  await send("Page.enable");
  await send("Runtime.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false });
  // Headless Edge reports `prefers-reduced-motion: reduce`, and this stylesheet
  // honours that by zeroing every animation — so without this override the
  // script would measure a page that deliberately does not animate, and "no
  // motion" would look like a failure instead of a setting.
  await send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-motion", value: "no-preference" }],
  });
  await send("Page.navigate", { url: `${DASHBOARD}/chat` });
  await send("Page.bringToFront");

  let ready = false;
  for (let i = 0; i < 90 && !ready; i += 1) {
    await sleep(500);
    ready = await ev("Boolean(document.querySelector('textarea'))").catch(() => false);
  }
  check("desktop viewport renders", ready === true);
  await sleep(1500);

  // A stored session is what the panel lists, and a fresh profile has none.
  await ev(`(() => {
    const ta = document.querySelector('textarea');
    const set = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    set.call(ta, 'reply with the single word: ok');
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await ev('document.querySelector(`[data-hb="primary-action"]`)?.click()');
  for (let i = 0; i < 90; i += 1) {
    await sleep(1000);
    const done = await ev(
      'Boolean(document.querySelector(`[data-hb-kind="assistant"]`)) && !document.querySelector(`[data-hb="stop-action"]`)',
    ).catch(() => false);
    if (done) break;
  }
  await sleep(1200);

  // ── 1: opening animates, and the width is what it animates ────────────────
  const openSamples = await ev(`(async () => {
    const samples = [];
    const toggle = document.querySelector('[data-hb="history-toggle"]');
    if (!toggle) return { error: 'no history toggle' };
    toggle.click();
    for (let i = 0; i < 40; i += 1) {
      const p = document.querySelector('[data-hb="history-panel"]');
      samples.push({
        t: i * 16,
        w: p ? Math.round(p.getBoundingClientRect().width) : -1,
        anim: p ? getComputedStyle(p).animationName : null,
        cls: p ? p.className : null,
        variant: p ? p.getAttribute('data-variant') : null,
      });
      await new Promise((r) => requestAnimationFrame(r));
      await new Promise((r) => setTimeout(r, 16));
    }
    return samples;
  })()`, { awaitPromise: true });

  const widths = openSamples.map((s) => s.w).filter((w) => w >= 0);
  const mounted = openSamples.filter((s) => s.variant !== null);
  check(
    "the desktop panel is the docked column, not the drawer",
    mounted.length > 0 && mounted.every((s) => s.variant === "panel" && s.cls.includes("hb-hist-panel")),
    `${mounted.length}/${openSamples.length} frames mounted`,
  );
  check(
    "opening plays hb-panel-in",
    openSamples.some((s) => s.anim === "hb-panel-in"),
    openSamples.map((s) => s.anim).filter(Boolean).slice(0, 4).join(","),
  );
  check(
    "the panel grows from 0 to its resting width instead of appearing at full size",
    widths.some((w) => w > 0 && w < 200) && Math.max(...widths) >= 250,
    `widths ${Math.min(...widths)}…${Math.max(...widths)} of ${widths.length} frames`,
  );
  const restingWidth = await ev(`(() => {
    const p = document.querySelector('[data-hb="history-panel"]');
    if (!p) return null;
    return {
      width: Math.round(p.getBoundingClientRect().width),
      // 17rem against the host's root font size — the number the CSS states.
      declared: Math.round(17 * parseFloat(getComputedStyle(document.documentElement).fontSize)),
    };
  })()`);
  check(
    "the panel settles at its declared 17rem",
    restingWidth !== null && restingWidth.width === restingWidth.declared,
    JSON.stringify(restingWidth),
  );

  await sleep(400);
  await shot("50-desktop-panel-open");

  // ── 2: closing animates, then unmounts ────────────────────────────────────
  const closeSamples = await ev(`(async () => {
    const samples = [];
    document.querySelector('[data-hb="history-close"]')?.click();
    for (let i = 0; i < 50; i += 1) {
      const p = document.querySelector('[data-hb="history-panel"]');
      samples.push({
        state: p ? p.getAttribute('data-state') : 'gone',
        anim: p ? getComputedStyle(p).animationName : null,
        w: p ? Math.round(p.getBoundingClientRect().width) : -1,
      });
      await new Promise((r) => requestAnimationFrame(r));
      await new Promise((r) => setTimeout(r, 16));
    }
    return samples;
  })()`, { awaitPromise: true });

  check(
    "closing plays hb-panel-out rather than cutting",
    closeSamples.some((s) => s.anim === "hb-panel-out" && s.state === "closing"),
    closeSamples.filter((s) => s.anim === "hb-panel-out").length + " frames",
  );
  check(
    "the panel shrinks before it goes",
    closeSamples.some((s) => s.w > 0 && s.w < 200),
    `saw ${closeSamples.filter((s) => s.w > 0 && s.w < 200).length} shrinking frames`,
  );
  check("and only then unmounts", closeSamples.some((s) => s.state === "gone"), `${closeSamples.filter((s) => s.state === "gone").length} gone frames`);

  // ── 3: the icon set, where the complaint was ─────────────────────────────
  await ev(`document.querySelector('[data-hb="history-toggle"]')?.click()`);
  await sleep(600);
  const rowIcons = await ev(`(() => {
    const panel = document.querySelector('[data-hb="history-panel"]');
    const btns = [...panel.querySelectorAll('.hb-row-tools .hb-action-btn')];
    return btns.map((b) => {
      const svg = b.querySelector('svg');
      const r = svg ? svg.getBoundingClientRect() : null;
      return { icon: svg?.getAttribute('data-icon'), w: r ? Math.round(r.width) : 0, vb: svg?.getAttribute('viewBox') };
    });
  })()`);
  check(
    "a history row's three tools are one icon set at one size",
    Array.isArray(rowIcons)
      && rowIcons.length > 0
      && rowIcons.length % 3 === 0
      && rowIcons.every((i) => i.icon && i.vb === "0 0 24 24" && i.w === 15),
    JSON.stringify(rowIcons),
  );

  const carets = await ev(`(() => {
    const out = [];
    for (const cls of ['hb-think-caret', 'hb-tool-caret', 'hb-act-caret', 'hb-todo-caret', 'hb-proj-caret']) {
      const el = document.querySelector('.' + cls);
      if (!el) continue;
      const svg = el.querySelector('svg');
      out.push({ cls, icon: svg?.getAttribute('data-icon') ?? null, transform: getComputedStyle(el).transform });
    }
    return out;
  })()`);
  if (carets.length) {
    check(
      "every disclosure caret is the same chevron icon, rotated rather than swapped",
      carets.every((c) => c.icon === "chevron"),
      JSON.stringify(carets),
    );
  } else {
    // Nothing was collapsed on this run's page. The invariant is guarded at the
    // source level instead (tests/layout-classes.test.ts): no `▸`/`▾` glyph may
    // exist in the sources at all.
    console.log("SKIP  caret glyphs — nothing collapsible on screen this run");
  }

  // A reply's own footer, for the screenshot and one more size check.
  const replyIcons = await ev(`(() => {
    const rows = [...document.querySelectorAll('[data-hb="message-actions"]')];
    const row = rows[rows.length - 1];
    if (!row) return null;
    return [...row.querySelectorAll('.hb-action-btn')].map((b) => {
      const svg = b.querySelector('svg');
      const box = b.getBoundingClientRect();
      return {
        icon: svg?.getAttribute('data-icon'),
        w: svg ? Math.round(svg.getBoundingClientRect().width) : 0,
        box: Math.round(box.width),
        // Optical centring: the glyph's centre must sit on the button's centre.
        // A text glyph cannot do this, which is what "uneven" meant.
        dy: svg ? Math.round((svg.getBoundingClientRect().top + svg.getBoundingClientRect().bottom) / 2 - (box.top + box.bottom) / 2) : null,
      };
    });
  })()`);
  check(
    "reply footer glyphs are centred in their buttons, not baseline-sitting",
    Array.isArray(replyIcons) && replyIcons.length === 3 && replyIcons.every((i) => Math.abs(i.dy) <= 1),
    JSON.stringify(replyIcons),
  );

  await ev(`document.querySelector('[data-hb="message-actions"]')?.scrollIntoView({ block: 'center' })`);
  await sleep(300);
  await ev(`(() => {
    const rows = [...document.querySelectorAll('.hb-actions')];
    const row = rows[rows.length - 1];
    row?.parentElement?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    row?.closest('[data-hb-kind]')?.classList.add('hb-probe-hover');
    // The row is revealed by :hover, which a script cannot set; force the
    // opacity directly so the screenshot shows the footer instead of a gap.
    if (row) row.style.opacity = '1';
    return true;
  })()`);
  await sleep(250);
  await shot("51-message-actions");

  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${passed}/${results.length} checks passed`);
  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    console.log("\nFailed:");
    for (const f of failed) console.log(`  - ${f.name}`);
  }
  process.exitCode = failed.length ? 1 : 0;
} finally {
  try {
    child.kill();
  } catch {
    // already gone
  }
}
