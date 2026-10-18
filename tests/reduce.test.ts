import { beforeEach, describe, expect, it } from "vitest";

import {
  ackUser,
  appendUser,
  inferToolStatus,
  reduceEvent,
  resetIdCounter,
  settleTimeline,
  type GatewayEvent,
} from "../src/core/reduce";
import { emptyTimeline, openAssistant, type Timeline, type ToolItem } from "../src/core/types";

function feed(timeline: Timeline, ...events: GatewayEvent[]): Timeline {
  return events.reduce((acc, event) => reduceEvent(acc, event), timeline);
}

const delta = (text: string, seq = 1): GatewayEvent => ({ type: "message.delta", payload: { text }, seq });

beforeEach(() => {
  resetIdCounter();
});

describe("streaming", () => {
  it("accumulates deltas into one bubble", () => {
    const t = feed(emptyTimeline, delta("你"), delta("好"), delta("！"));
    expect(t.items).toHaveLength(1);
    expect(t.items[0]).toMatchObject({ kind: "assistant", text: "你好！", streaming: true });
  });

  it("creates the bubble lazily when a delta arrives with no message.start", () => {
    const t = reduceEvent(emptyTimeline, delta("hi"));
    expect(t.items[0]).toMatchObject({ kind: "assistant", streaming: true });
    expect(t.meta.running).toBe(true);
  });

  it("marks the turn running on message.start and clears it on message.complete", () => {
    const started = reduceEvent(emptyTimeline, { type: "message.start" });
    expect(started.meta.running).toBe(true);
    const done = reduceEvent(feed(started, delta("x")), { type: "message.complete", payload: { text: "" } });
    expect(done.meta.running).toBe(false);
    expect(openAssistant(done.items)).toBeNull();
  });

  it("does not let message.complete's empty text wipe streamed output", () => {
    const t = feed(emptyTimeline, delta("已流式的正文"), {
      type: "message.complete",
      payload: { text: "", status: "complete" },
    });
    expect(t.items[0]).toMatchObject({ text: "已流式的正文", streaming: false });
  });

  it("uses message.complete's text as a fallback when nothing streamed", () => {
    const t = reduceEvent(emptyTimeline, {
      type: "message.complete",
      payload: { text: "非流式 provider 的整段回答", status: "complete" },
    });
    expect(t.items[0]).toMatchObject({ kind: "assistant", text: "非流式 provider 的整段回答" });
  });

  it("records the error and keeps partial output on a failed turn", () => {
    const t = feed(emptyTimeline, delta("半截回答"), {
      type: "message.complete",
      payload: { text: "", status: "error", error: "provider 502", partial: true },
    });
    expect(t.items[0]).toMatchObject({
      text: "半截回答",
      error: "provider 502",
      partial: true,
      streaming: false,
    });
    expect(t.meta.running).toBe(false);
  });

  it("falls back to failure_reason when error is absent", () => {
    const t = reduceEvent(emptyTimeline, {
      type: "message.complete",
      payload: { status: "error", failure_reason: "额度用尽" },
    });
    expect(t.items[0]).toMatchObject({ error: "额度用尽" });
  });

  it("carries usage from message.complete onto the bubble and the meta", () => {
    const usage = { model: "m", input: 10, output: 20, total: 30 };
    const t = feed(emptyTimeline, delta("x"), { type: "message.complete", payload: { text: "", usage } });
    expect(t.meta.usage).toEqual(usage);
    expect(t.items[0]).toMatchObject({ usage });
  });

  it("does not append the reply a second time when a block sealed the bubble", () => {
    // The bug that showed the answer twice: text streamed, then a trailing
    // thinking block sealed the bubble, so `openAssistant` no longer saw it and
    // the complete frame's own `text` was appended as a second bubble.
    const t = feed(
      appendUser(emptyTimeline, "跑一下"),
      delta("我先看一下。", 1),
      { type: "tool.start", payload: { tool_id: "t1", name: "terminal" }, seq: 2 },
      { type: "tool.complete", payload: { tool_id: "t1", result: { output: "hi", exit_code: 0 } }, seq: 3 },
      { type: "reasoning.delta", payload: { text: "收个尾" }, seq: 4 },
      { type: "message.complete", payload: { text: "我先看一下。", status: "complete" }, seq: 5 },
    );
    const replies = t.items.filter((item) => item.kind === "assistant");
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({ text: "我先看一下。", streaming: false });
    expect(replies[0]).toMatchObject({ completedAt: expect.any(Number) });
  });

  it("still opens a bubble for a text-less turn instead of merging into the last reply", () => {
    let t = feed(
      appendUser(emptyTimeline, "第一轮"),
      delta("上一轮的回答", 1),
      { type: "message.complete", payload: { text: "", status: "complete" }, seq: 2 },
    );
    t = feed(
      appendUser(t, "第二轮"),
      { type: "reasoning.delta", payload: { text: "只想不说" }, seq: 3 },
      { type: "message.complete", payload: { text: "这轮补上的回答", status: "complete" }, seq: 4 },
    );
    const replies = t.items.filter((item) => item.kind === "assistant").map((item) => (item as { text: string }).text);
    expect(replies).toEqual(["上一轮的回答", "这轮补上的回答"]);
  });
});

