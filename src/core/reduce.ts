/**
 * Event → timeline reduction.
 *
 * One pure function per event family, all operating on an immutable-ish
 * `Timeline` value. Everything the UI shows comes from here, so every rule in
 * this file is directly testable without a browser or a socket.
 *
 * Field semantics are documented in `docs/01-protocol-contract.md` §5.
 */

import {
  findTool,
  isSubagentTerminal,
  lastAssistant,
  openAssistant,
  type AssistantItem,
  type ReasoningItem,
  type SubagentChild,
  type SubagentStatus,
  type SubagentsItem,
  type Timeline,
  type TimelineItem,
  type TodoEntry,
  type TodoState,
  type ToolItem,
  type Usage,
} from "./types";

export interface GatewayEvent {
  type: string;
  session_id?: string;
  seq?: number;
  replayEpoch?: string;
  payload?: Record<string, unknown>;
}

let counter = 0;
function nextId(prefix: string): string {
  counter += 1;
  return `${prefix}-${counter}`;
}

/** Test hook — keeps generated ids deterministic across cases. */
export function resetIdCounter(): void {
  counter = 0;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function replaceLast(items: TimelineItem[], item: TimelineItem): TimelineItem[] {
  const next = items.slice();
  for (let i = next.length - 1; i >= 0; i -= 1) {
    if (next[i]?.kind === item.kind) {
      next[i] = item;
      return next;
    }
  }
  next.push(item);
  return next;
}

function patchAssistant(
  items: TimelineItem[],
  target: AssistantItem,
  patch: (item: AssistantItem) => AssistantItem,
): TimelineItem[] {
  return items.map((item) => (item === target ? patch(item) : item));
}

/**
 * Seal the open assistant bubble. `interim` is not a turn end — the model may
 * keep talking after a tool call — so the bubble is closed for appending but
 * nothing else changes.
 */
function sealAssistant(items: TimelineItem[]): TimelineItem[] {
  const open = openAssistant(items);
  if (!open) return items;
  return patchAssistant(items, open, (item) => ({ ...item, streaming: false }));
}

/**
 * Reasoning is positional, so only the TAIL can be open.
 *
 * `replaceLast` would reach back to a thinking block from before a tool call
 * and glue the new segment onto it, which is the one thing keeping these as
 * separate items was meant to prevent. Hence the strict "last item" test.
 */
function openReasoning(items: readonly TimelineItem[]): ReasoningItem | null {
  const last = items[items.length - 1];
  return last && last.kind === "reasoning" && last.streaming ? last : null;
}

function sealReasoning(items: TimelineItem[]): TimelineItem[] {
  const open = openReasoning(items);
  if (!open) return items;
  const copy = items.slice();
  copy[copy.length - 1] = { ...open, streaming: false };
  return copy;
}

/** Append a chunk to the open thinking block, or start a new one. */
function appendReasoning(items: TimelineItem[], text: string): TimelineItem[] {
  const open = openReasoning(items);
  if (open) {
    const copy = items.slice();
    copy[copy.length - 1] = { ...open, text: open.text + text };
    return copy;
  }
  const fresh: ReasoningItem = { kind: "reasoning", id: nextId("reasoning"), at: Date.now(), text, streaming: true };
  return [...items, fresh];
}

/**
 * Tool results carry no `is_error` flag on the wire; the desktop infers failure
 * from a `error` key the closed contract does not declare, and from the
 * rendered summary. Reproduce that inference conservatively: an explicit error
 * key wins, otherwise only the summary's own failure verbs count, so a tool
 * that merely *mentions* an error in its output is not painted red.
 */
export function inferToolStatus(payload: Record<string, unknown>): "ok" | "error" {
  if (payload.error) return "error";
  const summary = str(payload.summary);
  if (/\b(error|failed|failure|traceback|exception|denied|refused|timed out)\b/i.test(summary)) {
    return "error";
  }
  const result = payload.result;
  if (result && typeof result === "object" && !Array.isArray(result)) {
    // Truthiness, not key presence: plenty of tools report success as
    // `{"error": null}`, and a key check painted every one of those calls red.
    if ((result as Record<string, unknown>).error) return "error";
  }
  return "ok";
}

function toolFromStart(event: GatewayEvent): ToolItem {
  const p = event.payload ?? {};
  const name = str(p.name) || "tool";
  return {
    kind: "tool",
    id: nextId("tool"),
    at: Date.now(),
    toolId: str(p.tool_id),
    name,
    summary: str(p.context) || str(p.preview) || "",
    status: "running",
    args: p.args,
    argsText: str(p.args_text) || undefined,
  };
}

/** How many progress lines a child keeps; older ones scroll out of the card. */
const MAX_PROGRESS_LINES = 6;

function todoEntry(value: unknown): TodoEntry | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const id = str(row.id);
  const content = str(row.content);
  if (!id || !content) return null;
  const parent = str(row.parent);
  return { id, content, status: (str(row.status) || "pending").toLowerCase(), parent: parent || undefined };
}

