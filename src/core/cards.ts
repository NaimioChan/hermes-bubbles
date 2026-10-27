/**
 * Which session a pending approval / clarify card belongs to.
 *
 * A socket carries every session's events *and* every session's server→client
 * requests, so `approval` / `clarify` frames arrive tagged only with
 * `params.session_id`. The page kept them in one flat list and rendered that list
 * in whichever transcript happened to be focused — which put a question asked by
 * session A into session B's bubble stream, complete with the answer buttons.
 * It looked like B was blocked, and answering there was the wrong conversation.
 *
 * The card therefore carries the runtime id it arrived with, and the transcript
 * asks this module which cards it may draw. Ownership is resolved against the
 * CURRENT tab list rather than frozen at arrival: a tab's key changes from
 * `stored:<id>` to the runtime id when it resumes, and a frozen key would orphan
 * the card.
 *
 * A card whose session has no open tab (the tab was closed, or another window
 * opened that session) still has to be answerable — the backend is blocking on
 * it, and `-32601`-ing a request nobody can see strands the turn (AGENTS.md 铁律 7).
 * Those render in the focused transcript only, one place at a time, instead of
 * in every tab.
 *
 * Pure data, no DOM (AGENTS.md 铁律 1).
 */

import type { MultiState } from "./sessions";

/** The minimum a card must expose to be placed: its identity and its session. */
export interface SessionScopedCard {
  id: string;
  /** Runtime session id from `params.session_id`; "" when the frame carried none. */
  sessionId: string;
}

/** The tab key that owns `sessionId`, or null when no open tab does. */
export function ownerKeyOf(state: MultiState, sessionId: string): string | null {
  if (!sessionId) return null;
  const tab = state.tabs.find((candidate) => candidate.runtimeId === sessionId);
  return tab?.key ?? null;
}

/**
 * Cards the transcript of `tabKey` may draw.
 *
 * `tabKey` is the transcript actually on screen. Owned cards appear only in
 * their own session's transcript; unowned ones only in the active one, so a
 * request is reachable from exactly one place.
 *
 * With no tab open there is no "somewhere else" to put a card, and the backend
 * is still blocked on it (铁律 7 / 21: the closed-tab state is not a dead page),
 * so everything is drawn in the single empty transcript.
 */
export function cardsForTab<C extends SessionScopedCard>(
  state: MultiState,
  cards: readonly C[],
  tabKey: string | null,
): C[] {
  if (!tabKey) return [...cards];
  return cards.filter((card) => {
    const owner = ownerKeyOf(state, card.sessionId);
    if (owner === null) return tabKey === state.activeKey;
    return owner === tabKey;
  });
}

/**
 * Tab keys with a card waiting for an answer, for the tab strip's marker.
 *
 * This is how a question asked in a background session gets noticed without
 * yanking the reader out of the session they are watching.
 */
export function waitingKeys<C extends SessionScopedCard>(
  state: MultiState,
  cards: readonly C[],
): string[] {
  const keys: string[] = [];
  for (const card of cards) {
    const owner = ownerKeyOf(state, card.sessionId);
    if (owner !== null && !keys.includes(owner)) keys.push(owner);
  }
  return keys;
}

/**
 * The two "this card is gone" frames, as ids to drop.
 *
 * Two different events mean the same thing to the UI, and a card left on screen
 * is not cosmetic: it keeps offering buttons for a request whose wait already
 * returned, so the human answers into nothing.
 *
 *   `request.cancel`      → `{id, method, reason}`, per-session, top-level
 *                           `session_id` set (interrupt, timeout, session close)
 *   `approval.cancelled`  → a GLOBAL broadcast (`session_id` is "" at the top
 *                           level), with the dropped ids in
 *                           `payload.request_ids` and the session in
 *                           `payload.session_id`
 *
 * Anything else yields an empty list.
 */
export interface CardWithdrawal {
  id: string;
  reason: string;
  sessionId: string;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function withdrawalsFrom(event: {
  type: string;
  session_id?: string;
  payload?: Record<string, unknown>;
}): CardWithdrawal[] {
  const payload = (event.payload ?? {}) as Record<string, unknown>;
  const reason = str(payload.reason);
  if (event.type === "request.cancel") {
    const id = str(payload.id);
    return id ? [{ id, reason, sessionId: str(event.session_id) || str(payload.session_id) }] : [];
  }
  if (event.type === "approval.cancelled") {
    const ids = Array.isArray(payload.request_ids) ? payload.request_ids : [];
    const sessionId = str(payload.session_id);
    return ids
      .filter((id): id is string => typeof id === "string" && id.length > 0)
      .map((id) => ({ id, reason, sessionId }));
  }
  return [];
}

/** Whether this frame type withdraws cards, so the caller can skip `routeEvent`. */
export function isWithdrawalEvent(type: string): boolean {
  return type === "request.cancel" || type === "approval.cancelled";
}

/** Drop withdrawn cards from a list. */
export function withoutWithdrawn<C extends { id: string }>(
  cards: readonly C[],
  withdrawals: readonly CardWithdrawal[],
): C[] {
  if (!withdrawals.length) return cards as C[];
  const gone = new Set(withdrawals.map((withdrawal) => withdrawal.id));
  const kept = cards.filter((card) => !gone.has(card.id));
  return kept.length === cards.length ? (cards as C[]) : kept;
}

/** Whether this session is the one holding a card — for the tab's tooltip/aria. */
export function isWaiting(waiting: readonly string[], key: string): boolean {
  return waiting.includes(key);
}