describe("interim segments", () => {
  it("seals the bubble without ending the turn, so later deltas open a new one", () => {
    const t = feed(
      emptyTimeline,
      delta("先说一句"),
      { type: "message.interim", payload: { text: "先说一句", already_streamed: true } },
      delta("工具跑完再说"),
    );
    expect(t.items).toHaveLength(2);
    expect(t.items[0]).toMatchObject({ text: "先说一句", streaming: false });
    expect(t.items[1]).toMatchObject({ text: "工具跑完再说", streaming: true });
    expect(t.meta.running).toBe(true);
  });

  it("appends the text when it was not already streamed", () => {
    const t = feed(emptyTimeline, delta("前半"), {
      type: "message.interim",
      payload: { text: "后半", already_streamed: false },
    });
    expect(t.items).toHaveLength(1);
    expect(t.items[0]).toMatchObject({ text: "前半后半", streaming: false });
  });
});

describe("reasoning", () => {
  it("keeps reasoning in its own item instead of on the reply", () => {
    const t = feed(emptyTimeline, delta("答"), {
      type: "reasoning.delta",
      payload: { text: "想" },
    }, { type: "reasoning.delta", payload: { text: "了想" } });
    // A thinking block that starts after the reply splits it: the words before
    // it are sealed, the block is its own row.
    expect(t.items).toHaveLength(2);
    expect(t.items[0]).toMatchObject({ kind: "assistant", text: "答", streaming: false });
    expect(t.items[1]).toMatchObject({ kind: "reasoning", text: "想了想", streaming: true });
  });

  it("never creates an empty assistant bubble for a think-only segment", () => {
    const t = feed(emptyTimeline, { type: "reasoning.delta", payload: { text: "先想一步" } });
    expect(t.items).toHaveLength(1);
    expect(t.items[0]).toMatchObject({ kind: "reasoning", text: "先想一步" });
    expect(t.items.some((item) => item.kind === "assistant")).toBe(false);
  });

  it("seals the thinking block when the reply starts", () => {
    const t = feed(
      emptyTimeline,
      { type: "reasoning.delta", payload: { text: "想" } },
      delta("答"),
    );
    expect(t.items[0]).toMatchObject({ kind: "reasoning", streaming: false });
    expect(t.items[1]).toMatchObject({ kind: "assistant", text: "答", streaming: true });
  });

  it("starts a new thinking block after a tool call instead of growing the old one", () => {
    const t = feed(
      emptyTimeline,
      { type: "reasoning.delta", payload: { text: "第一段" } },
      { type: "tool.start", payload: { tool_id: "t1", name: "terminal" } },
      { type: "reasoning.delta", payload: { text: "第二段" } },
    );
    const blocks = t.items.filter((item) => item.kind === "reasoning") as Array<{ text: string }>;
    expect(blocks.map((item) => item.text)).toEqual(["第一段", "第二段"]);
  });

  it("stops the live caret once the turn completes", () => {
    const t = feed(
      emptyTimeline,
      { type: "reasoning.delta", payload: { text: "只有想法" } },
      { type: "message.complete", payload: { status: "ok" } },
    );
    expect(t.items).toHaveLength(1);
    expect(t.items[0]).toMatchObject({ kind: "reasoning", streaming: false });
  });

  it("ignores a reasoning.available that just relays the finished reply", () => {
    // hermes-agent 0.21.7 sends the turn's final text through this frame right
    // before message.complete. Taking it as reasoning put the answer in a
    // thinking block and sealed the reply, which produced the second bubble.
    const t = feed(
      emptyTimeline,
      delta("命令跑完了。", 1),
      { type: "reasoning.available", payload: { text: "命令跑完了。" }, seq: 2 },
      { type: "message.complete", payload: { text: "命令跑完了。", status: "complete" }, seq: 3 },
    );
    expect(t.items.filter((item) => item.kind === "reasoning")).toHaveLength(0);
    const replies = t.items.filter((item) => item.kind === "assistant") as Array<{ text: string; streaming: boolean }>;
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({ text: "命令跑完了。", streaming: false });
  });

  it("still takes a genuinely different reasoning.available as a thinking block", () => {
    const t = feed(emptyTimeline, delta("答复", 1), {
      type: "reasoning.available",
      payload: { text: "非流式 provider 的整块推理" },
      seq: 2,
    });
    const blocks = t.items.filter((item) => item.kind === "reasoning") as Array<{ text: string }>;
    expect(blocks.map((item) => item.text)).toEqual(["非流式 provider 的整块推理"]);
  });

  it("ignores empty reasoning chunks", () => {
    const t = reduceEvent(emptyTimeline, { type: "reasoning.delta", payload: { text: "" } });
    expect(t.items).toHaveLength(0);
  });

  it("does not put thinking.delta in the transcript (it is spinner repaint noise)", () => {
    const t = reduceEvent(emptyTimeline, { type: "thinking.delta", payload: { text: "⠋ 思考中" } });
    expect(t.items).toHaveLength(0);
  });
});

