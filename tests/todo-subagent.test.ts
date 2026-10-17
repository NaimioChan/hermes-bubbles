import { beforeEach, describe, expect, it } from "vitest";

import { reduceEvent, reduceTodos, resetIdCounter, type GatewayEvent } from "../src/core/reduce";
import { emptyTimeline, type SubagentsItem, type Timeline } from "../src/core/types";

function feed(timeline: Timeline, ...events: GatewayEvent[]): Timeline {
  return events.reduce((acc, event) => reduceEvent(acc, event), timeline);
}

const delta = (text: string): GatewayEvent => ({ type: "message.delta", payload: { text } });
const toolStart = (toolId: string, name = "read_file"): GatewayEvent => ({
  type: "tool.start",
  payload: { tool_id: toolId, name },
});

function batchCard(timeline: Timeline): SubagentsItem {
  const item = timeline.items.find((row) => row.kind === "subagents");
  if (!item || item.kind !== "subagents") throw new Error("no subagent card in timeline");
  return item;
}

beforeEach(() => {
  resetIdCounter();
});

describe("text segments around tool calls", () => {
  it("seals the open bubble when a tool starts", () => {
    const t = feed(
      emptyTimeline,
      { type: "message.start" },
      delta("我先查一下文件"),
      toolStart("t1"),
    );
    const assistant = t.items[0];
    expect(assistant).toMatchObject({ kind: "assistant", streaming: false, text: "我先查一下文件" });
    expect(t.items[1]).toMatchObject({ kind: "tool", toolId: "t1" });
  });

  it("puts the post-tool reply in a NEW bubble below the card", () => {
    const t = feed(
      emptyTimeline,
      { type: "message.start" },
      delta("我先查一下文件"),
      toolStart("t1"),
      { type: "tool.complete", payload: { tool_id: "t1", name: "read_file", summary: "ok" } },
      delta("查完了，结论是 X"),
    );
    expect(t.items.map((item) => item.kind)).toEqual(["assistant", "tool", "assistant"]);
    expect(t.items[0]).toMatchObject({ text: "我先查一下文件" });
    const reply = t.items[2];
    expect(reply).toMatchObject({ kind: "assistant", text: "查完了，结论是 X", streaming: true });
  });

  it("keeps two tool rounds as two separated replies", () => {
    const t = feed(
      emptyTimeline,
      delta("第一步"),
      toolStart("t1"),
      { type: "tool.complete", payload: { tool_id: "t1" } },
      delta("第二步"),
      toolStart("t2"),
      { type: "tool.complete", payload: { tool_id: "t2" } },
      delta("最终答案"),
    );
    expect(t.items.map((item) => item.kind)).toEqual([
      "assistant",
      "tool",
      "assistant",
      "tool",
      "assistant",
    ]);
    const last = t.items[4];
    expect(last).toMatchObject({ kind: "assistant", text: "最终答案" });
  });

  it("finishes the post-tool bubble, not the one above the card", () => {
    const finished = feed(
      emptyTimeline,
      delta("工具之前"),
      toolStart("t1"),
      { type: "tool.complete", payload: { tool_id: "t1" } },
      delta("工具之后的最终回答"),
      { type: "message.complete", payload: { text: "", status: "complete" } },
    );
    expect(finished.meta.running).toBe(false);
    const [before, , after] = finished.items;
    expect(before).toMatchObject({ kind: "assistant", text: "工具之前", streaming: false });
    expect(after).toMatchObject({ kind: "assistant", text: "工具之后的最终回答", streaming: false });
    expect(after && "completedAt" in after ? after.completedAt : undefined).toBeTypeOf("number");
  });
});

describe("todo.updated", () => {
  const snapshot = (revision: number, todos: unknown[]): GatewayEvent => ({
    type: "todo.updated",
    payload: { revision, todos },
  });

  it("replaces the whole list on every frame", () => {
    const first = reduceEvent(emptyTimeline, snapshot(1, [{ id: "a", content: "读代码", status: "pending" }]));
    expect(first.meta.todo).toEqual({ revision: 1, todos: [{ id: "a", content: "读代码", status: "pending" }] });

    const second = reduceEvent(
      first,
      snapshot(2, [
        { id: "a", content: "读代码", status: "completed" },
        { id: "b", content: "写测试", status: "in_progress" },
      ]),
    );
    expect(second.meta.todo?.todos).toHaveLength(2);
    expect(second.meta.todo?.todos[0]?.status).toBe("completed");
  });

  it("ignores a stale revision from a reconnect replay", () => {
    const current = reduceEvent(emptyTimeline, snapshot(5, [{ id: "a", content: "旧", status: "pending" }]));
    const stale = reduceEvent(current, snapshot(3, [{ id: "a", content: "更旧", status: "pending" }]));
    expect(stale).toBe(current);
  });

  it("ignores the unused store's empty placeholder", () => {
    expect(reduceTodos(null, { todos: [], revision: 0 })).toBeUndefined();
  });

  it("treats an empty list at revision >= 1 as a real clear", () => {
    const current = reduceEvent(emptyTimeline, snapshot(4, [{ id: "a", content: "做完", status: "completed" }]));
    const cleared = reduceEvent(current, snapshot(5, []));
    expect(cleared.meta.todo).toEqual({ revision: 5, todos: [] });
  });

  it("keeps subtask parents and drops rows without an id or content", () => {
    const t = reduceEvent(
      emptyTimeline,
      snapshot(2, [
        { id: "p", content: "父任务", status: "in_progress" },
        { id: "c", content: "子任务", status: "pending", parent: "p" },
        { id: "", content: "没有 id" },
        { id: "x" },
      ]),
    );
    expect(t.meta.todo?.todos).toEqual([
      { id: "p", content: "父任务", status: "in_progress", parent: undefined },
      { id: "c", content: "子任务", status: "pending", parent: "p" },
    ]);
  });

  it("does not break the turn on a malformed frame", () => {
    const t = reduceEvent(emptyTimeline, { type: "todo.updated", payload: { todos: "nope" } });
    expect(t.meta.todo).toBeNull();
  });
});

