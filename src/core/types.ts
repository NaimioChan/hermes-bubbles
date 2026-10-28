/**
 * The transcript model.
 *
 * The backend speaks in *events* (a delta, a tool finishing) and *history rows*
 * (what is stored in SQLite). Both project onto this one shape, so a reloaded
 * session and a live turn render through the same component tree.
 *
 * Pure data. No DOM, no React, no transport. See AGENTS.md 铁律 1.
 */

import type { MessageAttachment } from "./attachments";

export interface Usage {
  model?: string;
  input?: number;
  output?: number;
  reasoning?: number;
  prompt?: number;
  completion?: number;
  total?: number;
  calls?: number;
  compressions?: number;
  /** Context window occupancy; `context_max` absent means no budget was reported. */
  context_used?: number;
  context_max?: number;
  context_percent?: number;
  context_source?: string;
  /** The backend estimated rather than measured — the UI prefixes `~`. */
  context_estimated?: boolean;
  /** Rolling cache hit rate; absent when the provider reports no cache reads. */
  cache_hit_pct?: number;
  cache_read?: number;
  cache_write?: number;
  avg_latency_s?: number;
  /** Rolling output throughput; absent before the first completed call. */
  avg_tps?: number;
  active_subagents?: number;
  cost_usd?: number;
  cost_status?: string;
  credits_lines?: string[];
}

/**
 * Every `at` / `completedAt` on a timeline item is UNIX MILLISECONDS.
 *
 * One unit, stated once: the formatters multiply by nothing, and a value from
 * the backend (seconds) is scaled exactly once where it enters the model. This
 * used to be mixed — history projected `ts * 1000` while live rows used
 * `Date.now()` — and the formatters assumed seconds on top, so a 02:46 turn
 * displayed as 19:32.
 */
export type Millis = number;

export interface UserItem {
  kind: "user";
  id: string;
  at: Millis;
  text: string;
  /**
   * Files this turn carried, drawn above the text.
   *
   * The gateway stages attachments on the session and mentions them inside the
   * prompt; nothing in the wire says "this row had a photo". So the send path
   * snapshots the composer's ready queue here, and a reopened session recovers
   * what it can from the row's trailing `@file:` / `@image:` references
   * (`core/attachments.ts::splitAttachmentRefs`).
   */
  attachments?: MessageAttachment[];
  /** Durable row id, when the backend has told us one. */
  rowId?: number;
  /**
   * How many assistant replies this turn has produced.
   *
   * Retry rewinds the turn and asks for a new reply. The bubble is keyed on the
   * turn plus this counter, so a retry replaces the reply in place instead of
   * appending a second one beside it.
   */
  generation?: number;
  /** True until the backend acknowledges the turn (prompt.submit reply). */
  pending?: boolean;
}

/**
 * One thinking segment (`reasoning.delta` / `reasoning.available`).
 *
 * Its own timeline item, not a field on the reply: a turn can think, call a
 * tool, think again, then answer, and each segment has to land where it
 * happened. Carrying reasoning on the assistant bubble forced every
 * think-only segment to materialise as an assistant row with empty text —
 * which rendered as a blank bubble with a lonely copy row under it.
 *
 * Reasoning is transcript furniture, not a message: it holds no copy/regenerate
 * affordances and renders as a dim one-line disclosure.
 */
export interface ReasoningItem {
  kind: "reasoning";
  id: string;
  at: Millis;
  text: string;
  /** Still receiving deltas. Drives the live caret and the collapsing tail. */
  streaming: boolean;
}

export interface AssistantItem {
  kind: "assistant";
  id: string;
  at: Millis;
  text: string;
  /** Still receiving deltas. Drives the caret and the stop button. */
  streaming: boolean;
  rowId?: number;
  error?: string;
  /** `status: "error"` with `partial: true`: `text` is real output, keep it. */
  partial?: boolean;
  usage?: Usage;
  /**
   * Wall-clock end of the turn, for the per-message timestamp.
   *
   * `at` is when the bubble was created (the turn's start), which is the wrong
   * number to print under a reply that streamed for a minute. Absent while
   * streaming.
   */
  completedAt?: Millis;
  /** Seconds the turn took, when the backend reported it. */
  durationS?: number;
}

export type ToolStatus = "running" | "ok" | "error";

export interface ToolItem {
  kind: "tool";
  id: string;
  at: Millis;
  /** Stable backend id (`tool.start` / `tool.complete` correlate on it). */
  toolId: string;
  name: string;
  /** One-line summary; from `tool.start.context` or `tool.complete.summary`. */
  summary: string;
  status: ToolStatus;
  args?: unknown;
  argsText?: string;
  resultText?: string;
  durationS?: number;
  /** `tool.output_risk.risk` — prompt-injection / secret findings. */
  risk?: string;
}

export interface NoticeItem {
  kind: "notice";
  id: string;
  at: Millis;
  text: string;
  tone: "info" | "error";
  /**
   * Set when this notice stands in for a backend machinery row (a background
   * process or delegation finishing, a model switch) rather than a sentence the
   * agent emitted. The renderer localises these instead of printing the raw
   * model-facing text, which is written for the model and reads like a log dump
   * inside a chat bubble.
   */
  noticeKind?: NoticeKind;
  /** Raw backend text, kept for the hover title only. */
  detail?: string;
}