describe("tools", () => {
  it("correlates tool.complete to its tool.start by tool_id", () => {
    const t = feed(
      emptyTimeline,
      { type: "tool.start", payload: { tool_id: "t1", name: "terminal", args: { cmd: "ls" } } },
      { type: "tool.complete", payload: { tool_id: "t1", name: "terminal", result: "a\nb", duration_s: 1.5 } },
    );
    expect(t.items).toHaveLength(1);
    expect(t.items[0]).toMatchObject({
      kind: "tool",
      name: "terminal",
      status: "ok",
      durationS: 1.5,
      resultText: "a\nb",
    });
  });

  it("keeps the tool card on screen when the matching start was lost", () => {
    const t = reduceEvent(emptyTimeline, {
      type: "tool.complete",
      payload: { tool_id: "ghost", name: "read_file", result: "ok" },
    });
    expect(t.items).toHaveLength(1);
    expect(t.items[0]).toMatchObject({ kind: "tool", toolId: "ghost", status: "ok" });
  });

  it("pretty-prints a structured result instead of one long line", () => {
    const t = reduceEvent(emptyTimeline, {
      type: "tool.complete",
      payload: { tool_id: "t", name: "x", result: { a: 1 } },
    });
    expect((t.items[0] as ToolItem).resultText).toBe('{\n  "a": 1\n}');
  });

  it("prefers result_text when the backend sends one", () => {
    const t = reduceEvent(emptyTimeline, {
      type: "tool.complete",
      payload: { tool_id: "t", name: "x", result: { a: 1 }, result_text: "原文" },
    });
    expect((t.items[0] as ToolItem).resultText).toBe("原文");
  });

  it("attaches a risk finding to the matching card", () => {
    const t = feed(
      emptyTimeline,
      { type: "tool.start", payload: { tool_id: "t1", name: "read_file" } },
      { type: "tool.output_risk", payload: { tool_id: "t1", risk: "high", findings: ["prompt injection"] } },
    );
    expect(t.items[0]).toMatchObject({ risk: "high" });
  });

  it("does not open a card for tool.generating (the model is still writing args)", () => {
    const t = reduceEvent(emptyTimeline, { type: "tool.generating", payload: { name: "terminal" } });
    expect(t.items).toHaveLength(0);
  });
});

