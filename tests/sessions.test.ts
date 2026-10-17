import { beforeEach, describe, expect, it } from "vitest";

import { EventDedupe } from "../src/core/dedupe";
import { resetHistoryIdCounter } from "../src/core/history";
import { resetIdCounter } from "../src/core/reduce";
import {
  ackUserInActive,
  activeTimeline,
  appendUserToActive,
  bindSnapshot,
  closeTab,
  editTargetFor,
  emptyMultiState,
  focus,
  forgetStoredSession,
  openDraft,
  openStored,
  renameTab,
  replaceHistory,
  resetDraftCounter,
  retitleStoredSession,
  routeEvent,
  runningKeys,
  tabKeyFor,
  tabLabel,
  timelineOf,
} from "../src/core/sessions";

beforeEach(() => {
  resetDraftCounter();
  resetIdCounter();
  resetHistoryIdCounter();
});

function event(type: string, payload: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  return { type, payload, ...extra };
}

describe("openDraft", () => {
  it("creates an empty tab and focuses it", () => {
    const state = openDraft(emptyMultiState);
    expect(state.tabs).toHaveLength(1);
    expect(state.tabs[0]).toMatchObject({ title: "新对话", draft: true, runtimeId: null });
    expect(state.activeKey).toBe(state.tabs[0]?.key);
    expect(activeTimeline(state).items).toEqual([]);
  });

  it("opens several independent drafts", () => {
    const state = openDraft(openDraft(emptyMultiState));
    expect(state.tabs).toHaveLength(2);
    expect(new Set(state.tabs.map((t) => t.key)).size).toBe(2);
    // The newest is focused.
    expect(state.activeKey).toBe(state.tabs[1]?.key);
  });
});

describe("bindSnapshot", () => {
  it("renames the tab key to the runtime id and fills the transcript", () => {
    const state = openDraft(emptyMultiState);
    const key = state.tabs[0]!.key;
    const bound = bindSnapshot(state, key, {
      session_id: "rt-1",
      stored_session_id: "20261016_abc",
      messages: [{ role: "user", text: "你好" }],
      info: { model: "m", provider: "p", title: "问候" },
    });

    expect(bound.tabs[0]).toMatchObject({ key: "rt-1", runtimeId: "rt-1", storedId: "20261016_abc", title: "问候", draft: false });
    expect(bound.activeKey).toBe("rt-1");
    expect(timelineOf(bound, "rt-1").items).toHaveLength(1);
    // The old draft key is gone, not orphaned.
    expect(bound.sessions[key]).toBeUndefined();
  });

  it("keeps an optimistic user bubble the snapshot does not have yet", () => {
    const state = appendUserToActive(openDraft(emptyMultiState), "刚发的");
    const key = state.activeKey!;
    const bound = bindSnapshot(state, key, { session_id: "rt-2", messages: [], info: {} }, { keepLocalItems: true });
    const items = timelineOf(bound, "rt-2").items;
    expect(items.some((i) => i.kind === "user" && (i as { text: string }).text === "刚发的")).toBe(true);
  });

  it("drops local items when not asked to keep them", () => {
    const state = appendUserToActive(openDraft(emptyMultiState), "刚发的");
    const bound = bindSnapshot(state, state.activeKey!, { session_id: "rt-3", messages: [], info: {} });
    expect(timelineOf(bound, "rt-3").items).toEqual([]);
  });
});

