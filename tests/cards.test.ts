import { describe, expect, it } from "vitest";

import {
  cardsForTab,
  isWithdrawalEvent,
  isWaiting,
  ownerKeyOf,
  waitingKeys,
  withdrawalsFrom,
  withoutWithdrawn,
} from "../src/core/cards";
import { emptyMultiState, type MultiState } from "../src/core/sessions";

/**
 * One socket carries every session's `approval` / `clarify` frames, tagged only
 * by `params.session_id`. The bug these cover: the page kept all cards in one
 * flat list and drew it in whichever transcript was focused, so a question asked
 * by session A appeared in session B — and answering it there answered A's card
 * while the reader believed they were steering B.
 */

function stateOf(tabs: { key: string; runtimeId: string | null }[], activeKey: string): MultiState {
  return {
    ...emptyMultiState,
    tabs: tabs.map((tab) => ({
      key: tab.key,
      runtimeId: tab.runtimeId,
      storedId: null,
      title: tab.key,
      draft: false,
    })),
    activeKey,
  };
}

const card = (id: string, sessionId: string) => ({ id, sessionId });

describe("card ownership", () => {
  it("resolves a session to the tab that holds its runtime id", () => {
    const state = stateOf(
      [
        { key: "runtime-a", runtimeId: "runtime-a" },
        { key: "runtime-b", runtimeId: "runtime-b" },
      ],
      "runtime-a",
    );
    expect(ownerKeyOf(state, "runtime-b")).toBe("runtime-b");
    expect(ownerKeyOf(state, "runtime-zzz")).toBeNull();
    expect(ownerKeyOf(state, "")).toBeNull();
  });

  it("draws a card only in its own session's transcript", () => {
    const state = stateOf(
      [
        { key: "runtime-a", runtimeId: "runtime-a" },
        { key: "runtime-b", runtimeId: "runtime-b" },
      ],
      "runtime-b",
    );
    const cards = [card("c1", "runtime-a"), card("c2", "runtime-b")];

    // B is focused; A's question must NOT appear there.
    expect(cardsForTab(state, cards, "runtime-b").map((c) => c.id)).toEqual(["c2"]);
    expect(cardsForTab(state, cards, "runtime-a").map((c) => c.id)).toEqual(["c1"]);
  });

  it("follows a tab whose key changes when a stored session resumes", () => {
    // A tab opens as `stored:<id>` and its key becomes the runtime id once
    // `session.resume` answers. A card that arrives before the answer has no
    // owner yet (drawn in the focused tab); afterwards it binds to that tab and
    // stops being drawn anywhere else.
    const before = stateOf([{ key: "stored:20261026_1", runtimeId: null }], "stored:20261026_1");
    const after = stateOf(
      [
        { key: "runtime-a", runtimeId: "runtime-a" },
        { key: "runtime-b", runtimeId: "runtime-b" },
      ],
      "runtime-b",
    );
    const cards = [card("c1", "runtime-a")];
    expect(ownerKeyOf(before, "runtime-a")).toBeNull();
    expect(ownerKeyOf(after, "runtime-a")).toBe("runtime-a");
    // The binding is what keeps it out of the OTHER tab once ownership is known.
    expect(cardsForTab(after, cards, "runtime-a")).toHaveLength(1);
    expect(cardsForTab(after, cards, "runtime-b")).toHaveLength(0);
  });

  it("keeps an unowned card reachable in the focused transcript only", () => {
    // The tab was closed, or another window opened that session. The backend is
    // still blocking on it, so refusing it would strand the turn (铁律 7) — but
    // it must not be drawn in every open tab either.
    const state = stateOf(
      [
        { key: "runtime-a", runtimeId: "runtime-a" },
        { key: "runtime-b", runtimeId: "runtime-b" },
      ],
      "runtime-a",
    );
    const cards = [card("orphan", "runtime-closed")];
    expect(cardsForTab(state, cards, "runtime-a").map((c) => c.id)).toEqual(["orphan"]);
    expect(cardsForTab(state, cards, "runtime-b")).toHaveLength(0);
  });

  it("keeps every card answerable when the user closed all tabs", () => {
    // 铁律 21: with no tab open the active timeline is a placeholder, and the
    // backend is still blocked on any open request. Hiding cards there would
    // strand the turn; there is no other transcript to put them in.
    const state = stateOf([], null as unknown as string);
    const cards = [card("c1", "runtime-a"), card("c2", "runtime-b")];
    expect(cardsForTab({ ...state, activeKey: null }, cards, null).map((c) => c.id)).toEqual(["c1", "c2"]);
  });
});

