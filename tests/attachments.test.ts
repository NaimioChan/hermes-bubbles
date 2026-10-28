import { describe, expect, it } from "vitest";

import {
  addAttachment,
  allSettled,
  attachMethodFor,
  attachmentPercent,
  classifyFile,
  formatBytes,
  hasFailed,
  isPreviewable,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENT_MIB,
  messageAttachments,
  readyAttachments,
  removeAttachment,
  screenFiles,
  splitAttachmentRefs,
  updateAttachment,
  type Attachment,
} from "../src/core/attachments";

function make(id: string, over: Partial<Attachment> = {}): Attachment {
  return { id, kind: "file", name: `${id}.txt`, status: "ready", ...over };
}

describe("classifyFile", () => {
  it("classifies by MIME first", () => {
    expect(classifyFile("whatever", "image/png")).toBe("image");
    expect(classifyFile("whatever", "application/pdf")).toBe("pdf");
    expect(classifyFile("whatever", "video/mp4")).toBe("video");
  });

  it("falls back to the extension", () => {
    expect(classifyFile("shot.PNG")).toBe("image");
    expect(classifyFile("doc.pdf")).toBe("pdf");
    expect(classifyFile("clip.MOV")).toBe("video");
    expect(classifyFile("main.ts")).toBe("file");
  });

  it("treats an unknown type as a plain file", () => {
    expect(classifyFile("archive.zip")).toBe("file");
  });
});

describe("classifyFile video", () => {
  it("sends a video down file.attach — there is no video RPC", () => {
    expect(attachMethodFor("video")).toBe("file.attach");
  });

  it("previews images and videos, not documents", () => {
    expect(isPreviewable("image")).toBe(true);
    expect(isPreviewable("video")).toBe(true);
    expect(isPreviewable("pdf")).toBe(false);
    expect(isPreviewable("file")).toBe(false);
  });
});

describe("attachMethodFor", () => {
  it("routes each kind to its RPC", () => {
    expect(attachMethodFor("image")).toBe("image.attach_bytes");
    expect(attachMethodFor("pdf")).toBe("pdf.attach");
    expect(attachMethodFor("file")).toBe("file.attach");
  });
});

describe("screenFiles", () => {
  it("accepts ordinary files and reports their kind", () => {
    const { accepted, rejected } = screenFiles([{ name: "a.png", size: 100, type: "image/png" }]);
    expect(rejected).toEqual([]);
    expect(accepted).toEqual([{ name: "a.png", size: 100, kind: "image" }]);
  });

  it("rejects an oversized file with the limit it broke", () => {
    const { accepted, rejected } = screenFiles([
      { name: "huge.bin", size: MAX_ATTACHMENT_BYTES + 1, type: "" },
    ]);
    expect(accepted).toEqual([]);
    expect(rejected[0]).toMatchObject({ name: "huge.bin", code: "too_large", limitMib: MAX_ATTACHMENT_MIB });
  });

  it("accepts a file exactly at the limit", () => {
    const { accepted } = screenFiles([{ name: "edge.bin", size: MAX_ATTACHMENT_BYTES, type: "" }]);
    expect(accepted).toHaveLength(1);
  });

  it("rejects an empty file", () => {
    const { rejected } = screenFiles([{ name: "empty.txt", size: 0, type: "" }]);
    expect(rejected[0]?.code).toBe("empty");
  });

  it("keeps the good ones when a batch is mixed", () => {
    const { accepted, rejected } = screenFiles([
      { name: "ok.txt", size: 10, type: "" },
      { name: "bad.bin", size: MAX_ATTACHMENT_BYTES + 1, type: "" },
    ]);
    expect(accepted.map((f) => f.name)).toEqual(["ok.txt"]);
    expect(rejected.map((f) => f.name)).toEqual(["bad.bin"]);
  });
});

describe("queue bookkeeping", () => {
  it("adds and removes by id", () => {
    const queue = addAttachment([], make("a"));
    expect(queue).toHaveLength(1);
    expect(removeAttachment(queue, "a")).toEqual([]);
  });

  it("patches one entry without touching the others", () => {
    const queue = [make("a"), make("b")];
    const next = updateAttachment(queue, "b", { status: "error", error: "boom" });
    expect(next[0]).toMatchObject({ id: "a", status: "ready" });
    expect(next[1]).toMatchObject({ id: "b", status: "error", error: "boom" });
  });

  it("ignores a patch for an unknown id", () => {
    const queue = [make("a")];
    expect(updateAttachment(queue, "zz", { status: "error" })).toEqual(queue);
  });
});

