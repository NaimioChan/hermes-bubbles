/**
 * End-to-end check: a model switch the gateway wants confirmed must be answerable.
 *
 * The gateway answers `confirm_required` + `confirm_message` instead of switching
 * when a selection guard fires, and writes nothing — the client has to re-send the
 * SAME pick with `confirm_expensive_model: true`. The guard that turns up in
 * ordinary use is the large-context one (`model.switch_context_confirm_tokens`):
 * a model switch throws away the provider's prompt cache, so the next reply
 * re-reads the whole conversation at full price. Rendering that message as a
 * transcript notice — which is what this plugin used to do — leaves no way to say
 * yes, so the switch never completes.
 *
 * This drives the real dashboard against a real model: switch to a working model,
 * run one turn (the guard needs a measured context), then switch again and assert
 * that a dialog with an accept control appears, that cancelling keeps the old
 * model, and that accepting applies the switch.
 *
 * The guard only fires above its threshold, so a real session is rarely big enough
 * on a test box. Pass `--edit-config` to temporarily set
 * `model.switch_context_confirm_tokens: 1`; config.yaml is backed up first and
 * restored byte for byte in `finally`. Without the flag this script leaves your
 * config alone and reports that the guard did not fire.
 *
 * Run with the dashboard up:  node scripts/verify-confirm.mjs [--edit-config]
 *
 * Environment:
 *   PROBE_MODEL   the model the probe switches to first (must serve requests)
 *   PROBE_TARGET  the model the guarded switch targets
 */

import { spawn } from "node:child_process";
import { rmSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const HOME = process.env.HERMES_HOME ?? join(process.env.LOCALAPPDATA ?? process.env.HOME ?? ".", "hermes");
const CONFIG = join(HOME, "config.yaml");
const DASHBOARD = process.env.HERMES_DASHBOARD_URL ?? "http://127.0.0.1:9119";
const PORT = Number(process.env.CDP_PORT ?? 9233);
const EDGE = process.env.EDGE_PATH ?? "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const USER_DATA = join(
  process.env.LOCALAPPDATA ?? process.env.TEMP ?? ".", "Temp",
  // Per-run profile: a reused one attaches to a stale tab and the whole run fails
  // on the first check. Same reason as scripts/verify.mjs.
  `edge-cdp-confirm-${process.pid}`,
);
const EDIT_CONFIG = process.argv.includes("--edit-config");
const WORKING_MODEL = process.env.PROBE_MODEL ?? "global:deepseek-v4.1-flash";
const GUARDED_TARGET = process.env.PROBE_TARGET ?? "cn:deepseek-v4.1-flash";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let failures = 0;
function check(name, ok, detail) {
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail === undefined ? "" : `  — ${detail}`}`);
}

// ── CDP plumbing ───────────────────────────────────────────────────────────

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
      if (frame.method === "Runtime.exceptionThrown") {
        const d = frame.params.exceptionDetails;
        const where = d.url || d.stackTrace?.callFrames?.[0]?.url || "unknown";
        this.consoleLines.push(`[exception] ${d.exception?.description ?? d.text} @ ${where}`);
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
    targets.find((t) => t.type === "page" && !t.url.startsWith("edge://") && !t.url.startsWith("chrome://")) ??
    targets.find((t) => t.type === "page");
  if (!page) throw new Error("no page target in the headless instance");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });
  const session = new Session(ws);
  await session.send("Page.enable");
  await session.send("Runtime.enable");
  await session.send("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  // A second tab makes this one hidden, which freezes rAF and hangs screenshots.
  await session.send("Page.bringToFront");
  return session;
}

async function waitFor(session, expression, { timeout = 20000, label = expression } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      if (await session.evaluate(expression)) return true;
    } catch {
      // page may be mid-navigation
    }
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${label}`);
}

/** The model the composer claims. Read off the chip's tooltip — the label truncates. */
function currentModel(session) {
  return session.evaluate(
    `(document.querySelector('[data-hb="model-picker-open"]')?.title ?? '').replace(/^[^:]*:\\s*/, '')`,
  );
}