describe("openStored / focus / close", () => {
  it("adds a tab for a stored session and focuses it", () => {
    const state = openStored(openDraft(emptyMultiState), "20261015_xyz", "旧对话");
    expect(state.tabs).toHaveLength(2);
    expect(state.activeKey).toBe("stored:20261015_xyz");
  });

  it("focuses an already-open stored session instead of duplicating it", () => {
    const first = openStored(openDraft(emptyMultiState), "s1", "旧对话");
    const second = openStored(first, "s1", "旧对话");
    expect(second.tabs).toHaveLength(2);
    expect(second.activeKey).toBe("stored:s1");
  });

  it("switches focus between tabs", () => {
    const state = openDraft(openDraft(emptyMultiState));
    const first = state.tabs[0]!.key;
    expect(focus(state, first).activeKey).toBe(first);
  });

  it("ignores focus on an unknown tab", () => {
    const state = openDraft(emptyMultiState);
    expect(focus(state, "nope")).toBe(state);
  });

  it("closing the active tab falls back to the last remaining one", () => {
    const state = openDraft(openDraft(emptyMultiState));
    const second = state.tabs[1]!.key;
    const closed = closeTab(state, second);
    expect(closed.tabs).toHaveLength(1);
    expect(closed.activeKey).toBe(closed.tabs[0]?.key);
    expect(closed.sessions[second]).toBeUndefined();
  });

  it("closing the last tab leaves no active key", () => {
    const state = openDraft(emptyMultiState);
    expect(closeTab(state, state.activeKey!).activeKey).toBeNull();
  });

  it("closing a background tab keeps the focus where it was", () => {
    const state = openDraft(openDraft(emptyMultiState));
    const first = state.tabs[0]!.key;
    const second = state.tabs[1]!.key;
    const closed = closeTab(state, first);
    expect(closed.activeKey).toBe(second);
  });
});

describe("renameTab", () => {
  it("updates the title", () => {
    const state = renameTab(openDraft(emptyMultiState), openDraft(emptyMultiState).tabs[0]!.key, "x");
    expect(state.tabs).toHaveLength(1);
  });

  it("renames the matching tab", () => {
    const state = openDraft(emptyMultiState);
    const key = state.activeKey!;
    expect(renameTab(state, key, "新标题").tabs[0]?.title).toBe("新标题");
  });
});

describe("routeEvent", () => {
  it("routes a session event to its own tab", () => {
    let state = openDraft(emptyMultiState);
    state = bindSnapshot(state, state.activeKey!, { session_id: "rt-a", messages: [], info: {} });
    state = openDraft(state);
    state = bindSnapshot(state, state.activeKey!, { session_id: "rt-b", messages: [], info: {} });

    const dedupe = new EventDedupe();
    dedupe.setEpoch("e");
    const result = routeEvent(state, event("message.delta", { text: "给A" }, { session_id: "rt-a", seq: 1 }), dedupe);

    expect(result.applied).toBe(true);
    expect(timelineOf(result.state, "rt-a").items).toHaveLength(1);
    // B must be untouched — that is the whole point of per-session routing.
    expect(timelineOf(result.state, "rt-b").items).toHaveLength(0);
  });

  it("drops an event for a session no tab owns", () => {
    let state = openDraft(emptyMultiState);
    state = bindSnapshot(state, state.activeKey!, { session_id: "rt-a", messages: [], info: {} });
    const dedupe = new EventDedupe();
    const result = routeEvent(state, event("message.delta", { text: "别的窗口" }, { session_id: "rt-zzz", seq: 1 }), dedupe);
    expect(result.applied).toBe(false);
    expect(result.state).toBe(state);
  });

  it("applies a global broadcast to the active tab only", () => {
    let state = openDraft(emptyMultiState);
    state = bindSnapshot(state, state.activeKey!, { session_id: "rt-a", messages: [], info: {} });
    state = openDraft(state);
    state = bindSnapshot(state, state.activeKey!, { session_id: "rt-b", messages: [], info: {} });
    // rt-b is the focused tab after opening it.
    expect(state.activeKey).toBe("rt-b");

    const dedupe = new EventDedupe();
    const result = routeEvent(state, event("status.update", { kind: "compacting", text: "压缩中" }), dedupe);

    expect(result.applied).toBe(true);
    expect(timelineOf(result.state, "rt-b").meta.status).toBe("压缩中");
    // A background tab must not inherit the focused tab's status line.
    expect(timelineOf(result.state, "rt-a").meta.status).toBe("");
  });

  it("applies connection frames to every tab", () => {
    let state = openDraft(emptyMultiState);
    state = bindSnapshot(state, state.activeKey!, { session_id: "rt-a", messages: [], info: {} });
    state = openDraft(state);
    state = bindSnapshot(state, state.activeKey!, { session_id: "rt-b", messages: [], info: {} });

    const dedupe = new EventDedupe();
    const result = routeEvent(state, event("gateway.ready", { replay_epoch: "e" }), dedupe);
    expect(timelineOf(result.state, "rt-a").meta.connected).toBe(true);
    expect(timelineOf(result.state, "rt-b").meta.connected).toBe(true);
  });

  it("drops the fan-out copy of a session event", () => {
    let state = openDraft(emptyMultiState);
    state = bindSnapshot(state, state.activeKey!, { session_id: "rt-a", messages: [], info: {} });
    const dedupe = new EventDedupe();
    dedupe.setEpoch("e");
    const frame = { session_id: "rt-a", seq: 7 };

    const first = routeEvent(state, event("message.delta", { text: "一次" }, frame), dedupe);
    const second = routeEvent(first.state, event("message.delta", { text: "一次" }, frame), dedupe);

    expect(first.applied).toBe(true);
    expect(second.applied).toBe(false);
    expect(timelineOf(second.state, "rt-a").items[0]).toMatchObject({ text: "一次" });
  });

  it("applies nothing when there is no active tab", () => {
    const dedupe = new EventDedupe();
    const result = routeEvent(emptyMultiState, event("status.update", { text: "x" }), dedupe);
    expect(result.applied).toBe(false);
  });
});

