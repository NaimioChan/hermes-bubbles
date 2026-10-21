/**
 * Whether the transcript should keep up with new output.
 *
 * A streaming turn appends to the transcript many times a second — reply text,
 * thinking segments, tool output. Scrolling to the bottom on each one is right
 * for a reader who is following along, and wrong for a reader who scrolled up
 * to read something: every delta drags the view back down, so earlier messages
 * cannot be read at all until the turn ends.
 *
 * Two different facts decide it, and they must not be conflated:
 *
 *   - Position: how far the bottom of the content is from the viewport.
 *   - Intent: did the reader move away, or is that distance only the content
 *     growing under a reader who never scrolled?
 *
 * Position alone would stop the follow as soon as the last reply grows taller
 * than the remaining slack, which breaks auto-follow exactly when it matters.
 * Intent is read from the reader's own `scrollTop` instead: content growth leaves
 * `scrollTop` where it was, our own follow increases it, and only a reader can
 * decrease it. Returning to the bottom clears the intent.
 *
 * Pure: element measurement stays in `ui/ChatPage.ts` (AGENTS.md: `core/` is DOM
 * free).
 */

export interface ScrollMetrics {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

export interface PinState {
  /** `scrollTop` at the last observation. Only a reader moves this upward. */
  lastTop: number;
  /** The reader scrolled away: leave the position alone until they return. */
  released: boolean;
}

export type FollowDecision =
  /** Keep the bottom in view: scroll to it after this content change. */
  | "follow"
  /** Leave the scroll position alone; the reader is somewhere else on purpose. */
  | "hold";

/**
 * Within this distance of the bottom the reader counts as "at the bottom".
 *
 * Not zero: a fractional layout height, a padding change or one wheel notch can
 * leave a few px of slack, and reading that as "scrolled away" would stop the
 * follow while the reader is still watching the newest line.
 */
export const STICK_SLACK_PX = 24;

/**
 * An upward move larger than this is deliberate.
 *
 * Below it the move is noise: an elastic overscroll, a trackpad nudge.
 */
export const RELEASE_INTENT_PX = 8;

/** Freshly attached to the bottom of a transcript. `lastTop` is filled in on the
 * first observation: a stale zero would read as a reader's upward move. */
export const pinnedState: PinState = { lastTop: 0, released: false };

/** How far the bottom of the content sits below the viewport's bottom edge. */
export function distanceFromBottom(metrics: ScrollMetrics): number {
  const overflow = metrics.scrollHeight - metrics.clientHeight;
  // Content shorter than the viewport has no bottom to be away from; a
  // fractional layout can also report a sub-pixel overflow.
  if (!Number.isFinite(overflow) || overflow <= 0) return 0;
  const scrolled = Math.max(0, Math.min(overflow, metrics.scrollTop));
  return overflow - scrolled;
}

/** True when the reader is close enough to the bottom to be following along. */
export function atBottom(metrics: ScrollMetrics): boolean {
  return distanceFromBottom(metrics) <= STICK_SLACK_PX;
}

/**
 * Fold a scroll event into the pin.
 *
 * Runs for every scroll, including the ones our own follow produces: landing at
 * the bottom re-arms the follow, which is how a reader who went back to read
 * something rejoins the live output.
 */
export function pinAfterScroll(metrics: ScrollMetrics, state: PinState): PinState {
  if (atBottom(metrics)) return { lastTop: metrics.scrollTop, released: false };
  const movedUp = state.lastTop - metrics.scrollTop;
  return {
    lastTop: metrics.scrollTop,
    released: state.released || movedUp > RELEASE_INTENT_PX,
  };
}

/**
 * Fold a content change (a new bubble, or more text in the last one) into the
 * pin, and say whether the view should move.
 *
 * The state comes back either way: `lastTop` has to track reality, or the next
 * scroll would be measured against a stale baseline.
 *
 * A decrease in `scrollTop` is also read as intent here. The scroll event for a
 * reader's wheel move is dispatched asynchronously, so a delta can arrive and
 * render before that event does — and scrolling to the bottom at that point
 * would undo the reader's move before the pin ever heard about it. Content
 * growth never decreases `scrollTop`, and our own follow only increases it, so a
 * decrease can only have come from the reader.
 */
export function followAfterChange(
  metrics: ScrollMetrics,
  state: PinState,
): { decision: FollowDecision; state: PinState } {
  // At the bottom, someone is watching the newest line: follow, and record where
  // we actually are so the next observation is measured against reality.
  if (atBottom(metrics)) {
    return { decision: "follow", state: { lastTop: metrics.scrollTop, released: false } };
  }
  const movedUp = state.lastTop - metrics.scrollTop;
  const released = state.released || movedUp > RELEASE_INTENT_PX;
  return {
    decision: released ? "hold" : "follow",
    state: { lastTop: metrics.scrollTop, released },
  };
}
