/**
 * On-demand live check: the PHONE layout.
 *
 * The page ships one bundle for both shapes. Above 768px nothing changed; below
 * it the tab strip is replaced by two floating buttons and a drawer, the
 * composer swaps its model/reasoning chips for a "···" menu, and every text
 * action becomes a round icon button. None of that is reachable from the unit
 * tests — they never lay anything out — so this drives a real page at 390×844
 * over CDP and measures.
 *
 * What it checks, in order:
 *
 *   1. no tab strip, both floating buttons present and round;
 *   2. the drawer opens from the right-hand button, has a "new chat" row at the
 *      top, and every session row's tools sit behind one "···";
 *   3. the composer has no model / reasoning chip, has one "···" button on the
 *      left and three round buttons on the right;
 *   4. the "···" menu carries model, reasoning and notifications;
 *   5. the composer row is ONE line and the textarea keeps real width;
 *   6. the desktop layout (1440×900) still has its tab strip and chips — the
 *      same bundle, so a regression here means the breakpoint leaked.
 *
 * Run with a dashboard up:
 *   HERMES_DASHBOARD_URL=http://127.0.0.1:9121 node scripts/verify-mobile.mjs
 */

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DASHBOARD = process.env.HERMES_DASHBOARD_URL ?? "http://127.0.0.1:9119";
const PORT = Number(process.env.CDP_PORT ?? 9229);
const EDGE = process.env.EDGE_PATH ?? "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const UD = join(process.env.LOCALAPPDATA ?? ".", "Temp", `edge-cdp-mobile-${process.pid}`);
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

