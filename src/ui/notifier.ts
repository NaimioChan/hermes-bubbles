/**
 * The DOM half of desktop notifications.
 *
 * All policy lives in `src/core/notify.ts`; this file only talks to the browser:
 * read the permission, ask for it on a user gesture, decide whether the page is
 * in the background, and construct the `Notification`.
 *
 * The dashboard is served from `http://127.0.0.1`, which is a secure context, so
 * the Notification API is available without TLS. A frame that blocks it (a
 * sandboxed embed) degrades to "no notification", never to a thrown error.
 */

import { messagesFor, type Locale } from "../core/i18n";
import {
  completionNotice,
  NOTIFY_STORAGE_KEY,
  requestNotice,
  shouldNotify,
  storedEnabled,
  testNotice,
  type NotificationPermissionKind,
  type NotifySpec,
  type TurnNotice,
} from "../core/notify";

export function notificationSupported(): boolean {
  return typeof window !== "undefined" && "Notification" in window;
}

export function notificationPermission(): NotificationPermissionKind {
  if (!notificationSupported()) return "denied";
  return window.Notification.permission as NotificationPermissionKind;
}

/**
 * Ask for permission. Must be called from a user gesture (a click, a send) —
 * browsers ignore or auto-deny a prompt opened on page load.
 */
export async function requestNotificationPermission(): Promise<NotificationPermissionKind> {
  if (!notificationSupported()) return "denied";
  const current = notificationPermission();
  if (current !== "default") return current;
  try {
    return (await window.Notification.requestPermission()) as NotificationPermissionKind;
  } catch {
    return "denied";
  }
}

export function notifyEnabled(): boolean {
  try {
    return storedEnabled(window.localStorage.getItem(NOTIFY_STORAGE_KEY));
  } catch {
    return true;
  }
}

export function setNotifyEnabled(enabled: boolean): void {
  try {
    window.localStorage.setItem(NOTIFY_STORAGE_KEY, enabled ? "on" : "off");
  } catch {
    // A blocked storage still leaves the switch working for this session.
  }
}

/**
 * "Not in front of the page": a hidden tab, or a visible one that does not have
 * focus (another application is on top). `hasFocus` is what tells those apart —
 * `visibilityState` stays `visible` when the window is merely covered.
 */
export function windowBackgrounded(): boolean {
  if (typeof document === "undefined") return false;
  if (document.visibilityState === "hidden") return true;
  return !document.hasFocus();
}

/** Turn a controller notice into a notification body, in the current language. */
export function specFor(notice: TurnNotice, locale: Locale): NotifySpec {
  const t = messagesFor(locale);
  if (notice.kind === "request") {
    const method = notice.method === "clarify" ? "clarify" : "approval";
    const tag = `hb-request-${notice.requestId ?? notice.sessionKey}`;
    return requestNotice(method, notice.params ?? {}, t, tag);
  }
  return completionNotice(
    { title: notice.title, text: notice.text, error: notice.error },
    t,
    `hb-turn-${notice.sessionKey}`,
  );
}

export function raiseNotification(spec: NotifySpec): void {
  if (!notificationSupported()) return;
  try {
    const notification = new window.Notification(spec.title, {
      body: spec.body,
      tag: spec.tag,
      // A request the agent is blocked on stays put; a finished turn does not
      // need to be dismissed by hand.
      requireInteraction: spec.sticky,
    });
    notification.onclick = () => {
      try {
        window.focus();
      } finally {
        notification.close();
      }
    };
  } catch {
    // Some environments refuse construction without a service worker; silence is
    // the correct failure here, since the in-page card still shows the request.
  }
}

/**
 * Prove the path works, on demand.
 *
 * Called the moment the switch becomes effective, so "notifications are on"
 * is something the user has seen rather than something the panel claims.
 */
export function raiseTestNotification(locale: Locale): void {
  raiseNotification(testNotice(messagesFor(locale)));
}

/** The whole decision, in one place for the page's sink. */
export function maybeNotify(notice: TurnNotice, locale: Locale): void {
  const gate = {
    enabled: notifyEnabled(),
    permission: notificationPermission(),
    background: windowBackgrounded(),
  };
  if (!shouldNotify(gate)) return;
  raiseNotification(specFor(notice, locale));
}