/**
 * Apply a `todo.updated` snapshot.
 *
 * The frame is the WHOLE list, not a diff, and `revision` is monotonic per
 * session — a late frame from a reconnect must not roll the panel backwards.
 * `{todos: [], revision: 0}` is the unused store's placeholder rather than a
 * clear, so it is ignored the same way the backend ignores it.
 */
export function reduceTodos(current: TodoState | null, payload: Record<string, unknown>): TodoState | undefined {
  if (!Array.isArray(payload.todos)) return undefined;
  const revision = num(payload.revision) ?? 0;
  if (current && revision < current.revision) return undefined;
  const todos = payload.todos.map(todoEntry).filter((entry): entry is TodoEntry => entry !== null);
  if (!todos.length && revision === 0) return undefined;
  return { todos, revision };
}

const SUBAGENT_STATUSES: readonly SubagentStatus[] = [
  "queued",
  "running",
  "completed",
  "failed",
  "error",
  "timeout",
  "interrupted",
];

function subagentStatusOf(value: unknown): SubagentStatus | undefined {
  const raw = str(value).toLowerCase();
  return (SUBAGENT_STATUSES as readonly string[]).includes(raw) ? (raw as SubagentStatus) : undefined;
}

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value.filter((item): item is string => typeof item === "string" && item.trim() !== "");
  return out.length ? out : undefined;
}

function outputTailOf(value: unknown): SubagentChild["outputTail"] {
  if (!Array.isArray(value)) return undefined;
  const rows = value
    .filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === "object")
    .map((row) => ({
      tool: str(row.tool),
      preview: str(row.preview),
      isError: Boolean(row.is_error),
    }))
    .filter((row) => row.tool || row.preview);
  return rows.length ? rows.slice(-6) : undefined;
}

function batchKeyOf(p: Record<string, unknown>): string {
  const delegation = str(p.delegation_id);
  if (delegation) return delegation;
  const parent = str(p.parent_id);
  return parent ? `flat:${parent}` : "flat";
}

function mergeChild(
  prev: SubagentChild | null,
  type: string,
  p: Record<string, unknown>,
  key: string,
  taskIndex: number,
): SubagentChild {
  const base: SubagentChild =
    prev ??
    {
      key,
      taskIndex,
      goal: "",
      status: "queued",
      toolCount: 0,
      lastTool: "",
      progress: [],
      thinking: "",
    };
  const next: SubagentChild = { ...base, progress: base.progress.slice() };

  const goal = str(p.goal);
  if (goal) next.goal = goal;
  const model = str(p.model);
  if (model) next.model = model;
  const toolsets = stringList(p.toolsets);
  if (toolsets) next.toolsets = toolsets;
  const toolCount = num(p.tool_count);
  if (toolCount !== undefined) next.toolCount = toolCount;
  const filesRead = stringList(p.files_read);
  if (filesRead) next.filesRead = filesRead;
  const filesWritten = stringList(p.files_written);
  if (filesWritten) next.filesWritten = filesWritten;
  const input = num(p.input_tokens);
  const output = num(p.output_tokens);
  if (input !== undefined || output !== undefined) {
    next.tokens = { input: input ?? base.tokens?.input, output: output ?? base.tokens?.output };
  }

  switch (type) {
    case "subagent.start":
      next.status = "running";
      break;
    case "subagent.progress": {
      const line = str(p.text);
      if (line) next.progress = [...base.progress, line].slice(-MAX_PROGRESS_LINES);
      break;
    }
    case "subagent.thinking": {
      // Only the tail matters: a child's reasoning arrives in hundreds of
      // fragments and the card shows what it is on right now, not a transcript.
      const text = str(p.text);
      if (text) next.thinking = text.length > 240 ? `…${text.slice(-240)}` : text;
      break;
    }
    case "subagent.tool": {
      const tool = str(p.tool_name) || str(p.name);
      if (tool) next.lastTool = tool;
      const preview = str(p.tool_preview) || str(p.text);
      if (preview) next.progress = [...base.progress, preview].slice(-MAX_PROGRESS_LINES);
      break;
    }
    case "subagent.complete": {
      next.status = subagentStatusOf(p.status) ?? "completed";
      const summary = str(p.summary) || str(p.text);
      if (summary) next.summary = summary;
      const duration = num(p.duration_seconds);
      if (duration !== undefined) next.durationS = duration;
      const tail = outputTailOf(p.output_tail);
      if (tail) next.outputTail = tail;
      break;
    }
    default:
      // `subagent.spawn_requested`: the child is announced but not yet running.
      break;
  }
  return next;
}