/** Open the picker and click one named model. False when it is not offered. */
async function pickModel(session, name) {
  await session.evaluate(`document.querySelector('[data-hb="model-picker-open"]').click()`);
  await waitFor(session, `document.querySelectorAll('button span.font-mono').length > 1`, {
    timeout: 20000,
    label: "the model list",
  });
  return session.evaluate(`(() => {
    const row = [...document.querySelectorAll('button')]
      .filter((b) => b.querySelector('span.font-mono'))
      .find((b) => b.querySelector('span.font-mono').textContent.trim() === ${JSON.stringify(name)});
    if (!row) return false;
    row.click();
    return true;
  })()`);
}

/** Send one prompt and wait for the turn to settle (running is the stop control). */
async function sendAndSettle(session, text) {
  await session.evaluate(`(() => {
    const ta = document.querySelector('textarea');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, ${JSON.stringify(text)});
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    return true;
  })()`);
  await waitFor(session, `Boolean(document.querySelector('[data-hb="stop-action"]'))`, {
    timeout: 60000,
    label: "the turn to start",
  });
  await waitFor(session, `!document.querySelector('[data-hb="stop-action"]')`, {
    timeout: 240000,
    label: "the turn to finish",
  });
  await sleep(1200);
}

/**
 * Close and delete the session this run minted.
 *
 * Selection is by probe prompt, not by list diff: the session that appears on page
 * load is the one a diff cannot see. A live row re-persists after DELETE, so map
 * stored -> runtime and close first (same rule as scripts/verify.mjs).
 */
async function cleanupRunSession(session, probeText) {
  return session
    .evaluate(
      `(async () => {
        const sdk = window.__HERMES_PLUGIN_SDK__;
        const url = await sdk.buildWsUrl('/api/ws');
        const ws = new WebSocket(url);
        const waiting = new Map();
        let nextId = 1;
        const req = (method, params) => new Promise((resolve) => {
          const id = nextId++;
          waiting.set(id, resolve);
          ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
          setTimeout(() => resolve({ error: 'timeout' }), 8000);
        });
        ws.onmessage = (event) => {
          const frame = JSON.parse(event.data);
          const done = waiting.get(frame.id);
          if (done) { waiting.delete(frame.id); done(frame); }
        };
        await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

        const listed = await req('session.list', { limit: 8 });
        const mine = (listed.result?.sessions ?? []).find((row) =>
          (String(row.title || '') + String(row.preview || '')).includes(${JSON.stringify(probeText)}));
        const out = { id: mine?.id ?? null, closed: false, deleted: false };
        if (mine?.id) {
          const active = await req('session.active_list', {});
          const live = new Map();
          for (const row of active.result?.sessions ?? []) {
            if (row.id) live.set(String(row.id), String(row.id));
            if (row.session_key) live.set(String(row.session_key), String(row.id));
          }
          const runtime = live.get(String(mine.id));
          if (runtime) {
            await req('session.close', { session_id: runtime });
            out.closed = true;
            await new Promise((r) => setTimeout(r, 500));
          }
          try {
            // 0.22.5 fences session mutations behind a receipt: a bare DELETE is
            // answered 409 client_upgrade_required and the row stays. Read the
            // snapshot AFTER the close (closing advances the revision) and send
            // all three fence fields.
            const snap = await sdk.fetchJSON(
              '/api/sessions/' + encodeURIComponent(mine.id) + '/mutation-snapshot', { method: 'GET' });
            const fence = new URLSearchParams({
              request_id: 'hb-clean-' + Date.now() + '-' + Math.floor(Math.random() * 1e6),
              expected_revision: String(snap && typeof snap.runtime_revision === 'number' ? snap.runtime_revision : 0),
            });
            if (snap && typeof snap.runtime_generation === 'number') {
              fence.set('expected_generation', String(snap.runtime_generation));
            }
            await sdk.fetchJSON(
              '/api/sessions/' + encodeURIComponent(mine.id) + '?' + fence.toString(), { method: 'DELETE' });
            out.deleted = true;
          } catch (error) {
            out.error = error && error.message;
          }
        }
        ws.close();
        return JSON.stringify(out);
      })()`,
      { awaitPromise: true },
    )
    .catch((error) => `cleanup failed: ${error.message}`);
}

