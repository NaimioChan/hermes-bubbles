/**
 * Presentation helpers. Pure string/shape logic — no React, no DOM.
 *
 * These are separate from the components so the fiddly parts (what counts as a
 * failed tool, how a long result is trimmed, how a tool name is labelled) can be
 * tested without rendering.
 */

import type { TimelineItem, ToolItem } from "../core/types";

/** Tools whose names are worth showing a friendly verb for. Falls back to the raw name. */
const TOOL_LABELS: Record<string, string> = {
  terminal: "执行命令",
  read_file: "读取文件",
  write_file: "写入文件",
  patch: "修改文件",
  search_files: "搜索",
  web_search: "联网搜索",
  web_extract: "抓取网页",
  browser_exec: "操作浏览器",
  delegate_task: "委派子任务",
  todo_list: "任务清单",
  memory: "记忆",
  skill_view: "查看技能",
  skill_manage: "编辑技能",
  image_gen: "生成图片",
  text_to_speech: "语音合成",
};

export function toolLabel(name: string): string {
  return TOOL_LABELS[name] ?? name;
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
export function runningLabel(meta: { status: string; running: boolean }): string {
  if (meta.status) return meta.status;
  return meta.running ? "正在处理…" : "";
}

export function isToolItem(item: TimelineItem): item is ToolItem {
  return item.kind === "tool";
}

/**
 * A stable key for React. The id is generated once per item and never changes,
 * so it survives the item being patched in place.
 */
export function itemKey(item: TimelineItem): string {
  return item.id;
}
