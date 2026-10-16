/**
 * Event → timeline reduction.
 *
 * One pure function per event family, all operating on an immutable-ish
 * `Timeline` value. Everything the UI shows comes from here, so every rule in
 * this file is directly testable without a browser or a socket.
 *
 * Field semantics are documented in `docs/01-protocol-contract.md` §5.
 */

import { findTool, lastAssistant, openAssistant, type AssistantItem, type Timeline, type TimelineItem, type ToolItem, type Usage } from "./types";

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
  if (result && typeof result === "object" && !Array.isArray(result) && "error" in (result as object)) {
    return "error";
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
      return { items, meta: { ...meta, connected: true } };

    case "gateway.closed":
    case "gateway.reconnecting":
      return { items, meta: { ...meta, connected: false, status: "连接中断，重连中…" } };

    case "message.start":
      return { items: sealAssistant(items), meta: { ...meta, running: true, status: "" } };

    case "message.delta": {
      const text = str(p.text);
      if (!text) return timeline;
      const open = openAssistant(items);
      if (open) {
        return { items: replaceLast(items, { ...open, text: open.text + text }), meta };
      }
      const fresh: AssistantItem = {
        kind: "assistant",
        id: nextId("assistant"),
        at: Date.now(),
        text,
        reasoning: "",
        streaming: true,
      };
      return { items: [...items, fresh], meta: { ...meta, running: true } };
    }

    case "message.interim": {
      const sealed = sealAssistant(items);
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
        reasoning: "",
        streaming: false,
      };
      return { items: [...sealed, fresh], meta };
    }

    case "message.complete": {
      const status = str(p.status);
      const finalText = str(p.text);
      const error = str(p.error) || str(p.failure_reason);
      const usage = (p.usage ?? null) as Usage | null;
      // Identify the turn's bubble BEFORE sealing: afterwards it is no longer
      // `streaming`, and a plain "last assistant" search could reach back into
      // a previous turn when this one produced no text at all. Seal and finish
      // in ONE pass — sealing first would replace the object and break identity.
      const target = openAssistant(items);

      let nextItems: TimelineItem[];
      if (target) {
        // `text` on a complete frame is often empty (already streamed) — only
        // use it as a fallback, never as a replacement.
        const merged = target.text.trim() ? target.text : finalText || target.text;
        nextItems = patchAssistant(items, target, (item) => ({
          ...item,
          text: merged,
          streaming: false,
          error: status === "error" ? error || "turn failed" : undefined,
          partial: Boolean(p.partial),
          usage: usage ?? item.usage,
        }));
      } else if (finalText) {
        nextItems = [
          ...items,
          {
            kind: "assistant",
            id: nextId("assistant"),
            at: Date.now(),
            text: finalText,
            reasoning: "",
            streaming: false,
            error: status === "error" ? error || "turn failed" : undefined,
            partial: Boolean(p.partial),
            usage: usage ?? undefined,
          },
        ];
      } else if (status === "error" && error) {
        nextItems = [
          ...items,
          {
            kind: "assistant",
            id: nextId("assistant"),
            at: Date.now(),
            text: "",
            reasoning: "",
            streaming: false,
            error,
          },
        ];
      } else {
        nextItems = items;
      }

      return {
        items: nextItems,
        meta: {
          ...meta,
          running: false,
          status: "",
          usage: usage ?? meta.usage,
        },
      };
    }

    case "reasoning.delta":
    case "reasoning.available": {
      const text = str(p.text);
      if (!text) return timeline;
      const open = openAssistant(items);
      if (open) {
        return { items: replaceLast(items, { ...open, reasoning: open.reasoning + text }), meta };
      }
      const fresh: AssistantItem = {
        kind: "assistant",
        id: nextId("assistant"),
        at: Date.now(),
        text: "",
        reasoning: text,
        streaming: true,
      };
      return { items: [...items, fresh], meta };
    }

    case "tool.start": {
      const tool = toolFromStart(event);
      return { items: [...items, tool], meta };
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

    case "status.update": {
      const text = str(p.text);
      const kind = str(p.kind);
      // `compacting` / `goal` / `loop` / `heartbeat` / `process` are all just
      // "something is happening" for this page; they share one status line.
      return { items, meta: { ...meta, status: text || (kind ? `${kind}…` : "") } };
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
          { kind: "notice", id: nextId("notice"), at: Date.now(), text: str(p.message) || "发生错误", tone: "error" },
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
    meta: { ...timeline.meta, running: true, status: "" },
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

/** Stop pressed, or the turn ended without a `message.complete`. */
export function settleTimeline(timeline: Timeline, note?: string): Timeline {
  return {
    items: sealAssistant(timeline.items),
    meta: { ...timeline.meta, running: false, status: note ?? "" },
  };
}