// ── main ───────────────────────────────────────────────────────────────────

const PROBE_TEXT = "回答两个字：收到";
const originalConfig = EDIT_CONFIG ? readFileSync(CONFIG, "utf8") : null;

function withThreshold(text, value) {
  if (text.includes("switch_context_confirm_tokens")) {
    return text.replace(/switch_context_confirm_tokens:.*/, `switch_context_confirm_tokens: ${value}`);
  }
  return text.replace(/^model:\r?\n/m, (line) => `${line}  switch_context_confirm_tokens: ${value}\r\n`);
}

async function main() {
  console.log(`dashboard: ${DASHBOARD}`);
  console.log(`models:    ${WORKING_MODEL} -> ${GUARDED_TARGET}\n`);

  if (EDIT_CONFIG) {
    writeFileSync(CONFIG, withThreshold(originalConfig, 1), "utf8");
    console.log(`threshold set to 1 token in ${CONFIG} (restored at the end)\n`);
  } else {
    console.log("not editing config.yaml — the guard must already fire for this run\n");
  }

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
    { stdio: "ignore", detached: false },
  );

  let session = null;
  try {
    let ready = false;
    for (let i = 0; i < 60 && !ready; i += 1) {
      try {
        await fetch(`http://127.0.0.1:${PORT}/json/version`);
        ready = true;
      } catch {
        await sleep(300);
      }
    }
    if (!ready) throw new Error("headless Edge never came up");

    session = await connect();
    await session.send("Page.navigate", { url: `${DASHBOARD}/chat` });
    await waitFor(
      session,
      `Boolean(window.__HERMES_PLUGIN_SDK__ && document.querySelector('[data-hb="transcript"]'))`,
      { timeout: 30000, label: "the bubbles page" },
    );
    await waitFor(session, `Boolean(document.querySelector('[data-hb="model-picker-open"]'))`, {
      timeout: 20000,
      label: "the composer",
    });
    await sleep(1200);

    // Settle on a model that answers, and prove an unguarded switch needs no dialog.
    const before = await currentModel(session);
    const switched = await pickModel(session, WORKING_MODEL);
    check(`the picker offers ${WORKING_MODEL}`, switched, switched ? `from ${before}` : "not offered");
    await waitFor(
      session,
      `(document.querySelector('[data-hb="model-picker-open"]')?.title ?? '').endsWith(${JSON.stringify(WORKING_MODEL)})`,
      { timeout: 15000, label: "the composer to show the new model" },
    ).catch(() => {});
    check(
      "an unguarded switch applies without a dialog",
      (await currentModel(session)) === WORKING_MODEL &&
        !(await session.evaluate(`Boolean(document.querySelector('[data-hb="model-confirm"]'))`)),
      await currentModel(session),
    );

    // One turn, so the session has a measured context size for the guard to read.
    await sendAndSettle(session, PROBE_TEXT);
    check("the probe turn finished", true, "context measured");

    const picked = await pickModel(session, GUARDED_TARGET);
    check(`the picker offers ${GUARDED_TARGET}`, picked, picked ? "" : "not offered");
    const dialogAppeared = await waitFor(session, `Boolean(document.querySelector('[data-hb="model-confirm"]'))`, {
      timeout: 20000,
      label: "the confirmation dialog",
    }).then(() => true).catch(() => false);

    if (!dialogAppeared) {
      // Not a product failure without --edit-config: the session may simply be
      // under the threshold, in which case there is nothing to confirm.
      check(
        "a guarded switch opens a confirmation dialog",
        false,
        EDIT_CONFIG
          ? "no dialog even with the threshold at 1 token"
          : "the guard did not fire — run with --edit-config, or lower model.switch_context_confirm_tokens",
      );
    } else {
      const dialog = await session.evaluate(`(() => {
        const panel = document.querySelector('[data-hb="model-confirm"]');
        return {
          text: panel ? panel.innerText : '',
          accept: Boolean(document.querySelector('[data-hb="model-confirm-accept"]')),
          cancel: Boolean(document.querySelector('[data-hb="model-confirm-cancel"]')),
        };
      })()`);
      check("a guarded switch opens a confirmation dialog", true, "shown");
      check(
        "the dialog explains why (large-context guard)",
        /LARGE CONTEXT/i.test(dialog.text) && /tokens of context/i.test(dialog.text),
        dialog.text.replace(/\s+/g, " ").slice(0, 140),
      );
      check("the dialog has an accept control", dialog.accept, "model-confirm-accept");
      check("the dialog has a cancel control", dialog.cancel, "model-confirm-cancel");

      // Cancel: nothing changes.
      await session.evaluate(`document.querySelector('[data-hb="model-confirm-cancel"]').click()`);
      await sleep(600);
      const afterCancel = {
        dialog: await session.evaluate(`Boolean(document.querySelector('[data-hb="model-confirm"]'))`),
        model: await currentModel(session),
      };
      check(
        "cancelling closes the dialog and leaves the model alone",
        afterCancel.dialog === false && afterCancel.model === WORKING_MODEL,
        JSON.stringify(afterCancel),
      );

      // Accept: the held switch is applied.
      await pickModel(session, GUARDED_TARGET);
      await waitFor(session, `Boolean(document.querySelector('[data-hb="model-confirm-accept"]'))`, {
        timeout: 20000,
        label: "the dialog again",
      });
      await session.evaluate(`document.querySelector('[data-hb="model-confirm-accept"]').click()`);
      await waitFor(session, `!document.querySelector('[data-hb="model-confirm"]')`, {
        timeout: 30000,
        label: "the dialog to close after accepting",
      });
      await sleep(1200);
      const afterAccept = {
        dialog: await session.evaluate(`Boolean(document.querySelector('[data-hb="model-confirm"]'))`),
        model: await currentModel(session),
        notices: await session.evaluate(
          `[...document.querySelectorAll('[data-hb-kind="notice"]')].map((n) => n.innerText.trim()).slice(-2)`,
        ),
      };
      check(
        "accepting applies the switch the guard was holding",
        afterAccept.model === GUARDED_TARGET && afterAccept.dialog === false,
        JSON.stringify(afterAccept),
      );
      check(
        "the switch is not also reported as an error",
        !(afterAccept.notices ?? []).some((line) => /LARGE CONTEXT|cancel/i.test(line)),
        JSON.stringify(afterAccept.notices ?? []),
      );
    }

    const exceptions = session.consoleLines.filter((line) => line.startsWith("[exception]"));
    check("no page exceptions during the flow", exceptions.length === 0, exceptions.join(" | ") || "none");
  } finally {
    if (EDIT_CONFIG) {
      writeFileSync(CONFIG, originalConfig, "utf8");
      console.log(`\nconfig.yaml restored: ${readFileSync(CONFIG, "utf8") === originalConfig}`);
    }
    if (session) console.log(`\ncleanup: ${await cleanupRunSession(session, PROBE_TEXT)}`);
    try {
      child.kill();
    } catch {
      // already gone
    }
    // The per-run profile is ~800 MB; leaving it behind is how the temp dir grew
    // to 107 copies / 18 GB. Removal can race Edge's own shutdown, hence the retry.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        rmSync(USER_DATA, { recursive: true, force: true });
        break;
      } catch {
        await sleep(1000);
      }
    }
    console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
    process.exit(failures === 0 ? 0 : 1);
  }
}

main().catch((error) => {
  console.error(error);
  if (EDIT_CONFIG) {
    try {
      writeFileSync(CONFIG, originalConfig, "utf8");
    } catch {
      // nothing else to do
    }
  }
  process.exit(1);
});