/**
 * Fold one `subagent.*` frame into the timeline.
 *
 * A batch is one `delegate_task` call, so all of its children belong on one
 * card; concurrent children merely fill rows on that card. Identity comes from
 * `subagent_id` first (every frame carries it, so a late frame always finds its
 * own row), then `delegation_id` (the batch the backend stamped), then — for
 * emitters that send neither — the newest batch that still has an empty slot.
 */
export function upsertSubagent(items: readonly TimelineItem[], event: GatewayEvent): TimelineItem[] {
  const p = event.payload ?? {};
  const type = event.type;
  const key = str(p.subagent_id) || `idx:${num(p.task_index) ?? 0}`;
  const batchKey = batchKeyOf(p);
  const taskCount = num(p.task_count) ?? 1;
  const taskIndex = num(p.task_index) ?? 0;
  const anonymous = batchKey.startsWith("flat");

  let found = -1;
  for (let i = items.length - 1; i >= 0 && found < 0; i -= 1) {
    const item = items[i];
    if (item?.kind !== "subagents") continue;
    if (item.children.some((child) => child.key === key)) found = i;
  }
  if (found < 0) {
    for (let i = items.length - 1; i >= 0 && found < 0; i -= 1) {
      const item = items[i];
      if (item?.kind !== "subagents") continue;
      if (anonymous) {
        // No batch id: only a batch that is still taking children can be this
        // one, so a second wave never merges into a finished card.
        if (!item.finishedAt && item.children.length < item.taskCount) found = i;
      } else if (item.batchKey === batchKey && !item.finishedAt) {
        found = i;
      }
    }
  }

  const prev = found >= 0 ? (items[found] as SubagentsItem) : null;
  const base: SubagentsItem =
    prev ?? {
      kind: "subagents",
      id: nextId("subagents"),
      at: Date.now(),
      batchKey,
      taskCount,
      depth: num(p.depth),
      children: [],
    };
  const existing = base.children.find((child) => child.key === key) ?? null;
  const child = mergeChild(existing, type, p, key, taskIndex);
  const children = existing
    ? base.children.map((row) => (row.key === key ? child : row))
    : [...base.children, child].sort((a, b) => a.taskIndex - b.taskIndex);
  const done = children.length > 0 && children.every((row) => isSubagentTerminal(row.status));
  const next: SubagentsItem = {
    ...base,
    children,
    finishedAt: done ? (base.finishedAt ?? Date.now()) : undefined,
  };

  if (found < 0) return [...items, next];
  const copy = items.slice();
  copy[found] = next;
  return copy;
}

function resultTextOf(p: Record<string, unknown>): string | undefined {
  const explicit = str(p.result_text);
  if (explicit) return explicit;
  const result = p.result;
  if (result === undefined || result === null) return undefined;
  if (typeof result === "string") return result;
  try {
    return JSON.stringify(result, null, 2);
  } catch {
    return String(result);
  }
}

/**
 * Apply one gateway event. Unknown event types are a no-op — the backend ships
 * more events than this plugin renders, and an unrecognised one must never
 * break the turn.
 */
