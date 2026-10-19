/**
 * Pulling another session in as context.
 *
 * There is no protocol verb for "use that stored session as background for this
 * one": `session.branch_stored` copies the transcript into a NEW session, and
 * `prompt.submit` carries text, not references. So the plugin reads the other
 * session's history (`session.history`) and writes a bounded, plain-text digest
 * into the composer draft. The user sees exactly what will be sent, can edit
 * it, and the model gets ordinary text, which no gateway version can reject.
 *
 * Everything here is pure: no DOM, no RPC, no locale detection.
 */

import { messagesFor, type Locale } from "./i18n";

/** Drag payload type for a stored session. Custom so file drops stay distinct. */
export const SESSION_CONTEXT_MIME = "application/x-hb-session";

/**
 * Budget for the whole digest. A long session is mostly tool chatter; what
 * matters is the tail (the last exchange usually states the conclusion), so the
 * formatter walks backwards from the newest message and stops when full.
 */
export const CONTEXT_MAX_CHARS = 8000;

/** Per-message ceiling, so one giant pasted file cannot eat the whole budget. */
export const CONTEXT_PER_MESSAGE_CHARS = 1500;

/**
 * What the formatter needs from a transcript row.
 *
 * Two shapes arrive here: the gateway's `TranscriptMessage` (`text`) and the
 * dashboard's REST projection (`GET /api/sessions/{id}/messages`), which carries
 * `content` — a string, or a list of `{type, text}` parts for multimodal turns —
 * and `display_content` for rewritten/hidden markers. Both are handled, so
 * either source can feed the digest.
 */
export interface ContextSourceMessage {
  role?: string | null;
  text?: string | null;
  content?: unknown;
  display_content?: unknown;
  display_kind?: string | null;
}

export interface SessionRef {
  id: string;
  title: string;
}

export interface ContextBlockOptions {
  locale: Locale;
  maxChars?: number;
  perMessageChars?: number;
}

export interface ContextBlock {
  /** Empty when the session carries no reusable text. */
  text: string;
  /** Messages that made it into the block. */
  included: number;
  /** Earlier messages dropped for budget, or tool/hidden rows skipped. */
  omitted: number;
}

/**
 * Rows worth reusing: user and assistant prose. Tool rows and `hidden`
 * scaffolding are model-facing noise, and system rows are the other session's
 * own instructions — carrying them over would assert them in this conversation.
 */
function usable(row: ContextSourceMessage): { role: "user" | "assistant"; text: string } | null {
  if (row.display_kind === "hidden") return null;
  const role = row.role === "user" || row.role === "assistant" ? row.role : null;
  if (!role) return null;
  const text = (
    textOf(row.display_content) || textOf(row.text) || textOf(row.content)
  ).trim();
  if (!text) return null;
  return { role, text };
}

/**
 * Text out of a content value: a plain string, or OpenAI-style parts where only
 * the textual ones matter (an image part says nothing in a text digest, and its
 * data URI would cost the entire budget).
 */
function textOf(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  const parts: string[] = [];
  for (const part of value) {
    if (typeof part === "string") {
      parts.push(part);
      continue;
    }
    if (!part || typeof part !== "object") continue;
    const record = part as Record<string, unknown>;
    const text = typeof record.text === "string" ? record.text : record.content;
    if (typeof text === "string" && text) parts.push(text);
  }
  return parts.join("\n");
}

function clip(text: string, limit: number): string {
  if (text.length <= limit) return text;
  // Keep the head: a message's first lines carry the ask or the verdict, and a
  // truncated tail on a long code block reads as corruption.
  return `${text.slice(0, limit).trimEnd()}…`;
}

function render(role: "user" | "assistant", text: string): string {
  return `[${role}]\n${text}`;
}

/**
 * Format a stored session's history into a context block.
 *
 * Returns `text: ""` when nothing usable survives; callers treat that as "this
 * session has nothing to offer" rather than inserting an empty header.
 */
export function sessionContextBlock(
  ref: SessionRef,
  messages: readonly ContextSourceMessage[],
  options: ContextBlockOptions,
): ContextBlock {
  const t = messagesFor(options.locale);
  const budget = options.maxChars ?? CONTEXT_MAX_CHARS;
  const perMessage = options.perMessageChars ?? CONTEXT_PER_MESSAGE_CHARS;

  const header = t.contextHeader(ref.title || ref.id.slice(0, 8));
  // Reserve the footer's room up front so the digest cannot overflow by it.
  const footerReserve = 120;
  const room = Math.max(budget - header.length - footerReserve, 0);

  const kept: string[] = [];
  let used = 0;
  let omitted = 0;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const row = messages[i];
    const entry = row ? usable(row) : null;
    if (!entry) {
      omitted += 1;
      continue;
    }
    const block = render(entry.role, clip(entry.text, perMessage));
    const cost = block.length + 2;
    if (used + cost > room) {
      // Everything earlier is older than what is already in: count and stop.
      omitted += i + 1;
      break;
    }
    kept.push(block);
    used += cost;
  }

  if (!kept.length) return { text: "", included: 0, omitted };

  kept.reverse();
  const footer = t.contextFooter(kept.length, omitted);
  return { text: `${header}\n\n${kept.join("\n\n")}\n\n${footer}`, included: kept.length, omitted };
}

/**
 * Drag payload for a history row. Title travels with the id so a drop into the
 * composer can name the session without a second round trip; `text/plain` keeps
 * a plain-text drop target (or the OS clipboard) from showing JSON.
 */
export function sessionDragPayload(ref: SessionRef): string {
  return JSON.stringify({ id: ref.id, title: ref.title });
}

/** Parse a dropped payload; tolerate a bare id from an older source. */
export function parseSessionDrop(raw: string | null | undefined): SessionRef | null {
  const value = (raw ?? "").trim();
  if (!value) return null;
  if (value.startsWith("{")) {
    try {
      const parsed = JSON.parse(value) as { id?: unknown; title?: unknown };
      if (typeof parsed.id === "string" && parsed.id) {
        return { id: parsed.id, title: typeof parsed.title === "string" ? parsed.title : "" };
      }
    } catch {
      return null;
    }
    return null;
  }
  // A stored id is opaque, but never contains whitespace.
  return /^[A-Za-z0-9_.:-]+$/.test(value) ? { id: value, title: "" } : null;
}

/**
 * Insert a context block into an existing draft, keeping the user's words.
 *
 * The block goes above whatever they already typed: the context is background
 * for the ask, and a question followed by three pages of transcript reads
 * backwards. Two newlines separate the parts so markdown does not merge them.
 */
export function insertContext(draft: string, block: string): string {
  const body = draft.trim();
  if (!body) return block;
  return `${block}\n\n${body}`;
}
