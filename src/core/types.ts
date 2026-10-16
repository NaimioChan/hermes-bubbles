/**
 * The transcript model.
 *
 * The backend speaks in *events* (a delta, a tool finishing) and *history rows*
 * (what is stored in SQLite). Both project onto this one shape, so a reloaded
 * session and a live turn render through the same component tree.
 *
 * Pure data. No DOM, no React, no transport. See AGENTS.md 铁律 1.
 */

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

export interface UserItem {
  kind: "user";
  id: string;
  at: number;
  text: string;
  /** Durable row id, when the backend has told us one. */
  rowId?: number;
  /** True until the backend acknowledges the turn (prompt.submit reply). */
  pending?: boolean;
}

export interface AssistantItem {
  kind: "assistant";
  id: string;
  at: number;
  text: string;
  reasoning: string;
  /** Still receiving deltas. Drives the caret and the stop button. */
  streaming: boolean;
  rowId?: number;
  error?: string;
  /** `status: "error"` with `partial: true`: `text` is real output, keep it. */
  partial?: boolean;
  usage?: Usage;
}

export type ToolStatus = "running" | "ok" | "error";

export interface ToolItem {
  kind: "tool";
  id: string;
  at: number;
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
  at: number;
  text: string;
  tone: "info" | "error";
}

export type TimelineItem = UserItem | AssistantItem | ToolItem | NoticeItem;

/** Everything the page needs that is not part of the transcript. */
export interface SessionMeta {
  runtimeId: string | null;
  storedId: string | null;
  title: string;
  model: string;
  provider: string;
  /** Reasoning level the route is using; "" when the session has not said. */
  reasoningEffort: string;
  running: boolean;
  usage: Usage | null;
  /** Last `status.update.text`, cleared when the turn ends. */
  status: string;
  connected: boolean;
}

export const emptyMeta: SessionMeta = {
  runtimeId: null,
  storedId: null,
  title: "",
  model: "",
  provider: "",
  reasoningEffort: "",
  running: false,
  usage: null,
  status: "",
  connected: false,
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