let send = () => undefined;
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
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    }
  };
  send = (method, params = {}) =>
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

  const viewport = (width, height, mobile) =>
    send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 2, mobile });

  const shot = async (name) => {
    const { data } = await send("Page.captureScreenshot", { format: "png" });
    const file = join(OUT, `${name}.png`);
    writeFileSync(file, Buffer.from(data, "base64"));
    return file;
  };

  await send("Page.enable");
  await send("Runtime.enable");
  await viewport(390, 844, true);
  await send("Page.navigate", { url: `${DASHBOARD}/chat` });
  await send("Page.bringToFront");

  // The plugin boots asynchronously (SDK, socket, first session). Wait for the
  // composer rather than for a fixed delay.
  let ready = false;
  for (let i = 0; i < 90 && !ready; i++) {
    await sleep(500);
    ready = await evaluate("Boolean(document.querySelector('textarea[aria-label]'))").catch(() => false);
  }
  check("phone viewport renders the bubble page", ready === true);
  await sleep(1500);

  // ── 1. chrome ────────────────────────────────────────────────────────────
  const chrome = await evaluate(`(() => {
    const has = (hook) => Boolean(document.querySelector('[data-hb="' + hook + '"]'));
    const fab = document.querySelector('[data-hb="drawer-toggle"]');
    const refresh = document.querySelector('[data-hb="refresh-chat"]');
    const rect = (el) => el ? el.getBoundingClientRect() : null;
    const round = (el) => {
      if (!el) return false;
      const cs = getComputedStyle(el);
      return parseFloat(cs.borderTopLeftRadius) >= 18;
    };
    const fr = rect(fab), rr = rect(refresh);
    return {
      tabs: document.querySelectorAll('[data-hb="tab"]').length,
      tabStripVisible: (() => {
        const t = document.querySelector('[data-hb="tab"]');
        if (!t) return false;
        return t.getBoundingClientRect().height > 0;
      })(),
      hasDrawer: has("drawer-toggle"),
      hasRefresh: has("refresh-chat"),
      fabRound: round(fab),
      refreshRound: round(refresh),
      fabRight: fr ? Math.round(fr.right) : -1,
      refreshLeft: rr ? Math.round(rr.left) : -1,
      windowW: window.innerWidth,
    };
  })()`);
  check("no tab strip on a phone", chrome.tabs === 0 && chrome.tabStripVisible === false, JSON.stringify(chrome));
  check("front-left floating refresh button", chrome.hasRefresh && chrome.refreshRound && chrome.refreshLeft < 40, `left=${chrome.refreshLeft}`);
  check("front-right floating drawer button", chrome.hasDrawer && chrome.fabRound && chrome.fabRight > chrome.windowW - 60, `right=${chrome.fabRight} of ${chrome.windowW}`);
  await shot("20-phone-chrome");

  // ── 2. drawer chrome (rows need a stored session — created in step 3) ────
  await evaluate("document.querySelector('[data-hb=\"drawer-toggle\"]')?.click()");
  await sleep(700);
  const drawerChrome = await evaluate(`(() => {
    const panel = document.querySelector('[data-hb="history-panel"]');
    if (!panel) return { open: false };
    const r = panel.getBoundingClientRect();
    // Anchored to the chat area, not the viewport: the host's own top bar owns
    // the first ~95px, and a sheet painted under it would hide its own header.
    const area = document.querySelector('[data-layout]').getBoundingClientRect();
    return {
      open: true,
      variant: panel.getAttribute("data-variant"),
      fromRight: Math.abs(r.right - area.right) <= 1,
      fromTop: Math.abs(r.top - area.top) <= 1,
      width: Math.round(r.width),
      windowW: window.innerWidth,
      newChat: Boolean(panel.querySelector('[data-hb="drawer-new"]')),
    };
  })()`);
  check(
    "drawer opens from the right edge of the chat area",
    drawerChrome.open === true && drawerChrome.variant === "drawer" && drawerChrome.fromRight && drawerChrome.fromTop,
    JSON.stringify(drawerChrome),
  );
  check("drawer has a new-chat row at the top", drawerChrome.newChat === true);
  await shot("21-phone-drawer");

  // No dimming: the transcript behind the sheet must stay at full strength.
  const scrim = await evaluate(`(() => {
    const b = document.querySelector('[data-hb="history-backdrop"]');
    if (!b) return null;
    const cs = getComputedStyle(b);
    return { background: cs.backgroundColor, opacity: cs.opacity };
  })()`);
  check(
    "drawer adds no darkening layer over the chat",
    scrim !== null &&
      (scrim.background === "rgba(0, 0, 0, 0)" || scrim.background === "transparent") &&
      scrim.opacity === "1",
    JSON.stringify(scrim),
  );

  // Closing must animate: the panel stays mounted, in the `closing` state, then
  // goes away. A close that unmounts synchronously leaves nothing to watch.
  const closingFrames = [];
  await evaluate('document.querySelector(`[data-hb="history-close"]`)?.click()');
  for (let i = 0; i < 8; i += 1) {
    await sleep(40);
    closingFrames.push(
      await evaluate(`(() => {
        const p = document.querySelector('[data-hb="history-panel"]');
        if (!p) return "gone";
        return p.getAttribute("data-state") + ":" + getComputedStyle(p).animationName;
      })()`),
    );
  }
  check(
    "closing the drawer plays an exit animation",
    closingFrames.some((f) => String(f).startsWith("closing:hb-slide-out-right")),
    JSON.stringify(closingFrames),
  );
  let gone = false;
  for (let i = 0; i < 30 && !gone; i += 1) {
    await sleep(100);
    gone = await evaluate(`!document.querySelector('[data-hb="history-panel"]')`);
  }
  check("the drawer unmounts once the exit finishes", gone === true);
  await sleep(300);

  // ── 3. composer ──────────────────────────────────────────────────────────
  const composer = await evaluate(`(() => {
    const row = document.querySelector('.hb-composer-row');
    const ta = row?.querySelector('textarea');
    const round = (el) => el && parseFloat(getComputedStyle(el).borderTopLeftRadius) >= 18;
    const btns = [...(row?.querySelectorAll('button') ?? [])];
    const hookOf = (b) => b.getAttribute('data-hb') ?? '';
    return {
      more: Boolean(row?.querySelector('[data-hb="composer-more"]')),
      upload: Boolean(row?.querySelector('[data-hb="composer-upload"]')),
      modelChip: Boolean(row?.querySelector('[data-hb="model-picker-open"]')),
      stopOrSend: { stop: Boolean(row?.querySelector('[data-hb="stop-action"]')), send: Boolean(row?.querySelector('[data-hb="primary-action"]')) },
      sendRound: round(row?.querySelector('[data-hb="primary-action"]')),
      uploadRound: round(row?.querySelector('[data-hb="composer-upload"]')),
      rowHeight: row ? Math.round(row.getBoundingClientRect().height) : -1,
      inputWidth: ta ? Math.round(ta.getBoundingClientRect().width) : -1,
      rowBottom: row ? Math.round(row.getBoundingClientRect().bottom) : -1,
      hooks: btns.map(hookOf).filter(Boolean),
    };
  })()`);
  check("composer has one '···' button on the left", composer.more === true);
  check("model / reasoning chips are gone from the row", composer.modelChip === false);
  check("round send button on the right", composer.stopOrSend.send === true && composer.sendRound === true);
  check("upload button left of send", composer.upload === true && composer.uploadRound === true, JSON.stringify(composer.hooks));
  // One line: a wrapped cluster used to push this row past 90px on a phone.
  check("composer row is a single line", composer.rowHeight > 0 && composer.rowHeight < 56, `height=${composer.rowHeight}`);
  check("textarea keeps usable width", composer.inputWidth > 140, `width=${composer.inputWidth}`);
  await shot("22-phone-composer");

  // ── 3b. one real turn, so the drawer has a row to inspect ────────────────
  // `session.list` only carries a row once the turn is persisted, and a session
  // with no rows cannot show a row menu. A short prompt keeps this quick.
  const typed = await evaluate(`(() => {
    const ta = document.querySelector('textarea');
    if (!ta) return false;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, 'reply with the single word: ok');
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  check("composer accepts typed text", typed === true);
  await evaluate("document.querySelector('[data-hb=\"primary-action\"]')?.click()");

  let answered = false;
  for (let i = 0; i < 120 && !answered; i++) {
    await sleep(1000);
    answered = await evaluate(`(() => {
      const bubbles = document.querySelectorAll('[data-hb-kind="assistant"]');
      return bubbles.length > 0 && !document.querySelector('[data-hb="stop-action"]');
    })()`).catch(() => false);
  }
  check("a real turn round-trips on the phone layout", answered === true);

  // ── 3c. session rows in the drawer ───────────────────────────────────────
  await evaluate("document.querySelector('[data-hb=\"drawer-toggle\"]')?.click()");
  await sleep(900);
  const rows = await evaluate(`(() => {
    const panel = document.querySelector('[data-hb="history-panel"]');
    if (!panel) return { open: false };
    return {
      open: true,
      rows: panel.querySelectorAll('[data-hb="history-row"]').length,
      menus: panel.querySelectorAll('[data-hb="session-menu"]').length,
      bareTools: panel.querySelectorAll('[data-hb="rename-session"], [data-hb="delete-session"]').length,
    };
  })()`);
  check(
    "one '···' menu per session row",
    rows.open === true && rows.rows > 0 && rows.menus === rows.rows && rows.bareTools === 0,
    `rows=${rows.rows} menus=${rows.menus} bare=${rows.bareTools}`,
  );

  await evaluate("document.querySelector('[data-hb=\"session-menu\"]')?.click()");
  await sleep(400);
  const rowMenu = await evaluate(`(() => {
    const p = document.querySelector('[data-hb="session-menu-panel"]');
    if (!p) return { open: false };
    return { open: true, items: [...p.querySelectorAll('[data-hb]')].map((b) => b.getAttribute('data-hb')) };
  })()`);
  check(
    "session menu holds context / rename / delete",
    rowMenu.open === true &&
      ["session-to-context", "rename-session", "delete-session"].every((h) => rowMenu.items.includes(h)),
    JSON.stringify(rowMenu.items),
  );
  await shot("25-phone-session-menu");
  await evaluate("document.querySelector('[data-hb=\"history-close\"]')?.click()");
  await sleep(400);

  // ── 4. composer "···" menu ───────────────────────────────────────────────
  await evaluate("document.querySelector('[data-hb=\"composer-more\"]')?.click()");
  await sleep(400);
  const tools = await evaluate(`(() => {
    const m = document.querySelector('[data-hb="composer-menu"]');
    if (!m) return { open: false };
    const rows = [...m.querySelectorAll('button')].map((b) => b.getAttribute('data-hb'));
    return { open: true, rows, notify: Boolean(m.querySelector('[data-hb="notify-toggle"]')) };
  })()`);
  check(
    "composer menu carries model, reasoning, notifications",
    tools.open === true &&
      tools.rows.includes("model-picker-open") &&
      tools.rows.includes("reasoning-cycle") &&
      tools.notify === true,
    JSON.stringify(tools.rows),
  );
  await shot("23-phone-tools-menu");
  await evaluate("document.querySelector('[data-hb=\"composer-menu\"] [aria-label]')?.click()");
  await sleep(250);

  // ── 5. desktop: same controls, plus the tab strip ────────────────────────
  await viewport(1440, 900, false);
  await sleep(900);
  const desktop = await evaluate(`(() => {
    const row = document.querySelector('.hb-composer-row');
    const round = (el) => el && parseFloat(getComputedStyle(el).borderTopLeftRadius) >= 18;
    const strip = document.querySelector('[data-hb="refresh-chat"]');
    return {
      tabs: document.querySelectorAll('[data-hb="tab"]').length,
      tabStrip: Boolean(document.querySelector('[data-hb="tab-new"]')),
      fabs: Boolean(document.querySelector('[data-hb="drawer-toggle"]')),
      stripRefresh: Boolean(strip),
      stripRefreshRound: round(strip),
      // The composer is the SAME control set as the phone's.
      composerMore: Boolean(row?.querySelector('[data-hb="composer-more"]')),
      upload: Boolean(row?.querySelector('[data-hb="composer-upload"]')),
      send: Boolean(row?.querySelector('[data-hb="primary-action"]')),
      sendRound: round(row?.querySelector('[data-hb="primary-action"]')),
      modelChip: Boolean(row?.querySelector('[data-hb="model-picker-open"]')),
      attachPlus: Boolean(row?.querySelector('.hb-composer-attach')),
    };
  })()`);
  check("desktop keeps its tab strip", desktop.tabStrip === true, JSON.stringify(desktop));
  check("desktop has no floating drawer button", desktop.fabs === false);
  check("desktop strip carries a round refresh button", desktop.stripRefresh === true && desktop.stripRefreshRound === true);
  check(
    "desktop composer matches the phone: menu + round upload/send",
    desktop.composerMore === true && desktop.upload === true && desktop.sendRound === true,
    JSON.stringify(desktop),
  );
  check("no model chip / `+` left in the composer row", desktop.modelChip === false && desktop.attachPlus === false);
  await shot("24-desktop-unchanged");

  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exitCode = failed ? 1 : 0;
} finally {
  try {
    child.kill();
  } catch {
    // already gone
  }
}
