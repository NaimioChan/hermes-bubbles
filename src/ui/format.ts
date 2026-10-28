/**
 * Presentation helpers. Pure string/shape logic — no React, no DOM.
 *
 * These are separate from the components so the fiddly parts (what counts as a
 * failed tool, how a long result is trimmed, how a tool name is labelled) can be
 * tested without rendering.
 */

import type { SessionMeta, TimelineItem, ToolItem } from "../core/types";
import { isSubagentTerminal } from "../core/types";
import type { Locale, Messages } from "../core/i18n";
import type { RunCounts } from "../core/run";
import { noticeText } from "../core/notice";
import { MAX_ATTACHMENT_MIB, type Rejection } from "../core/attachments";

/**
 * Tools whose names are worth showing a friendly verb for. Falls back to the raw name.
 *
 * The label itself lives in the catalog: this map only says which key a tool id
 * points at, so an English dashboard does not show a Chinese verb.
 */
type ToolLabelKey = Extract<keyof Messages, `tool${string}`>;

const TOOL_LABEL_KEYS: Record<string, ToolLabelKey> = {
  terminal: "toolTerminal",
  read_file: "toolReadFile",
  write_file: "toolWriteFile",
  patch: "toolPatch",
  search_files: "toolSearchFiles",
  web_search: "toolWebSearch",
  web_extract: "toolWebExtract",
  browser_exec: "toolBrowserExec",
  delegate_task: "toolDelegateTask",
  todo_list: "toolTodoList",
  memory: "toolMemory",
  skill_view: "toolSkillView",
  skill_manage: "toolSkillManage",
  image_gen: "toolImageGen",
  text_to_speech: "toolTextToSpeech",
};

export function toolLabel(name: string, t: Messages): string {
  const key = TOOL_LABEL_KEYS[name];
  return key ? t[key] : name;
}

/** Why a picked file was refused, in the dashboard's language. */
export function rejectionLabel(rejection: Rejection, t: Messages): string {
  if (rejection.code === "empty") return t.attachmentEmpty;
  return t.attachmentTooLarge(rejection.limitMib ?? MAX_ATTACHMENT_MIB);
}

/** How many characters of a tool result to render before collapsing. */
export const TOOL_PREVIEW_CHARS = 400;

export interface ToolPreview {
  text: string;
  truncated: boolean;
}

/**
 * Trim a tool result for the collapsed view. Cuts on a line boundary so the
 * preview never shows half a line, and never exceeds `limit` characters.
 */
export function toolPreview(result: string | undefined, limit = TOOL_PREVIEW_CHARS): ToolPreview {
  const text = (result ?? "").replace(/\s+$/, "");
  if (text.length <= limit) return { text, truncated: false };
  const cut = text.slice(0, limit);
  const lastBreak = cut.lastIndexOf("\n");
  const body = lastBreak > limit * 0.5 ? cut.slice(0, lastBreak) : cut;
  return { text: body, truncated: true };
}

export function formatDuration(seconds: number | undefined): string {
  if (typeof seconds !== "number" || !Number.isFinite(seconds)) return "";
  if (seconds < 1) return `${Math.round(seconds * 1000)}ms`;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return `${minutes}m${rest}s`;
}

export function formatCount(value: number | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "";
  if (value < 1000) return String(value);
  if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k`;
  return `${(value / 1_000_000).toFixed(1)}M`;
}

/** The status line shown on the composer while a turn is running. */
export function runningLabel(meta: Pick<SessionMeta, "status" | "statusKind" | "running">, t: Messages): string {
  if (meta.statusKind === "reconnecting") return t.reconnecting;
  if (meta.status) return meta.status;
  return meta.running ? t.working : "";
}

export function isToolItem(item: TimelineItem): item is ToolItem {
  return item.kind === "tool";
}

/** A stable key for React. The id is generated once per item and never changes,
 * so it survives the item being patched in place.
 */
export function itemKey(item: TimelineItem): string {
  return item.id;
}

/**
 * The collapsed activity block's header text: one phrase per kind present, in
 * the order a turn produces them (`2 thoughts · 3 calls`).
 *
 * Only kinds that are actually there get a phrase — an "0 delegations" column
 * would be noise — and a block with nothing countable (two notices, say) falls
 * back to the notice count so the header is never empty.
 */
export function activitySummary(counts: RunCounts, t: Messages): string {
  const parts: string[] = [];
  if (counts.thoughts) parts.push(t.activityThoughts(counts.thoughts));
  if (counts.tools) parts.push(t.activityTools(counts.tools));
  if (counts.subagents) parts.push(t.activitySubagents(counts.subagents));
  if (counts.notices && !parts.length) parts.push(t.activityNotices(counts.notices));
  return parts.join(" · ");
}

/**
 * One plain-text line per row, for the collapsed block's peek.
 *
 * The newest `limit` rows are the ones shown: in a long run the early calls are
 * history and the last few say what the turn is doing now. Each line is what the
 * row's own collapsed header would say — the thinking tail, the tool verb and
 * its one-line summary — so the peek and the expanded row never describe the
 * same call two different ways.
 */
export function activityPeek(
  items: readonly TimelineItem[],
  t: Messages,
  locale: Locale,
  limit: number,
): string[] {
  const lines: string[] = [];
  for (const item of items.slice(-limit)) {
    const line = peekLine(item, t, locale);
    if (line) lines.push(line);
  }
  return lines;
}

function peekLine(item: TimelineItem, t: Messages, locale: Locale): string {
  switch (item.kind) {
    case "reasoning": {
      const text = item.text.trim();
      if (!text) return "";
      const last = text.split("\n").filter((line) => line.trim()).at(-1) ?? text;
      return last.trim();
    }
    case "tool":
      return [toolLabel(item.name, t), item.summary].filter(Boolean).join(" · ");
    case "subagents": {
      const done = item.children.filter((child) => isSubagentTerminal(child.status)).length;
      return `${t.subagents} · ${t.subagentProgress(done, item.children.length)}`;
    }
    case "notice":
      return noticeText(item, locale);
    default:
      return "";
  }
}

