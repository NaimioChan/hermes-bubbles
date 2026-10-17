/**
 * Multi-session state.
 *
 * One socket carries every session's events, tagged by `session_id`. This store
 * keeps a timeline per session, decides which one is focused, and routes each
 * event to the right timeline — so "multiple sessions open at once" costs one
 * socket rather than one connection each.
 *
 * Pure state: no socket, no React. The controller owns the transport and calls
 * into this.
 */

import { EventDedupe } from "./dedupe";
import { projectHistory, timelineFromSnapshot, type LiveSessionSnapshot } from "./history";
import { ackUser, appendUser, reduceEvent, settleTimeline, type GatewayEvent } from "./reduce";
import { emptyMeta, type Timeline } from "./types";

export interface SessionTab {
  /** Runtime id once known; `draft:<n>` before the backend mints one. */
  key: string;
  /** Runtime id, null while the session is still a draft. */
  runtimeId: string | null;
  /** Stored id, for `session.resume`. */
  storedId: string | null;
  title: string;
  /** A draft has no backend session yet; the first send creates one. */
  draft: boolean;
}

export interface MultiState {
  sessions: Record<string, Timeline>;
  tabs: SessionTab[];
  activeKey: string | null;
}

export const emptyMultiState: MultiState = { sessions: {}, tabs: [], activeKey: null };

/** Key for a tab. Runtime id when live, else a stable draft key. */
export function tabKeyFor(runtimeId: string | null, storedId: string | null, fallback: string): string {
  return runtimeId ?? (storedId ? `stored:${storedId}` : fallback);
}

let draftCounter = 0;
export function nextDraftKey(): string {
  draftCounter += 1;
  return `draft:${draftCounter}`;
}

/** Test hook. */
export function resetDraftCounter(): void {
  draftCounter = 0;
}

export function timelineOf(state: MultiState, key: string | null): Timeline {
  if (!key) return { items: [], meta: { ...emptyMeta } };
  return state.sessions[key] ?? { items: [], meta: { ...emptyMeta } };
}

export function activeTimeline(state: MultiState): Timeline {
  return timelineOf(state, state.activeKey);
}

function withTimeline(state: MultiState, key: string, timeline: Timeline): MultiState {
  return { ...state, sessions: { ...state.sessions, [key]: timeline } };
}

export function openDraft(state: MultiState): MultiState {
  const key = nextDraftKey();
  const tab: SessionTab = { key, runtimeId: null, storedId: null, title: "新对话", draft: true };
  return {
    sessions: { ...state.sessions, [key]: { items: [], meta: { ...emptyMeta } } },
    tabs: [...state.tabs, tab],
    activeKey: key,
  };
}

/**
 * Bind a backend snapshot to a tab.
 *
 * The tab's key changes from `draft:N` to the runtime id once the backend mints
 * one, so the timeline is moved rather than re-keyed in place.
 */
export function bindSnapshot(
  state: MultiState,
  key: string,
  snapshot: LiveSessionSnapshot,
  options: { keepLocalItems?: boolean; connected?: boolean } = {},
): MultiState {
  const timeline = timelineFromSnapshot(snapshot);
  const runtimeId = snapshot.session_id ?? null;
  const nextKey = runtimeId ?? key;

  const existing = state.sessions[key];
  // A draft that already streamed (or whose user bubble is optimistic) keeps
  // those items: the snapshot has no rows for them yet.
  const items =
    options.keepLocalItems && existing ? [...timeline.items, ...existing.items.filter((i) => i.kind === "user")] : timeline.items;

  const sessions = { ...state.sessions };
  if (nextKey !== key) delete sessions[key];
  // The connection flag describes the socket, not the session: take it from the
  // caller when given, else from whichever timeline already knew.
  const connected = options.connected ?? existing?.meta.connected ?? timeline.meta.connected;
  sessions[nextKey] = {
    items,
    // A snapshot without `todo_state` must not wipe the live list the panel is
    // already showing: the resume response only carries one when the backend
    // has a stored snapshot.
    meta: { ...timeline.meta, connected, todo: timeline.meta.todo ?? existing?.meta.todo ?? null },
  };

  const tabs = state.tabs.map((tab) =>
    tab.key === key
      ? {
          ...tab,
          key: nextKey,
          runtimeId,
          storedId: snapshot.stored_session_id ?? tab.storedId,
          title: timeline.meta.title || tab.title,
          draft: false,
        }
      : tab,
  );

  return {
    sessions,
    tabs,
    activeKey: state.activeKey === key ? nextKey : state.activeKey,
  };
}

