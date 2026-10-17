/**
 * The locator rail beside the transcript.
 *
 * One tick per message the user sent, evenly spaced down a narrow column, for
 * jumping back to something said earlier. Clicking a tick scrolls that bubble
 * into view; hovering shows the message's opening words so you can tell which
 * one you are about to hit.
 *
 * Placement is `core/rail.ts` (pure, tested). This file is the DOM: measuring the
 * rail, positioning the ticks, and finding the target bubble.
 */

import { messagesFor, type Locale } from "../core/i18n";
import { nearestTick, railTicks, visibleTicks } from "../core/rail";
import type { TimelineItem } from "../core/types";
import type { HermesPluginSdk } from "./sdk";

export interface RailProps {
  sdk: HermesPluginSdk;
  locale: Locale;
  items: readonly TimelineItem[];
  /** Scroll container that holds the transcript. */
  scrollerRef: { current: HTMLDivElement | null };
}

/**
 * Scroll a timeline item's element into view.
 *
 * Bubbles carry `data-hb-item`; a tick whose element is not mounted (the
 * transcript is not virtualised, but a collapsed tab can have none) is a no-op
 * rather than a scroll to nowhere.
 */
export function scrollToItem(
  scroller: HTMLElement | null,
  itemId: string,
  behavior: ScrollBehavior = "smooth",
): boolean {
  if (!scroller) return false;
  const target = scroller.querySelector(`[data-hb-item="${CSS.escape(itemId)}"]`);
  if (!target) return false;
  // Scroll the container itself rather than calling scrollIntoView, which also
  // moves the window and can drag the whole dashboard.
  const offset = (target as HTMLElement).getBoundingClientRect().top
    - scroller.getBoundingClientRect().top
    + scroller.scrollTop
    - 12;
  scroller.scrollTo({ top: Math.max(0, offset), behavior });
  return true;
}

export function LocatorRail({ sdk, locale, items, scrollerRef }: RailProps) {
  const { React } = sdk;
  const { useState } = sdk.hooks;
  const t = messagesFor(locale);
  const [hovered, setHovered] = useState<number>(-1);

  const all = railTicks(items);
  if (all.length < 2) {
    // One message (or none) is not worth a rail: there is nothing to jump between.
    return null;
  }
  const ticks = visibleTicks(all);

  const active = hovered >= 0 ? ticks[hovered] : null;

  return React.createElement(
    "div",
    {
      className: "hb-rail",
      "data-hb": "locator-rail",
      // The clickable area is the whole column, but only ticks do anything; a
      // click between ticks snaps to the nearest one.
      onClick: (event: { currentTarget: HTMLDivElement; clientY: number }) => {
        const rect = event.currentTarget.getBoundingClientRect();
        const ratio = rect.height > 0 ? (event.clientY - rect.top) / rect.height : 0;
        const index = nearestTick(ticks, ratio);
        const tick = ticks[index];
        if (tick) scrollToItem(scrollerRef.current, tick.itemId);
      },
      onMouseMove: (event: { currentTarget: HTMLDivElement; clientY: number }) => {
        const rect = event.currentTarget.getBoundingClientRect();
        const ratio = rect.height > 0 ? (event.clientY - rect.top) / rect.height : 0;
        const index = nearestTick(ticks, ratio);
        if (index !== hovered) setHovered(index);
      },
      onMouseLeave: () => setHovered(-1),
      // Keyboard users get the newest handful rather than an unreachable rail.
      tabIndex: 0,
      role: "navigation",
      "aria-label": t.jumpToMessage,
    },
    ticks.map((tick, index) =>
      React.createElement("span", {
        key: tick.itemId,
        className: "hb-rail-tick",
        "data-hb-tick": tick.itemId,
        "data-active": index === hovered ? "true" : "false",
        style: { top: `${(tick.position * 100).toFixed(3)}%` },
      }),
    ),
    active
      ? React.createElement(
          "span",
          {
            className: "hb-rail-tip",
            "data-hb": "rail-tip",
            // Flip the tooltip inward near the top so it never leaves the column.
            style: { top: `${(active.position * 100).toFixed(3)}%` },
          },
          active.label || t.untitled,
        )
      : null,
  );
}
