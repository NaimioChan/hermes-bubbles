import { describe, expect, it } from "vitest";

import {
  addAttachment,
  allSettled,
  attachMethodFor,
  classifyFile,
  formatBytes,
  hasFailed,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENT_MIB,
  readyAttachments,
  removeAttachment,
  screenFiles,
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
  });

  it("falls back to the extension", () => {
    expect(classifyFile("shot.PNG")).toBe("image");
    expect(classifyFile("doc.pdf")).toBe("pdf");
    expect(classifyFile("main.ts")).toBe("file");
  });

  it("treats an unknown type as a plain file", () => {
    expect(classifyFile("archive.zip")).toBe("file");
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
