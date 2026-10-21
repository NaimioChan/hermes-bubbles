import { describe, expect, it } from "vitest";

import {
  atBottom,
  distanceFromBottom,
  followAfterChange,
  pinAfterScroll,
  pinnedState,
  RELEASE_INTENT_PX,
  STICK_SLACK_PX,
  type PinState,
  type ScrollMetrics,
} from "../src/core/pin";

/** A transcript 2000px tall in an 800px viewport: 1200px of scroll range. */
function metrics(scrollTop: number, scrollHeight = 2000, clientHeight = 800): ScrollMetrics {
  return { scrollTop, scrollHeight, clientHeight };
}

const BOTTOM = 1200;

describe("pin: geometry", () => {
  it("measures the gap below the viewport", () => {
    expect(distanceFromBottom(metrics(BOTTOM))).toBe(0);
    expect(distanceFromBottom(metrics(0))).toBe(1200);
    expect(distanceFromBottom(metrics(BOTTOM - 300))).toBe(300);
  });

  it("treats content shorter than the viewport as pinned", () => {
    // No scroll range at all: nothing to be away from.
    expect(distanceFromBottom(metrics(0, 400, 800))).toBe(0);
  });

  it("clamps a scrollTop the browser reported outside the range", () => {
    // Elastic overscroll reports a negative or over-range value on some
    // platforms; a negative gap would read as pinned from anywhere.
    expect(distanceFromBottom(metrics(-40))).toBe(1200);
    expect(distanceFromBottom(metrics(BOTTOM + 999))).toBe(0);
  });

  it("counts a few pixels of slack as the bottom", () => {
    expect(atBottom(metrics(BOTTOM - STICK_SLACK_PX))).toBe(true);
    expect(atBottom(metrics(BOTTOM - STICK_SLACK_PX - 1))).toBe(false);
  });
});

describe("pin: the reader's intent", () => {
  it("keeps following while the reader stays at the bottom", () => {
    const state = pinAfterScroll(metrics(BOTTOM), pinnedState);
    expect(state.released).toBe(false);
    expect(followAfterChange(metrics(BOTTOM), state).decision).toBe("follow");
  });

  it("follows even when a long reply leaves the bottom far away", () => {
    // The regression this guards: a reply that grows past the viewport puts the
    // bottom out of reach on its own, and stopping the follow there would leave
    // the reader watching the top of a bubble they are trying to read.
    const grown = metrics(BOTTOM, 9000);
    expect(followAfterChange(grown, pinnedState).decision).toBe("follow");
  });

  it("stops following after the reader scrolls up", () => {
    const scrolledUp = pinAfterScroll(metrics(100), { lastTop: 900, released: false });
    expect(scrolledUp.released).toBe(true);
    expect(followAfterChange(metrics(100), scrolledUp).decision).toBe("hold");
  });

  it("does not stop for a nudge smaller than the intent threshold", () => {
    const state = pinAfterScroll(metrics(900 - RELEASE_INTENT_PX), { lastTop: 900, released: false });
    expect(state.released).toBe(false);
  });

  it("does not mistake content growth for a scroll", () => {
    // Growing content leaves `scrollTop` alone, so a change handler that follows
    // to the bottom and then reports the same `scrollTop` must not read as an
    // upward move.
    const state: PinState = { lastTop: 0, released: false };
    const afterChange = followAfterChange(metrics(0, 4000), state);
    expect(afterChange.state.released).toBe(false);
    expect(pinAfterScroll(metrics(0, 4000), afterChange.state).released).toBe(false);
  });

  it("re-arms the follow when the reader returns to the bottom", () => {
    const released: PinState = { lastTop: 100, released: true };
    const back = pinAfterScroll(metrics(BOTTOM), released);
    expect(back.released).toBe(false);
    expect(followAfterChange(metrics(BOTTOM), back).decision).toBe("follow");
  });

  it("stays released across further content changes", () => {
    let state: PinState = pinAfterScroll(metrics(100), { lastTop: 900, released: false });
    for (const height of [2500, 3000, 6000]) {
      const next = followAfterChange(metrics(100, height), state);
      expect(next.decision).toBe("hold");
      state = next.state;
    }
    expect(state.released).toBe(true);
  });

  it("reads an upward move in a content change as intent too", () => {
    // The scroll event for a wheel move is dispatched after the delta that
    // caused the render, so the change handler can be the first to see the move.
    // Scrolling to the bottom there would undo it before the pin ever heard.
    const state: PinState = { lastTop: 900, released: false };
    const next = followAfterChange(metrics(200), state);
    expect(next.state.released).toBe(true);
    expect(next.decision).toBe("hold");
  });

  it("records where the view actually is, so the next move is measured against it", () => {
    // A stale `lastTop` is what made a settled view look like a fresh scroll on
    // every render, releasing the follow for a reader who had not moved.
    const followed = followAfterChange(metrics(BOTTOM - 500), pinnedState);
    expect(followed.decision).toBe("follow");
    expect(followed.state.lastTop).toBe(BOTTOM - 500);
    // No move since: still following.
    expect(followAfterChange(metrics(BOTTOM - 500), followed.state).decision).toBe("follow");
  });
});
