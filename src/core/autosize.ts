/**
 * How tall the composer should be for the text inside it.
 *
 * Pure, so the decision is testable without a DOM (AGENTS.md 铁律 1). The
 * measurement itself — `scrollHeight` — stays in `src/ui/Composer.ts`; this file
 * only answers "given that number, what height do we set, and does it scroll?".
 *
 * Why a cap at all: the composer sits above the transcript, so a pasted log
 * without one would push every message off screen and leave the send button
 * floating at the bottom of a screen-tall box.
 */

export interface AutosizeLimits {
  /** One row. Below this the box clips its own padding. */
  min: number;
  /** Past this the box scrolls instead of growing. */
  max: number;
}

export interface ComposerSize {
  height: number;
  /** The text is taller than the cap, so the box has to scroll. */
  scrolls: boolean;
}

export function fitComposerHeight(contentHeight: number, limits: AutosizeLimits): ComposerSize {
  // A max below the min is a config mistake, not a reason to open a box smaller
  // than one row.
  const ceiling = Math.max(limits.min, limits.max);
  // `scrollHeight` is 0 on a hidden or not-yet-laid-out element. Treat anything
  // unmeasurable as "one row" rather than collapsing the box.
  const measured =
    Number.isFinite(contentHeight) && contentHeight > 0 ? Math.ceil(contentHeight) : limits.min;
  const height = Math.min(Math.max(measured, limits.min), ceiling);
  return { height, scrolls: measured > ceiling };
}