describe("optimistic user bubbles", () => {
  it("appends to and acks the active tab", () => {
    let state = appendUserToActive(openDraft(emptyMultiState), "你好");
    const key = state.activeKey!;
    expect(timelineOf(state, key).items[0]).toMatchObject({ kind: "user", pending: true });
    state = ackUserInActive(state, 42);
    expect(timelineOf(state, key).items[0]).toMatchObject({ pending: false, rowId: 42 });
  });

  it("is a no-op without an active tab", () => {
    expect(appendUserToActive(emptyMultiState, "x")).toBe(emptyMultiState);
    expect(ackUserInActive(emptyMultiState, 1)).toBe(emptyMultiState);
  });
});

describe("replaceHistory", () => {
  it("swaps in the durable transcript when idle", () => {
    let state = openDraft(emptyMultiState);
    state = bindSnapshot(state, state.activeKey!, { session_id: "rt-a", messages: [], info: {} });
    const key = state.activeKey!;
    const dedupe = new EventDedupe();
    dedupe.setEpoch("e");
    state = routeEvent(state, event("message.delta", { text: "本地" }, { session_id: "rt-a", seq: 1 }), dedupe).state;
    // End the turn: an idle session takes history verbatim, with no live tail.
    state = routeEvent(state, event("message.complete", { text: "", status: "complete" }, { session_id: "rt-a", seq: 2 }), dedupe).state;

    const replaced = replaceHistory(state, key, [
      { role: "user", text: "历史提问" },
      { role: "assistant", text: "历史回答" },
    ]);
    const items = timelineOf(replaced, key).items;
    expect(items.map((i) => (i as { text: string }).text)).toEqual(["历史提问", "历史回答"]);
  });

  it("keeps the streaming tail when a turn is live", () => {
    let state = openDraft(emptyMultiState);
    state = bindSnapshot(state, state.activeKey!, { session_id: "rt-a", messages: [], info: {} });
    const key = state.activeKey!;
    const dedupe = new EventDedupe();
    dedupe.setEpoch("e");
    state = routeEvent(state, event("message.start", {}, { session_id: "rt-a", seq: 1 }), dedupe).state;
    state = routeEvent(state, event("message.delta", { text: "正在写" }, { session_id: "rt-a", seq: 2 }), dedupe).state;

    const replaced = replaceHistory(state, key, [{ role: "user", text: "问题" }]);
    const items = timelineOf(replaced, key).items;
    expect(items[0]).toMatchObject({ text: "问题" });
    expect(items.at(-1)).toMatchObject({ text: "正在写", streaming: true });
  });
});