/** Attach to an existing stored session as a new tab (or focus it if already open). */
export function openStored(state: MultiState, storedId: string, title: string): MultiState {
  const key = `stored:${storedId}`;
  const existing = state.tabs.find((tab) => tab.storedId === storedId);
  if (existing) return { ...state, activeKey: existing.key };
  return {
    sessions: { ...state.sessions, [key]: { items: [], meta: { ...emptyMeta } } },
    tabs: [...state.tabs, { key, runtimeId: null, storedId, title, draft: false }],
    activeKey: key,
  };
}

export function focus(state: MultiState, key: string): MultiState {
  if (!state.tabs.some((tab) => tab.key === key)) return state;
  return { ...state, activeKey: key };
}

export function closeTab(state: MultiState, key: string): MultiState {
  const tabs = state.tabs.filter((tab) => tab.key !== key);
  const sessions = { ...state.sessions };
  delete sessions[key];
  let activeKey = state.activeKey;
  if (activeKey === key) {
    activeKey = tabs.length ? (tabs[tabs.length - 1]?.key ?? null) : null;
  }
  return { sessions, tabs, activeKey };
}

export function renameTab(state: MultiState, key: string, title: string): MultiState {
  return { ...state, tabs: state.tabs.map((tab) => (tab.key === key ? { ...tab, title } : tab)) };
}

export interface RouteResult {
  state: MultiState;
  /** True when the event was applied (the caller may want to know for tests). */
  applied: boolean;
}

/**
 * Route one gateway event into the timeline that owns it.
 *
 * Filtering rules, in order:
 * - `gateway.ready` / connection frames are session-less and go to every tab
 *   (they carry the connection state, which is not per-session).
 * - An event with a `session_id` we have no tab for is dropped: it belongs to
 *   another window's session, and the socket sees all of them.
 * - An event with no `session_id` is a global broadcast; apply it to the active
 *   timeline only, so one status line does not appear in every tab.
 */
export function routeEvent(
  state: MultiState,
  event: GatewayEvent,
  dedupe: EventDedupe,
): RouteResult {
  const isConnectionFrame = event.type === "gateway.ready" || event.type === "gateway.closed";

  if (isConnectionFrame) {
    const sessions: Record<string, Timeline> = {};
    for (const [key, timeline] of Object.entries(state.sessions)) {
      sessions[key] = reduceEvent(timeline, event);
    }
    return { state: { ...state, sessions }, applied: true };
  }

  if (event.session_id) {
    const key = state.tabs.find((tab) => tab.runtimeId === event.session_id)?.key;
    if (!key) return { state, applied: false };
    if (!dedupe.admit({ session_id: event.session_id, seq: event.seq, replayEpoch: event.replayEpoch })) {
      return { state, applied: false };
    }
    const timeline = timelineOf(state, key);
    const next = reduceEvent(timeline, event);
    if (next === timeline) return { state, applied: false };
    return { state: withTimeline(state, key, next), applied: true };
  }

  const key = state.activeKey;
  if (!key) return { state, applied: false };
  const timeline = timelineOf(state, key);
  const next = reduceEvent(timeline, event);
  if (next === timeline) return { state, applied: false };
  return { state: withTimeline(state, key, next), applied: true };
}

/** Optimistically append the user's message to the active tab. */
export function appendUserToActive(state: MultiState, text: string): MultiState {
  const key = state.activeKey;
  if (!key) return state;
  return withTimeline(state, key, appendUser(timelineOf(state, key), text));
}