describe("subagent frames", () => {
  const frame = (type: string, payload: Record<string, unknown>): GatewayEvent => ({
    type,
    payload: {
      goal: "共同目标",
      task_count: 3,
      delegation_id: "d1",
      parent_id: "root",
      depth: 1,
      ...payload,
    },
  });

  it("folds concurrent children onto one batch card", () => {
    const t = feed(
      emptyTimeline,
      frame("subagent.spawn_requested", { subagent_id: "s1", task_index: 0, goal: "读 A" }),
      frame("subagent.spawn_requested", { subagent_id: "s2", task_index: 1, goal: "读 B" }),
      frame("subagent.spawn_requested", { subagent_id: "s3", task_index: 2, goal: "读 C" }),
      frame("subagent.start", { subagent_id: "s1", task_index: 0 }),
      frame("subagent.start", { subagent_id: "s2", task_index: 1 }),
      frame("subagent.start", { subagent_id: "s3", task_index: 2 }),
    );
    const card = batchCard(t);
    expect(t.items.filter((item) => item.kind === "subagents")).toHaveLength(1);
    expect(card.children).toHaveLength(3);
    expect(card.children.map((child) => child.taskIndex)).toEqual([0, 1, 2]);
    expect(card.children.every((child) => child.status === "running")).toBe(true);
    expect(card.finishedAt).toBeUndefined();
  });

  it("fills in status, tools, tokens and the summary as frames arrive", () => {
    const t = feed(
      emptyTimeline,
      frame("subagent.start", { subagent_id: "s1", task_index: 0, model: "flash" }),
      frame("subagent.tool", { subagent_id: "s1", task_index: 0, tool_name: "grep", tool_count: 1, text: "grep foo" }),
      frame("subagent.thinking", { subagent_id: "s1", task_index: 0, text: "先找入口" }),
      frame("subagent.complete", {
        subagent_id: "s1",
        task_index: 0,
        status: "completed",
        summary: "找到了入口",
        duration_seconds: 12.5,
        input_tokens: 100,
        output_tokens: 40,
        output_tail: [{ tool: "grep", preview: "match", is_error: false }],
      }),
    );
    const child = batchCard(t).children[0];
    expect(child).toMatchObject({
      status: "completed",
      lastTool: "grep",
      toolCount: 1,
      summary: "找到了入口",
      durationS: 12.5,
      model: "flash",
      tokens: { input: 100, output: 40 },
    });
    expect(child?.thinking).toBe("先找入口");
    expect(child?.outputTail).toHaveLength(1);
  });

  it("caps the progress history instead of growing without bound", () => {
    let timeline = feed(emptyTimeline, frame("subagent.start", { subagent_id: "s1", task_index: 0 }));
    for (let i = 0; i < 20; i += 1) {
      timeline = feed(timeline, frame("subagent.progress", { subagent_id: "s1", task_index: 0, text: `step ${i}` }));
    }
    const lines = batchCard(timeline).children[0]?.progress ?? [];
    expect(lines).toHaveLength(6);
    expect(lines.at(-1)).toBe("step 19");
  });

  it("marks the batch finished only when every child reached a terminal status", () => {
    const partial = feed(
      emptyTimeline,
      frame("subagent.start", { subagent_id: "s1", task_index: 0 }),
      frame("subagent.start", { subagent_id: "s2", task_index: 1 }),
      frame("subagent.complete", { subagent_id: "s1", task_index: 0, status: "completed" }),
    );
    expect(batchCard(partial).finishedAt).toBeUndefined();

    const done = feed(partial, frame("subagent.complete", { subagent_id: "s2", task_index: 1, status: "failed" }));
    expect(batchCard(done).finishedAt).toBeTypeOf("number");
    expect(batchCard(done).children.map((child) => child.status)).toEqual(["completed", "failed"]);
  });

  it("keeps a second delegation as its own card", () => {
    const t = feed(
      emptyTimeline,
      frame("subagent.start", { subagent_id: "s1", task_index: 0, delegation_id: "d1" }),
      frame("subagent.complete", { subagent_id: "s1", task_index: 0, delegation_id: "d1", status: "completed" }),
      frame("subagent.start", { subagent_id: "s2", task_index: 0, delegation_id: "d2" }),
    );
    expect(t.items.filter((item) => item.kind === "subagents")).toHaveLength(2);
  });

  it("still groups frames from an emitter that sends no ids", () => {
    const bare = (type: string, taskIndex: number): GatewayEvent => ({
      type,
      payload: { goal: "目标", task_count: 2, task_index: taskIndex },
    });
    const t = feed(emptyTimeline, bare("subagent.start", 0), bare("subagent.start", 1));
    const card = batchCard(t);
    expect(card.children.map((child) => child.key)).toEqual(["idx:0", "idx:1"]);
    expect(t.items.filter((item) => item.kind === "subagents")).toHaveLength(1);
  });

  it("ignores an unknown subagent status rather than inventing one", () => {
    const t = feed(
      emptyTimeline,
      frame("subagent.start", { subagent_id: "s1", task_index: 0 }),
      frame("subagent.complete", { subagent_id: "s1", task_index: 0, status: "weird" }),
    );
    expect(batchCard(t).children[0]?.status).toBe("completed");
  });
});