describe("waiting markers", () => {
  it("lists the tabs that have a question waiting, once each", () => {
    const state = stateOf(
      [
        { key: "runtime-a", runtimeId: "runtime-a" },
        { key: "runtime-b", runtimeId: "runtime-b" },
      ],
      "runtime-a",
    );
    const cards = [card("c1", "runtime-b"), card("c2", "runtime-b")];
    expect(waitingKeys(state, cards)).toEqual(["runtime-b"]);
    expect(isWaiting(waitingKeys(state, cards), "runtime-b")).toBe(true);
    expect(isWaiting(waitingKeys(state, cards), "runtime-a")).toBe(false);
  });

  it("marks nothing for a card whose session has no tab", () => {
    const state = stateOf([{ key: "runtime-a", runtimeId: "runtime-a" }], "runtime-a");
    expect(waitingKeys(state, [card("orphan", "runtime-closed")])).toEqual([]);
  });
});

describe("withdrawals", () => {
  it("reads a per-session request.cancel", () => {
    const out = withdrawalsFrom({
      type: "request.cancel",
      session_id: "runtime-a",
      payload: { id: "srq-1", method: "clarify", reason: "interrupted" },
    });
    expect(out).toEqual([{ id: "srq-1", reason: "interrupted", sessionId: "runtime-a" }]);
  });

  it("reads the ids out of a global approval.cancelled broadcast", () => {
    // This one is broadcast with an empty top-level `session_id`; the session and
    // the ids both live in the payload.
    const out = withdrawalsFrom({
      type: "approval.cancelled",
      payload: {
        session_id: "runtime-a",
        stored_session_id: "20261026_1",
        reason: "interrupt",
        cancelled_count: 2,
        request_ids: ["srq-1", "srq-2"],
      },
    });
    expect(out.map((w) => w.id)).toEqual(["srq-1", "srq-2"]);
    expect(out.every((w) => w.sessionId === "runtime-a")).toBe(true);
  });

  it("ignores frames that carry no usable id", () => {
    expect(withdrawalsFrom({ type: "request.cancel", payload: {} })).toEqual([]);
    expect(withdrawalsFrom({ type: "approval.cancelled", payload: { request_ids: [1, "", null] } })).toEqual([]);
    expect(withdrawalsFrom({ type: "message.delta", payload: { id: "srq-1" } })).toEqual([]);
  });

  it("knows which event types withdraw cards", () => {
    expect(isWithdrawalEvent("request.cancel")).toBe(true);
    expect(isWithdrawalEvent("approval.cancelled")).toBe(true);
    expect(isWithdrawalEvent("approval.settled")).toBe(false);
    expect(isWithdrawalEvent("message.complete")).toBe(false);
  });

  it("drops the withdrawn cards and keeps the rest", () => {
    const cards = [card("c1", "runtime-a"), card("c2", "runtime-a")];
    const kept = withoutWithdrawn(cards, [{ id: "c1", reason: "timeout", sessionId: "runtime-a" }]);
    expect(kept.map((c) => c.id)).toEqual(["c2"]);
  });

  it("returns the same array when nothing matches, so React can skip the render", () => {
    const cards = [card("c1", "runtime-a")];
    expect(withoutWithdrawn(cards, [])).toBe(cards);
    expect(withoutWithdrawn(cards, [{ id: "nope", reason: "", sessionId: "" }])).toBe(cards);
  });
});