describe("tab helpers", () => {
  it("keys by runtime id, then stored id, then a fallback", () => {
    expect(tabKeyFor("rt", "st", "fb")).toBe("rt");
    expect(tabKeyFor(null, "st", "fb")).toBe("stored:st");
    expect(tabKeyFor(null, null, "fb")).toBe("fb");
  });

  it("labels a tab by title, falling back to a short stored id", () => {
    expect(tabLabel({ key: "k", runtimeId: null, storedId: null, title: "标题", draft: false })).toBe("标题");
    expect(tabLabel({ key: "k", runtimeId: null, storedId: "20261016_abcdef", title: "新对话", draft: false })).toBe("20261016");
    expect(tabLabel({ key: "k", runtimeId: null, storedId: null, title: "新对话", draft: true })).toBe("新对话");
  });

  it("reports which tabs are running", () => {
    let state = openDraft(emptyMultiState);
    state = bindSnapshot(state, state.activeKey!, { session_id: "rt-a", messages: [], info: { running: true } });
    expect(runningKeys(state)).toEqual(["rt-a"]);
  });
});

describe("edit target", () => {
  const items = [
    { kind: "user", id: "u1", text: "问题一", rowId: 10 },
    { kind: "assistant", id: "a1", text: "答一" },
    { kind: "user", id: "u2", text: "问题二", rowId: 20 },
    { kind: "assistant", id: "a2", text: "答二" },
    { kind: "user", id: "u3", text: "问题三" },
  ];

  it("finds the user turn and its durable row", () => {
    expect(editTargetFor(items, "u2")).toEqual({
      itemId: "u2",
      text: "问题二",
      rowId: 20,
      userTurnsRemoved: 2,
    });
  });

  it("reports a missing durable row rather than inventing one", () => {
    // u3 never learned a row id: the gateway fails such a cut closed, so the
    // caller must refuse instead of sending it.
    expect(editTargetFor(items, "u3")?.rowId).toBeNull();
  });

  it("counts the user turns the cut removes", () => {
    expect(editTargetFor(items, "u1")?.userTurnsRemoved).toBe(3);
    expect(editTargetFor(items, "u3")?.userTurnsRemoved).toBe(1);
  });

  it("refuses a non-user item or an unknown id", () => {
    expect(editTargetFor(items, "a1")).toBeNull();
    expect(editTargetFor(items, "nope")).toBeNull();
  });
});

describe("stored-session bookkeeping", () => {
  const tabs = [
    { key: "k1", storedId: "s1", title: "一" },
    { key: "k2", storedId: "s2", title: "二" },
    { key: "k3", storedId: null, title: "" },
  ];

  it("drops every tab holding the deleted session", () => {
    expect(forgetStoredSession(tabs, "k1", "s1").tabs.map((t) => t.key)).toEqual(["k2", "k3"]);
  });

  it("moves focus when the active tab is the one deleted", () => {
    expect(forgetStoredSession(tabs, "k1", "s1").activeKey).toBe("k2");
  });

  it("keeps focus when a different tab is deleted", () => {
    expect(forgetStoredSession(tabs, "k2", "s1").activeKey).toBe("k2");
  });

  it("retitles only the matching tab", () => {
    const next = retitleStoredSession(tabs, "s2", "新");
    expect(next.find((t) => t.key === "k2")?.title).toBe("新");
    expect(next.find((t) => t.key === "k1")?.title).toBe("一");
  });

  it("leaves the list untouched for an unknown stored id", () => {
    expect(retitleStoredSession(tabs, "zzz", "新")).toEqual(tabs);
  });
});
