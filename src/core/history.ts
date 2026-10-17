/**
 * `TranscriptMessage[]` → `Timeline`.
 *
 * A reloaded session arrives as history rows, not events. This projects them
 * onto the same `TimelineItem` shape `reduceEvent` produces, so the renderer
 * has exactly one input type.
 *
 * Row semantics: `docs/01-protocol-contract.md` §7.
 */

import type { AssistantItem, Timeline, TimelineItem, ToolItem, Usage } from "./types";

export interface TranscriptMessage {
  role?: string;
  text?: string | null;
  content?: unknown;
  tool_call_id?: string | null;
  timestamp?: number | null;
  row_id?: number | null;
  display_kind?: string | null;
  display_metadata?: unknown;
  name?: string | null;
  context?: string | null;
  args?: Record<string, unknown> | null;
  reasoning?: string | null;
  /** Assistant detail sidecars beyond `reasoning`. */
  [key: string]: unknown;
}

let historyCounter = 0;
function historyId(prefix: string): string {
  historyCounter += 1;
  return `h${prefix}-${historyCounter}`;
}

/** Test hook. */
export function resetHistoryIdCounter(): void {
  historyCounter = 0;
}

function textOf(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

const ASSISTANT_DETAIL_KEYS = ["reasoning", "thinking", "reasoning_text"] as const;

function assistantReasoning(row: TranscriptMessage): string {
  const parts: string[] = [];
  for (const key of ASSISTANT_DETAIL_KEYS) {
    const value = row[key];
    if (typeof value === "string" && value.trim()) parts.push(value);
  }
  return parts.join("\n\n");
}

/**
 * A history row's timestamp, in MILLISECONDS (the unit every timeline item uses).
 *
 * The wire sends seconds. This is the one place that scaling happens; nothing
 * downstream multiplies again.
 */
function timestampOf(row: TranscriptMessage, fallback: number): number {
  const ts = row.timestamp;
  if (typeof ts !== "number" || !Number.isFinite(ts) || ts <= 0) return fallback;
  // Guard against a source that already sends milliseconds (a value this large
  // cannot be a plausible seconds-since-epoch stamp).
  return ts > 1e11 ? ts : ts * 1000;
}

/**
 * Project history rows. `hidden` rows are model-facing scaffolding and are
 * dropped; tool rows are kept with whatever the projection carries.
 */
export function projectHistory(messages: readonly TranscriptMessage[], now = Date.now()): TimelineItem[] {
  const items: TimelineItem[] = [];

  for (const row of messages) {
    const role = row.role;
    if (role !== "user" && role !== "assistant" && role !== "tool" && role !== "system") continue;
    if (row.display_kind === "hidden") continue;

    const at = timestampOf(row, now);
    const rowId = typeof row.row_id === "number" ? row.row_id : undefined;

    if (role === "tool") {
      const name = row.name ?? "tool";
      const item: ToolItem = {
        kind: "tool",
        id: historyId("tool"),
        at,
        toolId: row.tool_call_id ?? "",
        name,
        summary: row.context ?? "",
        // History does not record whether a call failed; the summary line is
        // the only signal and it is a display projection, not a verdict.
        status: "ok",
        args: row.args ?? undefined,
        resultText: row.content === undefined ? undefined : textOf(row.content),
      };
      items.push(item);
      continue;
    }

    const text = typeof row.text === "string" ? row.text : "";
    if (role === "user") {
      if (!text.trim()) continue;
      items.push({ kind: "user", id: historyId("user"), at, text, rowId });
      continue;
    }

    if (role === "assistant") {
      const reasoning = assistantReasoning(row);
      if (!text.trim() && !reasoning) continue;
      const item: AssistantItem = {
        kind: "assistant",
        id: historyId("assistant"),
        at,
        text,
        reasoning,
        streaming: false,
        rowId,
      };
      items.push(item);
      continue;
    }

    // system rows carry model-facing notes; surface them as notices rather
    // than pretending they are a speaker.
    if (!text.trim()) continue;
    items.push({ kind: "notice", id: historyId("notice"), at, text, tone: "info" });
  }

  return items;
}

export interface LiveSessionSnapshot {
  session_id?: string;
  stored_session_id?: string | null;
  messages?: TranscriptMessage[];
  message_count?: number;
  running?: boolean | null;
  info?: {
    model?: string;
    provider?: string;
    title?: string;
    running?: boolean;
    reasoning_effort?: string;
    usage?: Usage | null;
  } | null;
}

/** Build a full timeline from a `session.create` / `session.resume` / `session.activate` result. */
export function timelineFromSnapshot(snapshot: LiveSessionSnapshot, now = Date.now()): Timeline {
  const info = snapshot.info ?? {};
  return {
    items: projectHistory(snapshot.messages ?? [], now),
    meta: {
      runtimeId: snapshot.session_id ?? null,
      storedId: snapshot.stored_session_id ?? null,
      title: info.title ?? "",
      model: info.model ?? "",
      provider: info.provider ?? "",
      reasoningEffort: info.reasoning_effort ?? "",
      running: Boolean(info.running ?? snapshot.running),
      usage: info.usage ?? null,
      status: "",
      connected: true,
    },
  };
}
