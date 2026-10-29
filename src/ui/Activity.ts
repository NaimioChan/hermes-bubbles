/**
 * The block that holds everything between two messages.
 *
 * A turn's non-message rows — thinking segments, tool calls, delegation
 * batches, machinery notices — are transcript furniture, and their number is
 * unbounded: one turn can produce twenty of them. Left as twenty independent
 * rows they own most of the column, and the two messages they sit between are
 * pushed so far apart that the conversation stops reading as a conversation.
 *
 * So a run of them collapses into one block with a bounded height. Collapsed it
 * is a header line (`▸ 2 thoughts · 5 calls 33s`) over the run's own rows,
 * clipped at `ACTIVITY_MAX_PX` with a fade where the cut is. Expanding is the
 * only thing that may make the block taller than that, and it is a per-block
 * decision.
 *
 * This caps the RUN, not each row. `ReasoningRow` already caps a single thinking
 * segment at 7.5rem; fifteen capped rows are still fifteen rows tall, which is
 * what the user was still looking at.
 *
 * The clipped body is the REAL rows, scrolled to the bottom, not a text digest:
 * a summary line per row would be a second description of the same work (and a
 * second thing to keep in sync), and it would make every row unreachable — a
 * tool call whose output you want is one click away in the expanded block. What
 * the clip must not do is leave focusable controls sitting under it, so while
 * collapsed the body is `inert` and `aria-hidden`: the rows are visible but the
 * only thing a keyboard or a screen reader can reach is the header toggle.
 */

import type { TimelineItem } from "../core/types";
import { runCounts, runElapsedMs, runIsLive } from "../core/run";
import { formatElapsed, messagesFor, type Locale } from "../core/i18n";
import type { HermesPluginSdk } from "./sdk";
import { Icon } from "./icons";
import { Bubble } from "./Bubble";
import { activitySummary } from "./format";

interface ActivityBlockProps {
  sdk: HermesPluginSdk;
  items: TimelineItem[];
  locale: Locale;
}

/**
 * The collapsed ceiling, in px.
 *
 * Measured against a 390×844 phone, where the transcript is ~560px tall: 190px
 * of machinery leaves room for two bubbles around it, so a long turn still reads
 * as "I said this, it did some work, it answered".
 */
export const ACTIVITY_MAX_PX = 190;

export function ActivityBlock({ sdk, items, locale }: ActivityBlockProps) {
  const { React } = sdk;
  const { useState, useMemo, useEffect, useRef } = sdk.hooks;
  const t = messagesFor(locale);
  const [open, setOpen] = useState(false);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  // A live run needs its elapsed stamp to keep counting; a settled one must not
  // leave a timer behind (see the effect below).
  const [now, setNow] = useState(() => Date.now());

  const live = runIsLive(items);
  const counts = useMemo(() => runCounts(items), [items]);
  const summary = activitySummary(counts, t);
  const elapsed = formatElapsed((runElapsedMs(items, now) ?? 0) / 1000);

  // Tick only while the run is live. A settled transcript can hold dozens of
  // these blocks, and one interval each would be dozens of timers doing nothing.
  useEffect(() => {
    if (!live) return undefined;
    setNow(Date.now());
    const handle = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(handle);
  }, [live]);

  // Two different resting positions, both deliberate:
  //
  //   - collapsed: the BOTTOM of the run, so the clipped strip shows the newest
  //     rows (what the turn is doing now) and the cut lands at the top edge
  //     where the fade explains it;
  //   - expanded: the TOP, in reading order. A run of twenty calls is read from
  //     the first one; opening a block and landing at its end would hide the
  //     step the reader clicked to see.
  //
  // Re-applied when the run grows so a live block does not sit at a stale
  // offset. A reader's own scroll inside the body is left alone between renders.
  useEffect(() => {
    const el = bodyRef.current;
    if (!el || !open) return;
    el.scrollTop = 0;
  }, [open]);

  return React.createElement(
    "div",
    {
      className: "hb-act",
      "data-hb": "activity-block",
      "data-open": open ? "true" : "false",
      "data-live": live ? "true" : "false",
      // The ceiling is on the BLOCK, not on the body: a header line plus a
      // 190px body would measure 205 and quietly break the promise. One number,
      // and it is the height the reader actually sees.
      style: open ? undefined : { maxHeight: `${ACTIVITY_MAX_PX}px` },
    },
    React.createElement(
      "button",
      {
        type: "button",
        className: "hb-act-head",
        "data-hb": "activity-toggle",
        "data-open": open ? "true" : "false",
        "aria-expanded": open ? "true" : "false",
        title: open ? t.activityCollapse : t.activityExpand,
        onClick: () => setOpen((value: boolean) => !value),
      },
      React.createElement("span", { className: "hb-act-caret" }, Icon(sdk, { name: "chevron", size: 13 })),
      live
        ? React.createElement(
            "span",
            { className: "hb-act-live" },
            React.createElement("span", { className: "hb-act-dot" }),
          )
        : null,
      React.createElement("span", { className: "hb-act-summary" }, summary),
      elapsed
        ? React.createElement("span", { className: "hb-act-elapsed tabular-nums" }, elapsed)
        : null,
    ),
    React.createElement(
      "div",
      {
        className: "hb-act-body",
        ref: bodyRef,
        // Collapsed, the rows are decoration: visible, unable to take focus and
        // unable to be clicked. `inert` is the only attribute that does all
        // three, and it is what keeps a call's controls from being tabbed to
        // under a clip the user cannot see the whole of.
        inert: open ? undefined : true,
        "aria-hidden": open ? undefined : "true",
        "data-hb-locked": open ? undefined : "true",
      },
      // No `data-hb-kind` on these wrappers: the block IS the transcript row
      // here, and a child claiming a kind would make `querySelectorAll(
      // '[data-hb-kind]')` report the run's insides as top-level items.
      items.map((item) => React.createElement(Bubble, { key: item.id, sdk, item, locale })),
    ),
  );
}