/** Machinery rows the backend stores on the transcript, per `display_kind`. */
export type NoticeKind =
  | "process"
  | "subagents"
  | "background"
  | "model"
  | "continue"
  | "personality";

/**
 * One item of the agent's task list (`todo.updated`).
 *
 * `status` is `pending` / `in_progress` / `completed` / `cancelled`; `parent`
 * nests a subtask under another item's id. Both come straight off the wire —
 * this model does not interpret them beyond ordering the tree.
 */
export interface TodoEntry {
  id: string;
  content: string;
  status: string;
  parent?: string;
}

/** The authoritative task-list snapshot; `revision` is monotonic per session. */
export interface TodoState {
  todos: TodoEntry[];
  revision: number;
}

/** One delegated child (`subagent.*` frames). */
export type SubagentStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "error"
  | "timeout"
  | "interrupted";

export const TERMINAL_SUBAGENT_STATUSES: readonly SubagentStatus[] = [
  "completed",
  "failed",
  "error",
  "timeout",
  "interrupted",
];

export function isSubagentTerminal(status: SubagentStatus): boolean {
  return TERMINAL_SUBAGENT_STATUSES.includes(status);
}

export interface SubagentChild {
  /** `subagent_id` when the emitter sends one, else `idx:<task_index>`. */
  key: string;
  taskIndex: number;
  goal: string;
  status: SubagentStatus;
  model?: string;
  toolsets?: string[];
  toolCount: number;
  /** Name of the last tool the child called. */
  lastTool: string;
  /** Recent progress lines (batched tool names), newest last, capped. */
  progress: string[];
  /** Latest reasoning fragment; only the tail is kept. */
  thinking: string;
  summary?: string;
  durationS?: number;
  tokens?: { input?: number; output?: number };
  filesRead?: string[];
  filesWritten?: string[];
  /** Last few tool results the child produced (`output_tail`). */
  outputTail?: { tool: string; preview: string; isError: boolean }[];
}

/**
 * One `delegate_task` batch: the children spawned by a single call.
 *
 * Batch identity is `delegation_id` when the backend sends one; older emitters
 * omit it, so a batch also absorbs a frame whose `subagent_id` it already holds,
 * or — failing both — the last batch that still has an unclaimed slot.
 */
export interface SubagentsItem {
  kind: "subagents";
  id: string;
  at: Millis;
  /** `delegation_id`, or `flat:<parent_id>` when the backend sent none. */
  batchKey: string;
  /** Children the batch announced (`task_count`). */
  taskCount: number;
  depth?: number;
  children: SubagentChild[];
  /** Set once every child reached a terminal status. */
  finishedAt?: Millis;
}

export type TimelineItem =
  | UserItem
  | AssistantItem
  | ReasoningItem
  | ToolItem
  | NoticeItem
  | SubagentsItem;

/** Everything the page needs that is not part of the transcript. */
export interface SessionMeta {
  runtimeId: string | null;
  storedId: string | null;
  title: string;
  model: string;
  provider: string;
  /** Reasoning level the route is using; "" when the session has not said. */
  reasoningEffort: string;
  /**
   * The session's own working directory, as the backend reported it at create /
   * resume time. "" when it has none (the session runs in the launch directory,
   * which the backend deliberately does not treat as a workspace).
   */
  cwd: string;
  running: boolean;
  usage: Usage | null;
  /** Last `status.update.text`, cleared when the turn ends. */
  status: string;
  /**
   * A machine-side reason to show the status line even with no backend text.
   *
   * `core/` never produces prose: a dropped socket sets `"reconnecting"` and the
   * view picks the sentence from the catalog. Cleared alongside `status`.
   */
  statusKind: "" | "reconnecting";
  connected: boolean;
  /** Latest `todo.updated` snapshot (or the resumed session's `todo_state`). */
  todo: TodoState | null;
}

export const emptyMeta: SessionMeta = {
  runtimeId: null,
  storedId: null,
  title: "",
  model: "",
  provider: "",
  reasoningEffort: "",
  cwd: "",
  running: false,
  usage: null,
  status: "",
  statusKind: "",
  connected: false,
  todo: null,
};

export interface Timeline {
  items: TimelineItem[];
  meta: SessionMeta;
}

export const emptyTimeline: Timeline = { items: [], meta: { ...emptyMeta } };

/** The last assistant bubble, whether or not it is still streaming. */
export function lastAssistant(items: readonly TimelineItem[]): AssistantItem | null {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i];
    if (item && item.kind === "assistant") return item;
  }
  return null;
}

/** The bubble currently receiving `message.delta`, if any. */
export function openAssistant(items: readonly TimelineItem[]): AssistantItem | null {
  const last = lastAssistant(items);
  return last && last.streaming ? last : null;
}

export function findTool(items: readonly TimelineItem[], toolId: string): ToolItem | null {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i];
    if (item && item.kind === "tool" && item.toolId === toolId) return item;
  }
  return null;
}
