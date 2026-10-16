/**
 * Attachment staging.
 *
 * The composer holds files the user picked but has not sent yet. This module is
 * the pure bookkeeping for that queue plus the `@` path-reference token, so the
 * component only does DOM work.
 *
 * Wire side: `docs/01-protocol-contract.md` §4 (附件).
 */

export type AttachmentKind = "image" | "file" | "pdf";

export interface Attachment {
  /** Local id; the backend has no id for a staged attachment. */
  id: string;
  kind: AttachmentKind;
  name: string;
  /** Bytes when known (local picks); the backend's reply carries it too. */
  size?: number;
  /** `image.detach` addresses a queued image by its host path. */
  path?: string;
  /** Set once the backend accepted it and handed back a reference. */
  refText?: string;
  status: "staging" | "ready" | "error";
  error?: string;
}

/** Which RPC carries which kind. */
export function attachMethodFor(kind: AttachmentKind): string {
  if (kind === "image") return "image.attach_bytes";
  if (kind === "pdf") return "pdf.attach";
  return "file.attach";
}

/** Extension/MIME → kind. PDFs get their own path because they are rendered page by page. */
export function classifyFile(name: string, mime?: string): AttachmentKind {
  const lower = name.toLowerCase();
  if (lower.endsWith(".pdf") || mime === "application/pdf") return "pdf";
  if (mime?.startsWith("image/")) return "image";
  if (/\.(png|jpe?g|gif|webp|bmp|avif|svg)$/.test(lower)) return "image";
  return "file";
}

/**
 * Cap on a single attachment, in bytes.
 *
 * The backend accepts far more over one JSON-RPC frame, but a base64 payload
 * costs ~1.37× its size in memory on both sides and the whole frame has to be
 * built as one string. 12 MiB is comfortably inside what a browser can encode
 * without janking the tab, and a chat attachment bigger than that is a mistake
 * the user should hear about.
 */
export const MAX_ATTACHMENT_BYTES = 12 * 1024 * 1024;

export interface Rejection {
  name: string;
  reason: string;
}

/** Partition picked files into acceptable ones and rejections with a reason. */
export function screenFiles(
  files: readonly { name: string; size: number; type?: string }[],
): { accepted: { name: string; size: number; kind: AttachmentKind }[]; rejected: Rejection[] } {
  const accepted: { name: string; size: number; kind: AttachmentKind }[] = [];
  const rejected: Rejection[] = [];
  for (const file of files) {
    if (file.size > MAX_ATTACHMENT_BYTES) {
      rejected.push({
        name: file.name,
        reason: `超过 ${Math.round(MAX_ATTACHMENT_BYTES / 1024 / 1024)} MiB 上限`,
      });
      continue;
    }
    if (file.size === 0) {
      rejected.push({ name: file.name, reason: "空文件" });
      continue;
    }
    accepted.push({ name: file.name, size: file.size, kind: classifyFile(file.name, file.type) });
  }
  return { accepted, rejected };
}

export function addAttachment(queue: readonly Attachment[], item: Attachment): Attachment[] {
  return [...queue, item];
}

export function removeAttachment(queue: readonly Attachment[], id: string): Attachment[] {
  return queue.filter((item) => item.id !== id);
}

export function updateAttachment(
  queue: readonly Attachment[],
  id: string,
  patch: Partial<Attachment>,
): Attachment[] {
  return queue.map((item) => (item.id === id ? { ...item, ...patch } : item));
}

/** True when every staged attachment finished (or none are staged). */
export function allSettled(queue: readonly Attachment[]): boolean {
  return queue.every((item) => item.status !== "staging");
}

/** Only `ready` attachments can be sent; staging ones would arrive without a reference. */
export function readyAttachments(queue: readonly Attachment[]): Attachment[] {
  return queue.filter((item) => item.status === "ready");
}

export function hasFailed(queue: readonly Attachment[]): boolean {
  return queue.some((item) => item.status === "error");
}

/**
 * The `@` reference token under the caret.
 *
 * Same shape as the slash token but triggered by `@`, and it may contain path
 * characters. Kept separate from `findSlashToken` because the two never apply
 * at once and merging them would make both harder to read.
 */
export interface AtToken {
  raw: string;
  query: string;
  start: number;
  end: number;
}

export function findAtToken(text: string, caret: number): AtToken | null {
  const pos = Math.max(0, Math.min(caret, text.length));
  let start = -1;
  for (let i = pos - 1; i >= 0; i -= 1) {
    const ch = text[i];
    if (ch === "@") {
      start = i;
      break;
    }
    if (ch === undefined || /\s/.test(ch)) break;
  }
  if (start === -1) return null;
  if (start > 0) {
    const before = text[start - 1];
    if (before !== undefined && !/\s/.test(before)) return null;
  }
  return { raw: text.slice(start, pos), query: text.slice(start + 1, pos), start, end: pos };
}

export function applyAtCompletion(text: string, token: AtToken, replacement: string): { text: string; caret: number } {
  const inserted = `${replacement} `;
  const next = text.slice(0, token.start) + inserted + text.slice(token.end);
  return { text: next, caret: token.start + inserted.length };
}

export function formatBytes(bytes: number | undefined): string {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}
