import { beforeEach, describe, expect, it } from "vitest";

import { projectHistory, resetHistoryIdCounter, timelineFromSnapshot } from "../src/core/history";

beforeEach(() => {
  resetHistoryIdCounter();
});

describe("projectHistory", () => {
  it("projects user and assistant rows in order", () => {
    const items = projectHistory([
      { role: "user", text: "你好", row_id: 1, timestamp: 1_700_000_000 },
      { role: "assistant", text: "你好，有什么可以帮的", row_id: 2 },
    ]);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ kind: "user", text: "你好", rowId: 1 });
    expect(items[1]).toMatchObject({ kind: "assistant", text: "你好，有什么可以帮的", streaming: false });
  });

  it("converts the timestamp from unix seconds to milliseconds", () => {
    const items = projectHistory([{ role: "user", text: "x", timestamp: 1_700_000_000 }]);
    expect(items[0]?.at).toBe(1_700_000_000_000);
  });

  it("drops hidden rows (model-facing scaffolding)", () => {
    const items = projectHistory([
      { role: "user", text: "系统脚手架", display_kind: "hidden" },
      { role: "user", text: "真实提问" },
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ text: "真实提问" });
  });

  it("drops empty rows", () => {
    const items = projectHistory([
      { role: "user", text: "   " },
      { role: "assistant", text: "" },
      { role: "user", text: "有内容" },
    ]);
    expect(items).toHaveLength(1);
  });

  it("projects tool rows with args and result, keyed by tool_call_id", () => {
    const items = projectHistory([
      {
        role: "tool",
        name: "read_file",
        tool_call_id: "call-1",
        context: "读取 src/app.ts",
        args: { path: "src/app.ts" },
        content: "file body",
      },
    ]);
    expect(items[0]).toMatchObject({
      kind: "tool",
      name: "read_file",
      toolId: "call-1",
      summary: "读取 src/app.ts",
      args: { path: "src/app.ts" },
      resultText: "file body",
    });
  });

  it("leaves resultText undefined when the projection omitted content", () => {
    const items = projectHistory([{ role: "tool", name: "terminal", tool_call_id: "c", context: "ls" }]);
    expect(items[0]).toMatchObject({ kind: "tool" });
    expect((items[0] as { resultText?: string }).resultText).toBeUndefined();
  });

  it("carries assistant reasoning sidecars", () => {
    const items = projectHistory([{ role: "assistant", text: "答", reasoning: "因为…" }]);
    expect(items[0]).toMatchObject({ reasoning: "因为…" });
  });

  it("keeps a reasoning-only assistant row", () => {
    const items = projectHistory([{ role: "assistant", text: "", reasoning: "只有推理" }]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "assistant", reasoning: "只有推理" });
  });

  it("renders system rows as notices, not as a speaker", () => {
    const items = projectHistory([{ role: "system", text: "会话已压缩" }]);
    expect(items[0]).toMatchObject({ kind: "notice", tone: "info", text: "会话已压缩" });
  });

  it("ignores unknown roles", () => {
    const items = projectHistory([{ role: "widget", text: "?" }]);
    expect(items).toHaveLength(0);
  });

  it("stringifies a structured tool content value", () => {
    const items = projectHistory([{ role: "tool", name: "x", content: { ok: true } }]);
    expect((items[0] as { resultText?: string }).resultText).toBe('{\n  "ok": true\n}');
  });
});

describe("timelineFromSnapshot", () => {
  it("reads ids, model and running state out of the snapshot", () => {
    const timeline = timelineFromSnapshot({
      session_id: "runtime-1",
      stored_session_id: "20261016_120000_abc",
      messages: [{ role: "user", text: "hi" }],
      info: { model: "deepseek-v4.1-flash", provider: "custom:hetune", title: "标题", running: true },
    });
    expect(timeline.meta).toMatchObject({
      runtimeId: "runtime-1",
      storedId: "20261016_120000_abc",
      model: "deepseek-v4.1-flash",
      provider: "custom:hetune",
      title: "标题",
      running: true,
      connected: true,
    });
    expect(timeline.items).toHaveLength(1);
  });

  it("survives a snapshot with no info block", () => {
    const timeline = timelineFromSnapshot({ session_id: "s" });
    expect(timeline.meta.runtimeId).toBe("s");
    expect(timeline.meta.running).toBe(false);
    expect(timeline.items).toEqual([]);
  });

  it("prefers info.running over the top-level flag when both are present", () => {
    const timeline = timelineFromSnapshot({ session_id: "s", running: false, info: { running: true } });
    expect(timeline.meta.running).toBe(true);
  });
});