export function ackUserInActive(state: MultiState, rowId: number | undefined): MultiState {
  const key = state.activeKey;
  if (!key) return state;
  return withTimeline(state, key, ackUser(timelineOf(state, key), rowId));
}

export function settleActive(state: MultiState, note?: string): MultiState {
  const key = state.activeKey;
  if (!key) return state;
  return withTimeline(state, key, settleTimeline(timelineOf(state, key), note));
}

/** Replace a tab's transcript with freshly read history, keeping any live tail. */
export function replaceHistory(
  state: MultiState,
  key: string,
  messages: Parameters<typeof projectHistory>[0],
): MultiState {
  const timeline = timelineOf(state, key);
  const restored = projectHistory(messages);
  const tail: typeof restored = [];
  if (timeline.meta.running) {
    for (let i = timeline.items.length - 1; i >= 0; i -= 1) {
      const item = timeline.items[i];
      if (item && item.kind === "assistant" && item.streaming) {
        tail.push(...timeline.items.slice(i));
        break;
      }
    }
  }
  return withTimeline(state, key, { items: [...restored, ...tail], meta: timeline.meta });
}

/** Total unread-ish signal: any tab other than the active one that is running. */
export function runningKeys(state: MultiState): string[] {
  return Object.entries(state.sessions)
    .filter(([, timeline]) => timeline.meta.running)
    .map(([key]) => key);
}

/** A tab label: the title, or a short id when the backend has not titled it. */
export function tabLabel(tab: SessionTab): string {
  if (tab.title && tab.title !== "新对话") return tab.title;
  if (tab.storedId) return tab.storedId.slice(0, 8);
  return tab.title || "新对话";
}

/**
 * The turn an edit would rewrite.
 *
 * Editing message N means: drop message N and everything after it, then re-send
 * the corrected text. The cut is addressed by `truncate_before_row_id`, which
 * must be the DURABLE row id — a target without one cannot be cut server-side
 * (the gateway fails closed rather than guessing), so it is refused here instead
 * of producing a confusing partial edit.
 */
export interface EditTarget {
  /** The user item being edited. */
  itemId: string;
  /** Its text, as the composer should show it. */
  text: string;
  /** Durable row id of THAT user row, when the backend has told us one. */
  rowId: number | null;
  /** How many user turns the cut would remove (for the deep-truncate warning). */
  userTurnsRemoved: number;
}

export function editTargetFor(
  items: readonly { kind: string; id: string; text?: string; rowId?: number }[],
  itemId: string,
): EditTarget | null {
  const index = items.findIndex((item) => item.id === itemId);
  if (index < 0) return null;
  const target = items[index];
  if (!target || target.kind !== "user") return null;

  let userTurnsRemoved = 0;
  for (let i = index; i < items.length; i += 1) {
    if (items[i]?.kind === "user") userTurnsRemoved += 1;
  }

  return {
    itemId,
    text: target.text ?? "",
    rowId: typeof target.rowId === "number" ? target.rowId : null,
    userTurnsRemoved,
  };
}

/** Delete a stored session from the open tabs first, so no tab is left orphaned. */
export function forgetStoredSession<T extends { key: string; storedId: string | null }>(
  tabs: readonly T[],
  activeKey: string | null,
  storedId: string,
): { tabs: T[]; activeKey: string | null } {
  const remaining = tabs.filter((tab) => tab.storedId !== storedId);
  const stillActive = remaining.some((tab) => tab.key === activeKey);
  return {
    tabs: remaining,
    activeKey: stillActive ? activeKey : (remaining[0]?.key ?? null),
  };
}

/** Retitle a stored session wherever it is open. */
export function retitleStoredSession<T extends { storedId: string | null; title: string }>(
  tabs: readonly T[],
  storedId: string,
  title: string,
): T[] {
  return tabs.map((tab) => (tab.storedId === storedId ? { ...tab, title } : tab));
}