export function reduceEvent(timeline: Timeline, event: GatewayEvent): Timeline {
  const { items, meta } = timeline;
  const p = event.payload ?? {};

  switch (event.type) {
    case "gateway.ready":
      return { items, meta: { ...meta, connected: true, status: "", statusKind: "" } };

    case "gateway.closed":
    case "gateway.reconnecting":
      // The reconnect line is chosen at render time; `core/` stays prose-free.
      return { items, meta: { ...meta, connected: false, status: "", statusKind: "reconnecting" } };

    case "message.start":
      return {
        items: sealReasoning(sealAssistant(items)),
        meta: { ...meta, running: true, status: "", statusKind: "" },
      };

    case "message.delta": {
      const text = str(p.text);
      if (!text) return timeline;
      // Words after a thinking block are a new bubble: the block sits between
      // them, and appending across it would put the answer above its own
      // reasoning.
      const base = sealReasoning(items);
      const open = openAssistant(base);
      if (open) {
        return { items: replaceLast(base, { ...open, text: open.text + text }), meta };
      }
      const fresh: AssistantItem = {
        kind: "assistant",
        id: nextId("assistant"),
        at: Date.now(),
        text,
        streaming: true,
      };
      return { items: [...base, fresh], meta: { ...meta, running: true } };
    }

    case "message.interim": {
      const sealed = sealReasoning(sealAssistant(items));
      // `already_streamed` means the text is already on screen via deltas. When
      // it is not, the event is the only copy of that segment.
      if (p.already_streamed) return { items: sealed, meta };
      const text = str(p.text);
      if (!text) return { items: sealed, meta };
      const last = lastAssistant(sealed);
      if (last) return { items: replaceLast(sealed, { ...last, text: last.text + text }), meta };
      const fresh: AssistantItem = {
        kind: "assistant",
        id: nextId("assistant"),
        at: Date.now(),
        text,
        streaming: false,
      };
      return { items: [...sealed, fresh], meta };
    }

    case "message.complete": {
      const status = str(p.status);
      const finalText = str(p.text);
      const error = str(p.error) || str(p.failure_reason);
      const usage = (p.usage ?? null) as Usage | null;
      // Seal the thinking block first: a thinking-only turn ends with nothing
      // else to attach, and leaving it `streaming` would keep the caret blinking
      // after the turn is over.
      const settled = sealReasoning(items);
      // Identify the turn's bubble BEFORE sealing: afterwards it is no longer
      // `streaming`, and a plain "last assistant" search could reach back into
      // a previous turn when this one produced no text at all. Seal and finish
      // in ONE pass — sealing first would replace the object and break identity.
      const target = openAssistant(settled);
      // The turn ended: stamp it for the timestamp and duration lines. `at` is
      // the turn's start and is the wrong number to print under a reply.
      const completedAt = Date.now();
      const durationS = turnDuration(items, completedAt);

      let nextItems: TimelineItem[];
      if (target) {
        // `text` on a complete frame is often empty (already streamed) — only
        // use it as a fallback, never as a replacement.
        const merged = target.text.trim() ? target.text : finalText || target.text;
        nextItems = patchAssistant(settled, target, (item) => ({
          ...item,
          text: merged,
          streaming: false,
          error: status === "error" ? error || "turn failed" : undefined,
          partial: Boolean(p.partial),
          usage: usage ?? item.usage,
          completedAt,
          durationS,
        }));
      } else if (finalText) {
        nextItems = [
          ...settled,
          {
            kind: "assistant",
            id: nextId("assistant"),
            at: Date.now(),
            text: finalText,
            streaming: false,
            error: status === "error" ? error || "turn failed" : undefined,
            partial: Boolean(p.partial),
            usage: usage ?? undefined,
            completedAt,
            durationS,
          },
        ];
      } else if (status === "error" && error) {
        nextItems = [
          ...settled,
          {
            kind: "assistant",
            id: nextId("assistant"),
            at: Date.now(),
            text: "",
            streaming: false,
            error,
            completedAt,
            durationS,
          },
        ];
      } else {
        nextItems = settled;
      }

      return {
        items: nextItems,
        meta: {
          ...meta,
          running: false,
          status: "",
          statusKind: "",
          usage: usage ?? meta.usage,
        },
      };
    }

    case "reasoning.delta":
    case "reasoning.available": {
      const text = str(p.text);
      if (!text) return timeline;
      // A thinking block that starts once the reply has begun splits the reply:
      // the words on either side are two segments with the block between them.
      return { items: appendReasoning(sealAssistant(items), text), meta };
    }

    case "tool.start": {
      const tool = toolFromStart(event);
      // A call ends both the current text segment and the current thought. The
      // model's words before a tool and its words after it are two bubbles with
      // the card between them; without this seal the post-tool reply keeps
      // appending to the bubble above the card, so the answer looks buried
      // under the tool calls. The thought is sealed for the same reason: a
      // thinking block belongs to the segment that produced it, not to a
      // growing blob that swallows the rest of the turn.
      return { items: [...sealReasoning(sealAssistant(items)), tool], meta };
    }

    case "tool.complete": {
      const toolId = str(p.tool_id);
      const existing = findTool(items, toolId);
      const status = inferToolStatus(p);
      const resultText = resultTextOf(p);
      if (!existing) {
        // A completion with no matching start (a reconnect that lost the start
        // frame, or a mirrored child row): still show the result.
        const orphan: ToolItem = {
          kind: "tool",
          id: nextId("tool"),
          at: Date.now(),
          toolId,
          name: str(p.name) || "tool",
          summary: str(p.summary),
          status,
          args: p.args,
          resultText,
          durationS: num(p.duration_s),
        };
        return { items: [...items, orphan], meta };
      }
      const updated: ToolItem = {
        ...existing,
        status,
        summary: str(p.summary) || existing.summary,
        resultText: resultText ?? existing.resultText,
        durationS: num(p.duration_s) ?? existing.durationS,
      };
      return { items: items.map((item) => (item === existing ? updated : item)), meta };
    }

    case "tool.output_risk": {
      const toolId = str(p.tool_id);
      const existing = findTool(items, toolId);
      if (!existing) return timeline;
      const updated: ToolItem = { ...existing, risk: str(p.risk) || "unknown" };
      return { items: items.map((item) => (item === existing ? updated : item)), meta };
    }

    case "todo.updated": {
      const todo = reduceTodos(meta.todo, p);
      if (todo === undefined) return timeline;
      return { items, meta: { ...meta, todo } };
    }

    case "subagent.spawn_requested":
    case "subagent.start":
    case "subagent.progress":
    case "subagent.thinking":
    case "subagent.tool":
    case "subagent.complete":
      return { items: upsertSubagent(items, event), meta };

    case "status.update": {
      const text = str(p.text);
      const kind = str(p.kind);
      // `compacting` / `goal` / `loop` / `heartbeat` / `process` are all just
      // "something is happening" for this page; they share one status line.
      return { items, meta: { ...meta, status: text || (kind ? `${kind}…` : ""), statusKind: "" } };
    }

    case "session.usage": {
      const usage = (p.usage ?? null) as Usage | null;
      return { items, meta: { ...meta, usage: usage ?? meta.usage } };
    }

    case "session.title":
      return { items, meta: { ...meta, title: str(p.title) || meta.title } };

    case "session.info": {
      const info = p as Record<string, unknown>;
      return {
        items,
        meta: {
          ...meta,
          model: str(info.model) || meta.model,
          provider: str(info.provider) || meta.provider,
          reasoningEffort: str(info.reasoning_effort) || meta.reasoningEffort,
          running: typeof info.running === "boolean" ? info.running : meta.running,
          title: str(info.title) || meta.title,
          usage: (info.usage as Usage | null) ?? meta.usage,
        },
      };
    }

    case "notice":
      return {
        items: [
          ...items,
          { kind: "notice", id: nextId("notice"), at: Date.now(), text: str(p.text) || str(p.message), tone: "info" },
        ],
        meta,
      };

    case "error":
      return {
        items: [
          ...items,
          { kind: "notice", id: nextId("notice"), at: Date.now(), text: str(p.message), tone: "error" },
        ],
        meta: { ...meta, running: false },
      };

    default:
      return timeline;
  }
}

