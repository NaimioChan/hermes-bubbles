import { describe, expect, it } from "vitest";

import {
  CONTEXT_MAX_CHARS,
  CONTEXT_PER_MESSAGE_CHARS,
  insertContext,
  parseSessionDrop,
  sessionContextBlock,
  sessionDragPayload,
} from "../src/core/context";

const ref = { id: "20261019_120000", title: "Earlier work" };

function msg(role: string, text: string, extra: Record<string, unknown> = {}) {
  return { role, text, ...extra };
}

describe("sessionContextBlock", () => {
  it("keeps user and assistant prose in order, with a titled header", () => {
    const block = sessionContextBlock(ref, [msg("user", "hi"), msg("assistant", "hello")], {
      locale: "en",
    });
    expect(block.text).toContain('Session context: "Earlier work"');
    expect(block.text.indexOf("[user]")).toBeLessThan(block.text.indexOf("[assistant]"));
    expect(block.included).toBe(2);
    expect(block.omitted).toBe(0);
    expect(block.text.trim().endsWith("===")).toBe(true);
  });

  it("drops tool rows, hidden scaffolding and system instructions", () => {
    const block = sessionContextBlock(
      ref,
      [
        msg("system", "you are a robot"),
        msg("user", "ask"),
        msg("tool", "raw tool output"),
        msg("assistant", "hidden reply", { display_kind: "hidden" }),
        msg("assistant", "real answer"),
      ],
      { locale: "en" },
    );
    expect(block.text).not.toContain("you are a robot");
    expect(block.text).not.toContain("raw tool output");
    expect(block.text).not.toContain("hidden reply");
    expect(block.text).toContain("real answer");
    expect(block.included).toBe(2);
    // Five rows in, two kept, three not.
    expect(block.omitted).toBe(3);
  });

  it("returns an empty block for a session with no prose", () => {
    const block = sessionContextBlock({ id: "abc", title: "" }, [msg("tool", "x")], { locale: "en" });
    expect(block.text).toBe("");
    expect(block.included).toBe(0);
  });

  it("keeps the newest messages and counts what it dropped", () => {
    const rows = Array.from({ length: 40 }, (_, i) => msg("user", `message ${i} ${"x".repeat(200)}`));
    const block = sessionContextBlock(ref, rows, { locale: "en" });
    expect(block.text.length).toBeLessThanOrEqual(CONTEXT_MAX_CHARS);
    expect(block.text).toContain("message 39");
    expect(block.text).not.toContain("message 0 ");
    expect(block.included + block.omitted).toBe(rows.length);
    expect(block.text).toContain("earlier ones omitted");
  });

  it("clips a single oversized message", () => {
    const block = sessionContextBlock(ref, [msg("user", "y".repeat(5000)), msg("assistant", "ok")], {
      locale: "en",
      maxChars: 20000,
    });
    expect(block.text).toContain("ok");
    const clipped = block.text.slice(block.text.indexOf("[user]"));
    expect(clipped.indexOf("\n\n")).toBeLessThan(CONTEXT_PER_MESSAGE_CHARS + 100);
    expect(block.text).toContain("…");
  });

  it("reads the REST projection's `content` field too (string and parts)", () => {
    const block = sessionContextBlock(
      ref,
      [
        { role: "user", content: "plain string content" },
        {
          role: "user",
          content: [
            { type: "text", text: "part one" },
            { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
          ],
        },
        { role: "assistant", content: "", display_content: "rewritten reply" },
      ],
      { locale: "en" },
    );
    expect(block.text).toContain("plain string content");
    expect(block.text).toContain("part one");
    expect(block.text).not.toContain("base64");
    expect(block.text).toContain("rewritten reply");
    expect(block.included).toBe(3);
  });

  it("localizes the framing but never touches the transcript itself", () => {
    const block = sessionContextBlock(ref, [msg("user", "保持原文")], { locale: "zh" });
    expect(block.text).toContain("会话上下文");
    expect(block.text).toContain("[user]\n保持原文");
  });

  it("falls back to the id when the session has no title", () => {
    const block = sessionContextBlock({ id: "abcdef123456", title: "" }, [msg("user", "x")], {
      locale: "en",
    });
    expect(block.text).toContain("abcdef12");
  });
});

describe("drag payloads", () => {
  it("round-trips id and title", () => {
    const raw = sessionDragPayload({ id: "s1", title: "Title" });
    expect(parseSessionDrop(raw)).toEqual({ id: "s1", title: "Title" });
  });

  it("accepts a bare id from a plain-text drop", () => {
    expect(parseSessionDrop("20261019_120000")).toEqual({ id: "20261019_120000", title: "" });
  });

  it("rejects junk rather than inventing an id", () => {
    expect(parseSessionDrop("")).toBeNull();
    expect(parseSessionDrop("   ")).toBeNull();
    expect(parseSessionDrop("{not json")).toBeNull();
    expect(parseSessionDrop('{"title":"no id"}')).toBeNull();
    expect(parseSessionDrop("/tmp/file.txt")).toBeNull();
  });
});

describe("insertContext", () => {
  it("puts the context above an existing draft, separated by a blank line", () => {
    expect(insertContext("my question", "CONTEXT")).toBe("CONTEXT\n\nmy question");
  });

  it("does not add leading blank lines to an empty draft", () => {
    expect(insertContext("   ", "CONTEXT")).toBe("CONTEXT");
  });
});
