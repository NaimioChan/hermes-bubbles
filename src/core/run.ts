/**
 * Grouping the machinery between two messages into one bounded block.
 *
 * A turn fires ten or twenty non-message rows — thinking segments, tool calls,
 * a delegation batch — and each one used to be its own transcript row. Rows that
 * are individually one line still add up: fifteen of them own most of the column,
 * and the two messages they sit between are pushed apart by a wall of grey.
 *
 * So consecutive machinery rows are folded into one segment. The block caps its
 * own height while collapsed and expands on demand (`ui/Activity.ts`); this
 * module is only the arithmetic — what joins a run, how many of each kind it
 * holds, and how long it took — so the rules can be tested without a DOM.
 *
 * Pure: no React, no DOM, no clock reads. `now` is passed in (AGENTS.md 铁律 1).
 */

import type { TimelineItem } from "./types";

/**
 * A run of fewer than this many rows is left alone.
 *
 * The common case is one thinking segment and nothing else: wrapping it in a
 * header plus a body would make a single 17px line cost two rows and hide the
 * live tail behind a disclosure. Only a real cluster is worth a block.
 */
export const RUN_MIN_ITEMS = 2;

export type TranscriptSegment =
  /** A message, or a lone piece of machinery: rendered as its own row. */
  | { readonly type: "item"; readonly key: string; readonly item: TimelineItem }
  /** Two or more machinery rows between two messages: rendered as one block. */
  | { readonly type: "run"; readonly key: string; readonly items: TimelineItem[] };

/**
 * Whether this row is transcript furniture rather than something the user or the
 * model said.
 *
 * Machinery notices (a background process finishing, a model switch) count: they
 * are one-line log entries that appear mid-turn and belong with the work, not
 * between two messages. An ERROR notice stays out — it is the one machinery row
 * that must never be hidden behind a disclosure.
 */
export function isFurniture(item: TimelineItem): boolean {
  switch (item.kind) {
    case "reasoning":
    case "tool":
    case "subagents":
      return true;
    case "notice":
      return Boolean(item.noticeKind) && item.tone !== "error";
    default:
      return false;
  }
}

/**
 * Fold a flat timeline into segments, in order.
 *
 * Keys are stable: a run is keyed by its first item, so a delta that appends to
 * the last row of a run does not remount the block (and does not replay its
 * entrance animation).
 */
export function groupTranscript(
  items: readonly TimelineItem[],
  minItems = RUN_MIN_ITEMS,
): TranscriptSegment[] {
  const segments: TranscriptSegment[] = [];
  let run: TimelineItem[] = [];

  const flush = () => {
    if (!run.length) return;
    if (run.length >= minItems) {
      segments.push({ type: "run", key: `run:${run[0]!.id}`, items: run });
    } else {
      // Below the floor each row stands alone. Dropping the extras here would
      // silently delete rows from the transcript.
      for (const item of run) segments.push({ type: "item", key: item.id, item });
    }
    run = [];
  };

  for (const item of items) {
    if (isFurniture(item)) {
      run.push(item);
      continue;
    }
    flush();
    segments.push({ type: "item", key: item.id, item });
  }
  flush();
  return segments;
}

export interface RunCounts {
  thoughts: number;
  tools: number;
  subagents: number;
  notices: number;
}

/** How many of each kind the block holds — the numbers in its header. */
export function runCounts(items: readonly TimelineItem[]): RunCounts {
  const counts: RunCounts = { thoughts: 0, tools: 0, subagents: 0, notices: 0 };
  for (const item of items) {
    switch (item.kind) {
      case "reasoning":
        counts.thoughts += 1;
        break;
      case "tool":
        counts.tools += 1;
        break;
      case "subagents":
        counts.subagents += 1;
        break;
      case "notice":
        counts.notices += 1;
        break;
      default:
        break;
    }
  }
  return counts;
}

/**
 * When a row finished, as far as the timeline knows.
 *
 * A reasoning segment that is still streamed has no end yet, so a live run
 * measures to `now`. A tool row carries a duration instead of an end timestamp;
 * adding it to the start is the same fact in the same unit.
 */
function endOf(item: TimelineItem, now: number): number {
  if (item.kind === "assistant" && item.completedAt) return item.completedAt;
  if (item.kind === "reasoning" && item.streaming) return now;
  if (item.kind === "tool") {
    if (item.status === "running") return now;
    if (typeof item.durationS === "number") return item.at + item.durationS * 1000;
  }
  if (item.kind === "subagents" && item.finishedAt) return item.finishedAt;
  return item.at;
}

/** True while the run's newest row is still in flight. Drives the live indicator. */
export function runIsLive(items: readonly TimelineItem[]): boolean {
  const last = items.at(-1);
  if (!last) return false;
  if (last.kind === "tool") return last.status === "running";
  if (last.kind === "reasoning") return last.streaming;
  if (last.kind === "subagents") return last.finishedAt === undefined;
  return false;
}

/**
 * Wall-clock span of a run in milliseconds, or `null` when it has no measurable
 * length (one row, or everything stamped at the same instant).
 *
 * This is elapsed time, not the sum of the tool durations: the thinking between
 * two calls is part of how long the block took.
 */
export function runElapsedMs(items: readonly TimelineItem[], now: number): number | null {
  const first = items[0];
  const last = items.at(-1);
  if (!first || !last) return null;
  const span = endOf(last, now) - first.at;
  return Number.isFinite(span) && span > 0 ? span : null;
}