/** The user's own message, appended optimistically at submit time. */
export function appendUser(timeline: Timeline, text: string): Timeline {
  return {
    items: [
      ...timeline.items,
      { kind: "user", id: nextId("user"), at: Date.now(), text, pending: true },
    ],
    meta: { ...timeline.meta, running: true, status: "", statusKind: "" },
  };
}

/** The backend accepted the turn: bind the durable row id to the pending bubble. */
export function ackUser(timeline: Timeline, rowId: number | undefined): Timeline {
  for (let i = timeline.items.length - 1; i >= 0; i -= 1) {
    const item = timeline.items[i];
    if (item && item.kind === "user" && item.pending) {
      const next = timeline.items.slice();
      next[i] = { ...item, pending: false, rowId: rowId ?? item.rowId };
      return { items: next, meta: timeline.meta };
    }
  }
  return timeline;
}

/**
 * How long the turn took, from its own user row to now.
 *
 * `message.complete` reports no timing, so this is measured locally. Clamped to
 * a plausible window: a resumed session's rows can carry timestamps that are not
 * comparable to `Date.now()` (epoch units differ across sources), and printing
 * "41000m" under a reply is worse than printing nothing.
 */
function turnDuration(items: readonly TimelineItem[], completedAt: number): number | undefined {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i];
    if (!item || item.kind !== "user") continue;
    // Both sides are milliseconds; the duration is reported in seconds.
    const elapsed = (completedAt - item.at) / 1000;
    if (!Number.isFinite(elapsed) || elapsed <= 0 || elapsed > 6 * 3600) return undefined;
    return elapsed;
  }
  return undefined;
}

/** Stop pressed, or the turn ended without a `message.complete`. */
export function settleTimeline(timeline: Timeline, note?: string): Timeline {
  return {
    items: sealReasoning(sealAssistant(timeline.items)),
    meta: { ...timeline.meta, running: false, status: note ?? "", statusKind: "" },
  };
}
