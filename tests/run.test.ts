import { describe, expect, it } from "vitest";

import {
  RUN_MIN_ITEMS,
  groupTranscript,
  isFurniture,
  runCounts,
  runElapsedMs,
  runIsLive,
} from "../src/core/run";
import type { AssistantItem, NoticeItem, ReasoningItem, SubagentsItem, ToolItem, UserItem } from "../src/core/types";

/**
 * The grouping rules behind the collapsed activity block (see `ui/Activity.ts`).
 *
 * The bug this fixes is arithmetic, not styling: twenty compact rows are still
 * twenty rows tall, so capping each ROW (which `ReasoningRow` already did) left
 * the total unbounded. What has to be true here is that consecutive machinery
 * rows become ONE segment, that a message always breaks the run, and that a lone
 * piece of furniture is left as its own row instead of growing a header.
 */

let seq = 0;
const user = (text: string): UserItem => ({ kind: "user", id: `u${++seq}`, at: 1000 + seq, text });
const assistant = (text: string): AssistantItem => ({
  kind: "assistant",
  id: `a${++seq}`,
  at: 1000 + seq,
  text,
  streaming: false,
});
const think = (text: string, streaming = false): ReasoningItem => ({
  kind: "reasoning",
  id: `r${++seq}`,
  at: 1000 + seq,
  text,
  streaming,
});
const tool = (status: ToolItem["status"] = "ok", durationS?: number): ToolItem => ({
  kind: "tool",
  id: `t${++seq}`,
  at: 1000 + seq,
  toolId: `call_${seq}`,
  name: "terminal",
  summary: "npm test",
  status,
  durationS,
});
const notice = (noticeKind?: NoticeItem["noticeKind"], tone: NoticeItem["tone"] = "info"): NoticeItem => ({
  kind: "notice",
  id: `n${++seq}`,
  at: 1000 + seq,
  text: "background process finished",
  tone,
  noticeKind,
});
const subagents = (finished = true): SubagentsItem => ({
  kind: "subagents",
  id: `s${++seq}`,
  at: 1000 + seq,
  batchKey: `b${seq}`,
  taskCount: 1,
  children: [],
  finishedAt: finished ? 1500 + seq : undefined,
});

describe("run: what counts as furniture", () => {
  it("takes thinking, tool calls and delegation batches", () => {
    expect(isFurniture(think("hmm"))).toBe(true);
    expect(isFurniture(tool())).toBe(true);
    expect(isFurniture(subagents())).toBe(true);
  });

  it("takes a machinery notice but never an error notice", () => {
    // A model-switch or process-finished marker is part of the work. An ERROR
    // notice is the one machinery row that must never end up behind a
    // disclosure — it is the only thing on screen saying the turn failed.
    expect(isFurniture(notice("process"))).toBe(true);
    expect(isFurniture(notice("process", "error"))).toBe(false);
    expect(isFurniture(notice(undefined, "error"))).toBe(false);
  });

  it("takes neither messages nor a bare notice", () => {
    expect(isFurniture(user("hi"))).toBe(false);
    expect(isFurniture(assistant("hello"))).toBe(false);
    expect(isFurniture(notice())).toBe(false);
  });
});

describe("run: grouping", () => {
  it("folds a run of machinery into one segment between two messages", () => {
    const items = [user("go"), think("plan"), tool(), tool(), assistant("done")];
    const segments = groupTranscript(items);
    expect(segments.map((s) => s.type)).toEqual(["item", "run", "item"]);
    const run = segments[1];
    expect(run?.type === "run" && run.items.length).toBe(3);
  });

  it("leaves a lone piece of furniture as its own row", () => {
    // One thinking block is the common case. Wrapping it in a header plus a body
    // would cost two rows to show one, and hide the live tail behind a click.
    const segments = groupTranscript([user("go"), think("plan"), assistant("done")]);
    expect(segments.map((s) => s.type)).toEqual(["item", "item", "item"]);
  });

  it("breaks the run on every message, not just the outer two", () => {
    // A turn can answer mid-way and keep working (`message.interim`). The reply
    // belongs between two blocks, not inside one.
    const items = [think("a"), tool(), assistant("middle"), think("b"), tool()];
    const segments = groupTranscript(items);
    expect(segments.map((s) => (s.type === "run" ? "run" : s.item.kind))).toEqual([
      "run",
      "assistant",
      "run",
    ]);
  });

  it("keys a run by its first row so a delta does not remount it", () => {
    // A streaming delta replaces the LAST item of the run; if the key moved with
    // it, the block would remount and replay its entrance animation per token.
    const first = think("a");
    const before = groupTranscript([first, tool()]);
    const after = groupTranscript([first, tool(), tool("running")]);
    expect(before[0]?.key).toBe(first.id === "" ? "" : `run:${first.id}`);
    expect(after[0]?.key).toBe(before[0]?.key);
  });

  it("respects a raised minimum", () => {
    const items = [think("a"), tool()];
    expect(groupTranscript(items, 3).map((s) => s.type)).toEqual(["item", "item"]);
    expect(RUN_MIN_ITEMS).toBe(2);
  });

  it("returns nothing for an empty timeline and no runs for messages only", () => {
    expect(groupTranscript([])).toEqual([]);
    expect(groupTranscript([user("a"), assistant("b")]).every((s) => s.type === "item")).toBe(true);
  });
});

describe("run: counts, liveness and span", () => {
  it("counts each kind once", () => {
    const counts = runCounts([think("a"), think("b"), tool(), subagents(), notice("process")]);
    expect(counts).toEqual({ thoughts: 2, tools: 1, subagents: 1, notices: 1 });
  });

  it("is live while its newest row is still in flight", () => {
    expect(runIsLive([tool(), think("…", true)])).toBe(true);
    expect(runIsLive([think("a"), tool("running")])).toBe(true);
    expect(runIsLive([think("a"), tool()])).toBe(false);
    expect(runIsLive([subagents(false)])).toBe(true);
    expect(runIsLive([])).toBe(false);
  });

  it("measures elapsed wall clock from the first row to the last one's end", () => {
    // Elapsed time, not the sum of tool durations: the thinking in between is
    // part of how long the block took.
    const first = think("a");
    const last = tool("ok", 2);
    const items = [first, last];
    const span = runElapsedMs(items, 999_999);
    expect(span).toBe(last.at + 2000 - first.at);
  });

  it("measures a live run against `now`", () => {
    const first = think("a");
    const items = [first, think("still going", true)];
    expect(runElapsedMs(items, first.at + 5000)).toBe(5000);
  });

  it("has no span for a single row or equal stamps", () => {
    expect(runElapsedMs([], 0)).toBeNull();
    expect(runElapsedMs([tool()], 10_000)).toBeNull();
  });
});
