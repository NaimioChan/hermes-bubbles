import { describe, expect, it } from "vitest";

import {
  formatCount,
  formatDuration,
  runningLabel,
  toolLabel,
  toolPreview,
  TOOL_PREVIEW_CHARS,
} from "../src/ui/format";

describe("toolLabel", () => {
  it("translates known tools", () => {
    expect(toolLabel("terminal")).toBe("执行命令");
    expect(toolLabel("read_file")).toBe("读取文件");
  });

  it("passes unknown tools through unchanged", () => {
    expect(toolLabel("mcp__thing__do")).toBe("mcp__thing__do");
  });
});

describe("toolPreview", () => {
  it("returns a short result whole", () => {
    expect(toolPreview("ok")).toEqual({ text: "ok", truncated: false });
  });

  it("treats a missing result as empty rather than throwing", () => {
    expect(toolPreview(undefined)).toEqual({ text: "", truncated: false });
  });

  it("trims trailing whitespace so the collapsed card has no dead space", () => {
    expect(toolPreview("ok\n\n   ")).toEqual({ text: "ok", truncated: false });
  });

  it("cuts on a line boundary when one is available", () => {
    const line = "x".repeat(50);
    const result = Array.from({ length: 20 }, () => line).join("\n");
    const preview = toolPreview(result, 300);
    expect(preview.truncated).toBe(true);
    expect(preview.text.length).toBeLessThanOrEqual(300);
    // No dangling partial line: the cut lands right after a newline.
    expect(result.startsWith(preview.text)).toBe(true);
    expect(result[preview.text.length]).toBe("\n");
  });

  it("falls back to a hard cut when there is no useful line break", () => {
    const preview = toolPreview("y".repeat(1000), 300);
    expect(preview.text).toHaveLength(300);
    expect(preview.truncated).toBe(true);
  });

  it("never exceeds the default budget", () => {
    const preview = toolPreview("z".repeat(TOOL_PREVIEW_CHARS * 3));
    expect(preview.text.length).toBeLessThanOrEqual(TOOL_PREVIEW_CHARS);
  });
});

describe("formatDuration", () => {
  it("renders sub-second durations in milliseconds", () => {
    expect(formatDuration(0.25)).toBe("250ms");
  });

  it("renders seconds with one decimal", () => {
    expect(formatDuration(1.5)).toBe("1.5s");
  });

  it("renders minutes and seconds past a minute", () => {
    expect(formatDuration(75)).toBe("1m15s");
  });

  it("returns an empty string when there is no duration", () => {
    expect(formatDuration(undefined)).toBe("");
    expect(formatDuration(Number.NaN)).toBe("");
  });
});

describe("formatCount", () => {
  it("shows small numbers as-is", () => {
    expect(formatCount(999)).toBe("999");
  });

  it("abbreviates thousands and millions", () => {
    expect(formatCount(1_500)).toBe("1.5k");
    expect(formatCount(25_000)).toBe("25k");
    expect(formatCount(2_500_000)).toBe("2.5M");
  });

  it("returns an empty string for a missing count", () => {
    expect(formatCount(undefined)).toBe("");
  });
});

describe("runningLabel", () => {
  it("prefers the backend's status line", () => {
    expect(runningLabel({ status: "压缩上下文…", running: true })).toBe("压缩上下文…");
  });

  it("falls back to a generic label while a turn is live", () => {
    expect(runningLabel({ status: "", running: true })).toBe("正在处理…");
  });

  it("is empty when idle", () => {
    expect(runningLabel({ status: "", running: false })).toBe("");
  });
});