describe("gating a send", () => {
  it("is settled when nothing is staging", () => {
    expect(allSettled([])).toBe(true);
    expect(allSettled([make("a")])).toBe(true);
    expect(allSettled([make("a", { status: "staging" })])).toBe(false);
  });

  it("only sends ready attachments — a staging one has no reference yet", () => {
    const queue = [make("a"), make("b", { status: "staging" }), make("c", { status: "error" })];
    expect(readyAttachments(queue).map((a) => a.id)).toEqual(["a"]);
  });

  it("detects a failed attachment", () => {
    expect(hasFailed([make("a")])).toBe(false);
    expect(hasFailed([make("a", { status: "error" })])).toBe(true);
  });
});

// `findAtToken` / `applyAtCompletion` are gone with the `@` completion feature:
// the backend keys `complete.path` on a word that INCLUDES the leading `@`, and
// this client sent the bare query, so it never matched. Files are attached with
// the `+` button now, so there is no `@` token to find.
describe("formatBytes", () => {
  it("formats each magnitude", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2 KiB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MiB");
  });

  it("is empty for a missing or invalid size", () => {
    expect(formatBytes(undefined)).toBe("");
    expect(formatBytes(-1)).toBe("");
  });
});

describe("a sent message carries its attachments", () => {
  it("snapshots only what the backend accepted", () => {
    const queue: Attachment[] = [
      make("a", { kind: "image", name: "shot.png", previewUrl: "blob:1", size: 2048 }),
      make("b", { status: "error" }),
      make("c", { status: "staging" }),
      make("d", { kind: "file", name: "notes.txt", refText: "@file:notes.txt" }),
    ];
    expect(messageAttachments(queue)).toEqual([
      { kind: "image", name: "shot.png", size: 2048, preview: "blob:1", ref: undefined },
      { kind: "file", name: "notes.txt", size: undefined, preview: undefined, ref: "@file:notes.txt" },
    ]);
  });

  it("reads trailing refs back off a stored row", () => {
    // The gateway projects an attached image onto the row as a ref line; a
    // reopen must show it as an attachment, not as a path in the prose.
    const split = splitAttachmentRefs("what is this\n\n@image:/home/u/.hermes/images/upload_ab12.png");
    expect(split.text).toBe("what is this");
    expect(split.refs).toEqual([
      { kind: "image", name: "upload_ab12.png", ref: "@image:/home/u/.hermes/images/upload_ab12.png" },
    ]);
  });

  it("strips the model-facing attached-context footer", () => {
    // A real stored row: the gateway keeps the ref AND appends the expanded
    // file for the model. Neither belongs in the bubble.
    const stored =
      "what colour is this\n\n@file:notes.txt\n\n--- Attached Context ---\n\n" +
      "📄 @file:notes.txt (5 tokens)\n```\nhello\n```";
    const split = splitAttachmentRefs(stored);
    expect(split.text).toBe("what colour is this");
    expect(split.refs).toHaveLength(1);
    expect(split.refs[0]).toMatchObject({ kind: "file", name: "notes.txt" });
  });

  it("collapses a duplicated reference to one attachment", () => {
    const split = splitAttachmentRefs("look\n@image:/a/b.png\n@image:/a/b.png");
    expect(split.refs).toHaveLength(1);
    expect(split.text).toBe("look");
  });

  it("keeps a ref in the middle of a message out of the prose", () => {
    const split = splitAttachmentRefs("before\n@file:notes.txt\nafter");
    expect(split.text).toBe("before\nafter");
    expect(split.refs).toHaveLength(1);
  });

  it("unquotes a ref value that needed quoting", () => {
    const split = splitAttachmentRefs('look\n@file:"my notes/todo.md"');
    expect(split.text).toBe("look");
    expect(split.refs[0]).toMatchObject({ kind: "file", name: "todo.md", ref: "@file:my notes/todo.md" });
  });

  it("leaves a message with no refs exactly as it was", () => {
    expect(splitAttachmentRefs("plain text\nwith two lines")).toEqual({
      text: "plain text\nwith two lines",
      refs: [],
    });
  });

  it("keeps a bare attachment-only turn as an attachment row", () => {
    const split = splitAttachmentRefs("@file:notes.txt");
    expect(split.text).toBe("");
    expect(split.refs).toHaveLength(1);
  });
});

describe("staging progress", () => {
  it("reports a percentage while the file is being read", () => {
    const item = make("a", { status: "staging", phase: "reading", readProgress: 0.42 });
    expect(attachmentPercent(item)).toBe(42);
  });

  it("has no number once the upload frame is on the wire", () => {
    expect(attachmentPercent(make("a", { status: "staging", phase: "uploading" }))).toBeNull();
    expect(attachmentPercent(make("a"))).toBeNull();
  });
});
