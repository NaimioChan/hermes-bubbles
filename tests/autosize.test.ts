import { describe, expect, it } from "vitest";

import { fitComposerHeight } from "../src/core/autosize";

const LIMITS = { min: 32, max: 192 };

describe("composer autosize", () => {
  it("grows to the text's own height while it fits", () => {
    expect(fitComposerHeight(54, LIMITS)).toEqual({ height: 54, scrolls: false });
  });

  it("never goes below one row", () => {
    // An empty box reports a scrollHeight of one line minus padding on some
    // platforms; collapsing to it would clip the text on the next keystroke.
    expect(fitComposerHeight(18, LIMITS)).toEqual({ height: 32, scrolls: false });
  });

  it("stops at the cap and starts scrolling instead of growing", () => {
    expect(fitComposerHeight(400, LIMITS)).toEqual({ height: 192, scrolls: true });
    // Exactly at the cap is not yet "scrolling".
    expect(fitComposerHeight(192, LIMITS)).toEqual({ height: 192, scrolls: false });
  });

  it("rounds a fractional measurement up, so the last line is never clipped", () => {
    expect(fitComposerHeight(54.2, LIMITS).height).toBe(55);
  });

  it("treats an unmeasurable element as one row", () => {
    // `scrollHeight` is 0 on a hidden or not-yet-laid-out element.
    expect(fitComposerHeight(0, LIMITS)).toEqual({ height: 32, scrolls: false });
    expect(fitComposerHeight(Number.NaN, LIMITS)).toEqual({ height: 32, scrolls: false });
    expect(fitComposerHeight(-5, LIMITS)).toEqual({ height: 32, scrolls: false });
  });

  it("does not open a box shorter than a row when the limits are inverted", () => {
    expect(fitComposerHeight(80, { min: 192, max: 32 })).toEqual({ height: 192, scrolls: false });
  });
});
