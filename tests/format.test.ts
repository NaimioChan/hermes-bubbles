import { describe, expect, it } from "vitest";

import {
  formatCount,
  formatDuration,
  rejectionLabel,
  runningLabel,
  toolLabel,
  toolPreview,
  TOOL_PREVIEW_CHARS,
} from "../src/ui/format";
import { messagesFor } from "../src/core/i18n";

const en = messagesFor("en");

describe("toolLabel", () => {
  it("translates known tools through the catalog", () => {
    expect(toolLabel("terminal", en)).toBe(en.toolTerminal);
    expect(toolLabel("read_file", en)).toBe(en.toolReadFile);
    expect(toolLabel("read_file", messagesFor("zh"))).toBe(messagesFor("zh").toolReadFile);
  });

  it("passes unknown tools through unchanged", () => {
    expect(toolLabel("mcp__thing__do", en)).toBe("mcp__thing__do");
  });

  it("leaves no CJK in an English label", () => {
    const cjk = /[\u4e00-\u9fff]/;
    for (const name of ["terminal", "read_file", "write_file", "patch", "web_search", "skill_view"]) {
      expect(cjk.test(toolLabel(name, en))).toBe(false);
    }
  });
});

describe("rejectionLabel", () => {
  it("quotes the limit on an oversized file", () => {
    expect(rejectionLabel({ name: "a.bin", code: "too_large", limitMib: 12 }, en)).toBe(en.attachmentTooLarge(12));
  });

  it("names an empty file", () => {
    expect(rejectionLabel({ name: "a.txt", code: "empty" }, en)).toBe(en.attachmentEmpty);
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
    expect(runningLabel({ status: "压缩上下文…", statusKind: "", running: true }, en)).toBe("压缩上下文…");
  });

  it("falls back to a catalog label while a turn is live", () => {
    expect(runningLabel({ status: "", statusKind: "", running: true }, en)).toBe(en.working);
  });

  it("shows the reconnect line in place of everything else", () => {
    expect(runningLabel({ status: "", statusKind: "reconnecting", running: false }, en)).toBe(en.reconnecting);
  });

  it("is empty when idle", () => {
    expect(runningLabel({ status: "", statusKind: "", running: false }, en)).toBe("");
  });
});
