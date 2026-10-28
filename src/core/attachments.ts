/**
 * Attachment staging.
 *
 * The composer holds files the user picked but has not sent yet. This module is
 * the pure bookkeeping for that queue plus the `@` path-reference token, so the
 * component only does DOM work.
 *
 * Wire side: `docs/01-protocol-contract.md` §4 (附件).
 */

export type AttachmentKind = "image" | "video" | "file" | "pdf";

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
  /**
   * Object URL of the local file, for the preview in the tray and in the sent
   * bubble. Created by the page (browser API), never by `core/`.
   */
  previewUrl?: string;
  /** Where the staging is, so the tray can say more than "…". */
  phase?: "reading" | "uploading";
  /** Bytes read off disk so far, 0..1. Absent while the upload phase runs. */
  readProgress?: number;
}

/**
 * One attachment as it appears inside a sent message.
 *
 * A snapshot, not the staging record: the tray entry is cleared on send, while
 * the bubble has to keep showing what was sent. `preview` survives only for the
 * send that produced it (it is a local object URL); a transcript read back from
 * the store has refs and names but no pixels — see `splitAttachmentRefs`.
 */
export interface MessageAttachment {
  kind: AttachmentKind;
  name: string;
  size?: number;
  /** Object URL / data URL of the local file, when this send has one. */
  preview?: string;
  /** The `@file:` / `@image:` reference the backend staged (files only). */
  ref?: string;
}

/** Which RPC carries which kind. */
export function attachMethodFor(kind: AttachmentKind): string {
  if (kind === "image") return "image.attach_bytes";
  if (kind === "pdf") return "pdf.attach";
  // No video RPC exists: the bytes go down `file.attach` like any other file,
  // which is also why a video is shown with a thumbnail instead of a player.
  return "file.attach";
}

/** True for the kinds the bubble renders as a square thumbnail. */
export function isPreviewable(kind: AttachmentKind): boolean {
  return kind === "image" || kind === "video";
}

/** Snapshot the ready entries of a staging queue for the message being sent. */
export function messageAttachments(queue: readonly Attachment[]): MessageAttachment[] {
  return queue
    .filter((item) => item.status === "ready")
    .map((item) => ({
      kind: item.kind,
      name: item.name,
      size: item.size,
      preview: item.previewUrl,
      ref: item.refText,
    }));
}

/**
 * Recover a turn's attachments from its stored text, and strip the parts of that
 * text which only ever existed for the model.
 *
 * Two things ride inside a user row that must not reach the bubble:
 *
 *  - the `@file:` / `@image:` reference tokens (`file.attach` returns one, the
 *    gateway projects an image as one) — they ARE the attachment;
 *  - the `--- Attached Context ---` footer the agent appends when it expands
 *    those references, which is the file's whole content plus a token count,
 *    written for the model. The desktop's title generator strips the same footer
 *    (`agent/title_generator.py`), which is a good sign it is not chat prose.
 *
 * So both are lifted out: the refs become an attachment row, the footer goes.
 */
export function splitAttachmentRefs(text: string): { text: string; refs: MessageAttachment[] } {
  const cut = text.search(/\n+--- (?:Attached Context|Context Warnings) ---/);
  const body = cut >= 0 ? text.slice(0, cut) : text;
  const refs: MessageAttachment[] = [];
  const kept: string[] = [];
  for (const line of body.split("\n")) {
    const match = /^@(file|image):(.+)$/.exec(line.trim());
    if (!match) {
      kept.push(line);
      continue;
    }
    const raw = (match[2] ?? "").trim();
    const value = /^[`"']/.test(raw) && raw.length > 1 && raw.at(-1) === raw[0] ? raw.slice(1, -1) : raw;
    const kind: AttachmentKind = match[1] === "image" ? "image" : "file";
    // The same reference can appear twice (the token, then the projection of an
    // image); one attachment is one row.
    if (!refs.some((ref) => ref.ref === `@${kind}:${value}`)) refs.push(refAttachment(kind, value));
  }
  const cleaned = kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return { text: cleaned, refs };
}

function refAttachment(kind: AttachmentKind, value: string): MessageAttachment {
  const name = value.split(/[\\/]/).pop() || value;
  return { kind, name, ref: `@${kind === "image" ? "image" : "file"}:${value}` };
}

/**
 * The percent to draw for a staging attachment, or null when it is unknown.
 *
 * Reading the file off disk is measurable; the JSON-RPC upload is one frame
 * with no progress channel, so that phase stays indeterminate on purpose
 * instead of faking a number.
 */
export function attachmentPercent(item: Attachment): number | null {
  if (item.status !== "staging" || item.phase !== "reading") return null;
  const p = item.readProgress;
  if (typeof p !== "number" || !Number.isFinite(p)) return null;
  return Math.max(0, Math.min(100, Math.round(p * 100)));
}

/** Extension/MIME → kind. PDFs get their own path because they are rendered page by page. */
export function classifyFile(name: string, mime?: string): AttachmentKind {
  const lower = name.toLowerCase();
  if (lower.endsWith(".pdf") || mime === "application/pdf") return "pdf";
  if (mime?.startsWith("image/")) return "image";
  if (mime?.startsWith("video/")) return "video";
  if (/\.(png|jpe?g|gif|webp|bmp|avif|svg)$/.test(lower)) return "image";
  if (/\.(mp4|webm|mov|m4v|ogv)$/.test(lower)) return "video";
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

/** The cap in MiB, for the on-screen reason. */
export const MAX_ATTACHMENT_MIB = Math.round(MAX_ATTACHMENT_BYTES / 1024 / 1024);

/**
 * Why a file was refused.
 *
 * A code rather than a sentence: this module is pure and has no locale, and the
 * screen that shows the rejection picks the words (`format.ts::rejectionLabel`).
 */
export type RejectionCode = "too_large" | "empty";

export interface Rejection {
  name: string;
  code: RejectionCode;
  /** Present on `too_large`: the limit, so the reason can quote it. */
  limitMib?: number;
}

/** Partition picked files into acceptable ones and rejections with a reason. */
export function screenFiles(
  files: readonly { name: string; size: number; type?: string }[],
): { accepted: { name: string; size: number; kind: AttachmentKind }[]; rejected: Rejection[] } {
  const accepted: { name: string; size: number; kind: AttachmentKind }[] = [];
  const rejected: Rejection[] = [];
  for (const file of files) {
    if (file.size > MAX_ATTACHMENT_BYTES) {
      rejected.push({ name: file.name, code: "too_large", limitMib: MAX_ATTACHMENT_MIB });
      continue;
    }
    if (file.size === 0) {
      rejected.push({ name: file.name, code: "empty" });
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

export function formatBytes(bytes: number | undefined): string {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}
