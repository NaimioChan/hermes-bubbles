import { describe, expect, it } from "vitest";

import { messagesFor } from "../src/core/i18n";
import { noticeText, subagentCount } from "../src/core/notice";
import type { NoticeItem } from "../src/core/types";

const notice = (over: Partial<NoticeItem>): NoticeItem => ({
  kind: "notice",
  id: "n1",
  at: 1_700_000_000_000,
  text: "",
  tone: "info",
  ...over,
});

describe("machinery notices", () => {
  it("says each kind in the reader's language", () => {
    for (const locale of ["en", "zh"] as const) {
      expect(noticeText(notice({ noticeKind: "process" }), locale)).toBe(messagesFor(locale).noticeProcess);
      expect(noticeText(notice({ noticeKind: "model" }), locale)).toBe(messagesFor(locale).noticeModel);
      expect(noticeText(notice({ noticeKind: "background" }), locale)).toBe(messagesFor(locale).noticeBackground);
      expect(noticeText(notice({ noticeKind: "continue" }), locale)).toBe(messagesFor(locale).noticeContinue);
      expect(noticeText(notice({ noticeKind: "personality" }), locale)).toBe(
        messagesFor(locale).noticePersonality,
      );
    }
  });

  it("carries a delegation batch's child count into the sentence", () => {
    const en = messagesFor("en");
    const zh = messagesFor("zh");
    const detail = [
      "[IMPORTANT: 2 background processes completed. Treat these results as one batch]",
      "[IMPORTANT: Background process proc_a exited (exit code 0).",
      "[IMPORTANT: Background process proc_b exited (exit code 1).",
    ].join("\n");
    // Two children, not three envelopes: the batch header is the batch, not a
    // finished child.
    expect(subagentCount(detail)).toBe(3);
    expect(noticeText(notice({ noticeKind: "subagents", detail }), "en")).toBe(en.noticeSubagents(3));
    expect(noticeText(notice({ noticeKind: "subagents", detail }), "zh")).toBe(zh.noticeSubagents(3));
  });

  it("falls back through prose, then to one, rather than printing NaN", () => {
    expect(subagentCount("3 background processes completed.")).toBe(3);
    expect(subagentCount("1 delegation completed")).toBe(1);
    expect(subagentCount("")).toBe(1);
    expect(subagentCount("no numbers here")).toBe(1);
    expect(messagesFor("en").noticeSubagents(1)).toBe("1 background agent finished");
    expect(messagesFor("en").noticeSubagents(4)).toBe("4 background agents finished");
  });

  it("keeps the raw text for an unknown kind instead of blanking the row", () => {
    expect(noticeText(notice({ text: "原样显示" }), "zh")).toBe("原样显示");
  });
});
