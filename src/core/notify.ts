/**
 * Desktop notifications: when to raise one, and what it says.
 *
 * The point is narrow — the dashboard is in the background, so the human is not
 * watching the chat — which means a notification that fires while the window IS
 * focused is pure noise. Everything here is pure: the browser's Notification
 * object and the permission prompt live in `src/ui/notifier.ts` (AGENTS.md 铁律 1).
 */

import type { Messages } from "./i18n";

export type NotificationPermissionKind = "default" | "granted" | "denied";

export type NotifyKind = "approval" | "clarify" | "done" | "failed";

/** What the tab-strip switch should show. */
export type NotifySwitch = "on" | "needs-permission" | "blocked" | "off";

export interface NotifySpec {
  kind: NotifyKind;
  title: string;
  /** One or two lines; the OS notification body. */
  body: string;
  /**
   * Notification identity. Browsers replace a notification with the same tag
   * instead of stacking a second one, which is what a rebuilding UI needs:
   * re-rendering a pending request must not ring the desktop twice.
   */
  tag: string;
  /**
   * Keep the toast on screen until the human dismisses it.
   *
   * A pending approval/clarify request blocks the turn for up to an hour; a
   * toast that fades on its own after five seconds reads as optional and gets
   * missed, which leaves the agent waiting on nobody.
   */
  sticky: boolean;
}

export interface TurnNotice {
  kind: "request" | "complete";
  /** Present on `request` notices: what the human has to answer. */
  method?: "approval" | "clarify";
  params?: Record<string, unknown>;
  requestId?: string;
  /** Tab key the notice belongs to; used to avoid stacking duplicates. */
  sessionKey: string;
  /** Session title, when the backend has given one. */
  title: string;
  /** The reply's own text (complete) — the notification body's best content. */
  text: string;
  error?: string;
}

export interface NotifyGate {
  /** The user's switch (persisted; on by default). */
  enabled: boolean;
  permission: NotificationPermissionKind;
  /** The dashboard window is not in the foreground. */
  background: boolean;
}

/** The one rule: enabled, permitted, and the human is not looking at the page. */
export function shouldNotify(gate: NotifyGate): boolean {
  return gate.enabled && gate.permission === "granted" && gate.background;
}

export const NOTIFY_STORAGE_KEY = "hb-notify";

/**
 * The switch's honest label.
 *
 * The stored preference defaults to "on", so a switch that only read the
 * preference claimed notifications were working in a browser that had never
 * granted permission — which is exactly the state where nothing can ever fire.
 * The permission is the second half of the state, and the panel says so.
 */
export function notifySwitch(enabled: boolean, permission: NotificationPermissionKind): NotifySwitch {
  if (!enabled) return "off";
  if (permission === "granted") return "on";
  return permission === "denied" ? "blocked" : "needs-permission";
}

/** Stored preference. Anything other than an explicit "off" keeps it on. */
export function storedEnabled(raw: string | null | undefined): boolean {
  return raw !== "off";
}

/** Markdown → one flat line, for a notification body. */
export function flatten(text: string, limit = 120): string {
  const plain = text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^#{1,6}\s*/gm, "")
    .replace(/[*_~>|]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (plain.length <= limit) return plain;
  return `${plain.slice(0, limit - 1)}…`;
}

function firstString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * A pending `approval` / `clarify` request, as a notification.
 *
 * The command (or the question) is the part a human needs to decide whether to
 * come back to the window, so it leads; the tool name is only a fallback.
 */
export function requestNotice(
  method: "approval" | "clarify",
  params: Record<string, unknown>,
  t: Messages,
  tag: string,
): NotifySpec {
  if (method === "approval") {
    const detail =
      firstString(params.description) || firstString(params.command) || firstString(params.tool_name);
    return {
      kind: "approval",
      title: t.notifyApprovalTitle,
      body: flatten(detail, 160) || firstString(params.tool_name) || t.approvalTitle,
      tag,
      sticky: true,
    };
  }
  const questions = Array.isArray(params.questions) ? params.questions : [];
  const first = questions[0] as Record<string, unknown> | undefined;
  const question = firstString(first?.question) || firstString(params.question);
  const extra = questions.length > 1 ? ` (+${questions.length - 1})` : "";
  return {
    kind: "clarify",
    title: t.notifyClarifyTitle,
    body: question ? `${flatten(question, 140)}${extra}` : t.clarifyTitle,
    tag,
    sticky: true,
  };
}

/**
 * A finished turn, as a notification.
 *
 * `text` is the reply's own words: the first line of it is usually the answer
 * the human is waiting for, and "Hermes finished" alone tells them nothing.
 */
export function completionNotice(
  result: { title?: string; text?: string; error?: string },
  t: Messages,
  tag: string,
): NotifySpec {
  const error = (result.error ?? "").trim();
  if (error) {
    return {
      kind: "failed",
      title: t.notifyFailedTitle,
      body: flatten(error, 160) || t.notifyFailedTitle,
      tag,
      sticky: false,
    };
  }
  const body = flatten(result.text ?? "", 160);
  const name = (result.title ?? "").trim();
  return {
    kind: "done",
    title: name ? `${t.notifyDoneTitle} · ${name}` : t.notifyDoneTitle,
    body: body || t.notifyDoneTitle,
    tag,
    sticky: false,
  };
}

/**
 * The confirmation toast, fired the moment the switch becomes effective.
 *
 * Without it "did I set this up right?" is unanswerable until a turn happens to
 * finish while the window is in the background — the one moment the user cannot
 * be watching. Proving the path works should not wait for that.
 */
export function testNotice(t: Messages): NotifySpec {
  return {
    kind: "done",
    title: t.notifyTestTitle,
    body: t.notifyTestBody,
    tag: "hb-test",
    sticky: false,
  };
}