describe("inferToolStatus", () => {
  it("honours an explicit error key", () => {
    expect(inferToolStatus({ error: "boom" })).toBe("error");
  });

  it("reads a failure out of the summary", () => {
    expect(inferToolStatus({ summary: "command failed (exit 1)" })).toBe("error");
    expect(inferToolStatus({ summary: "timed out after 30s" })).toBe("error");
  });

  it("reads a failure out of a structured result", () => {
    expect(inferToolStatus({ result: { error: "nope" } })).toBe("error");
  });

  it("treats a null error field in a structured result as success", () => {
    // Measured on a real terminal call: `{output, exit_code, error: null}` is a
    // success, and a key-presence check painted it red.
    expect(inferToolStatus({ result: { output: "hi", exit_code: 0, error: null } })).toBe("ok");
  });

  it("does not paint a success red just because the word appears in a result body", () => {
    expect(inferToolStatus({ summary: "wrote 3 files", result: "checked 0 errors" })).toBe("ok");
  });
});

describe("meta and misc", () => {
  it("keeps one status line and clears it when the turn ends", () => {
    const t = feed(emptyTimeline, { type: "status.update", payload: { kind: "compacting", text: "压缩上下文…" } });
    expect(t.meta.status).toBe("压缩上下文…");
    const done = reduceEvent(t, { type: "message.complete", payload: { text: "" } });
    expect(done.meta.status).toBe("");
  });

  it("falls back to the kind when a status line has no text", () => {
    const t = reduceEvent(emptyTimeline, { type: "status.update", payload: { kind: "goal" } });
    expect(t.meta.status).toBe("goal…");
  });

  it("tracks the auto-title", () => {
    const t = reduceEvent(emptyTimeline, { type: "session.title", payload: { title: "新标题" } });
    expect(t.meta.title).toBe("新标题");
  });

  it("surfaces error frames as error notices and stops the spinner", () => {
    const t = reduceEvent(feed(emptyTimeline, { type: "message.start" }), {
      type: "error",
      payload: { message: "agent 初始化失败" },
    });
    expect(t.items[0]).toMatchObject({ kind: "notice", tone: "error", text: "agent 初始化失败" });
    expect(t.meta.running).toBe(false);
  });

  it("ignores events it does not render", () => {
    const t = reduceEvent(emptyTimeline, { type: "pet.changed", payload: { anything: true } });
    expect(t).toBe(emptyTimeline);
  });

  it("treats a closed socket as disconnected without dropping the transcript", () => {
    const withText = feed(emptyTimeline, delta("保留我"));
    const t = reduceEvent(withText, { type: "gateway.closed" });
    expect(t.items).toHaveLength(1);
    expect(t.meta.connected).toBe(false);
  });
});

describe("optimistic user bubble", () => {
  it("appends pending, then binds the durable row id on ack", () => {
    const pending = appendUser(emptyTimeline, "你好");
    expect(pending.items[0]).toMatchObject({ kind: "user", text: "你好", pending: true });
    const acked = ackUser(pending, 42);
    expect(acked.items[0]).toMatchObject({ pending: false, rowId: 42 });
  });

  it("leaves the timeline alone when there is nothing pending", () => {
    const t = feed(emptyTimeline, delta("只有助手"));
    expect(ackUser(t, 1)).toBe(t);
  });

  it("seals the open bubble on settle without appending a phantom message", () => {
    const t = settleTimeline(feed(emptyTimeline, delta("被打断")));
    expect(t.items).toHaveLength(1);
    expect(t.items[0]).toMatchObject({ streaming: false, text: "被打断" });
    expect(t.meta.running).toBe(false);
  });
});
