/**
 * Locale detection and the message catalog.
 *
 * The plugin defaults to English rather than the host's language: Hermes itself
 * ships `display.language: en` by default, and a plugin that silently rendered
 * Chinese inside an English dashboard was the wrong default.
 *
 * There is no RPC for "what language is this dashboard showing". The dashboard
 * keeps its choice in `localStorage['hermes-locale']` and mirrors it onto
 * `<html lang>`, so those are the two signals read here. The dashboard's own
 * switcher rewrites both, which is what makes the plugin follow a language change
 * without a reload: the plugin listens for `storage` (another tab) plus a
 * `MutationObserver` on `<html lang>` (this tab).
 *
 * The host also ships a compiled catalog of thousands of strings, but it is not
 * reachable from the plugin sandbox — `SDK.useI18n` is a bare `useContext` on a
 * context the plugin cannot import, so it would only ever return the provider's
 * default and go stale on a switch. Hence a small local catalog for the strings
 * this plugin actually renders.
 *
 * Pure string logic, no DOM (AGENTS.md 铁律 1) — the DOM reads live in
 * `src/ui/useLocale.ts`.
 */

export const LOCALES = ["en", "zh"] as const;
export type Locale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: Locale = "en";

/** The dashboard's storage key, used only to read the choice it already made. */
export const LOCALE_STORAGE_KEY = "hermes-locale";

/** Normalise a BCP-47 tag or the host's storage value onto a supported locale. */
export function normalizeLocale(raw: string | null | undefined): Locale {
  if (!raw) return DEFAULT_LOCALE;
  const value = raw.trim().toLowerCase();
  if (!value || value === "auto") return DEFAULT_LOCALE;
  // `zh-Hant` / `zh-TW` are still Chinese for the handful of strings here.
  if (value === "zh" || value.startsWith("zh-")) return "zh";
  if (value.startsWith("en")) return "en";
  return DEFAULT_LOCALE;
}

export interface Messages {
  /** The empty-transcript hint. */
  empty: string;
  composerPlaceholder: string;
  send: string;
  insert: string;
  stop: string;
  /** Reasoning disclosure. */
  thought: string;
  chars: (n: number) => string;
  thinking: string;
  /** Message actions, mirroring the desktop app's labels. */
  copy: string;
  copyFailed: string;
  copied: string;
  refresh: string;
  branchNewChat: string;
  turnDuration: (d: string) => string;
  /** The usage readout: the reply footer and the composer's metric chips. */
  contextPercent: (pct: number) => string;
  metricContextTitle: (detail: string) => string;
  metricCacheTitle: string;
  metricTpsTitle: string;
  metricCostTitle: string;
  yesterday: (time: string) => string;
  today: (time: string) => string;
  /** Approval / clarify cards. */
  approvalTitle: string;
  clarifyTitle: string;
  approvalOnce: string;
  approvalSession: string;
  approvalAlways: string;
  approvalDeny: string;
  submit: string;
  /** Composer affordances. */
  attachFiles: string;
  pickModel: string;
  reasoning: string;
  reasoningLow: string;
  reasoningMedium: string;
  reasoningHigh: string;
  stopReasoningTitle: string;
  filterModels: string;
  noModels: string;
  loading: string;
  current: string;
  noKey: string;
  history: string;
  historyEmpty: string;
  historyLoading: string;
  refreshTitle: string;
  collapse: string;
  newChat: string;
  closeTab: string;
  emptyTabs: string;
  untitled: string;
  minutesAgo: (n: number) => string;
  hoursAgo: (n: number) => string;
  daysAgo: (n: number) => string;
  editingHint: string;
  titleRequired: string;
  editUnavailable: string;
  editNoAnchor: string;
  sessionOpen: string;
  sessionRunning: string;
  jumpToMessage: string;
  copyCode: string;
  edit: string;
  rename: string;
  delete: string;
  deleteConfirm: string;
  deleteRefused: string;
  saved: string;
  cheapModelConfirm: string;
  modelQueued: string;
  /** Notices. */
  steered: string;
  redirected: string;
  queued: string;
  fileReadFailed: string;
  sessionNotReady: string;
  /** The task-list panel (`todo.updated`). */
  todos: string;
  todoProgress: (done: number, total: number) => string;
  todoEmpty: string;
  /** Delegated children (`subagent.*`). */
  subagents: string;
  subagentProgress: (done: number, total: number) => string;
  subagentTools: (n: number) => string;
  subagentStatus: (status: string) => string;
  /** Desktop notifications. */
  notifyApprovalTitle: string;
  notifyClarifyTitle: string;
  notifyDoneTitle: string;
  notifyFailedTitle: string;
  notifyOnTitle: string;
  notifyOffTitle: string;
  notifyBlockedTitle: string;
}

const EN: Messages = {
  empty: "Start a conversation. Type / for commands.",
  composerPlaceholder: "Send a message, or type / for commands",
  send: "Send",
  insert: "Insert",
  stop: "Stop",
  thought: "Thought",
  chars: (n) => `${n} chars`,
  thinking: "Thinking",
  copy: "Copy",
  copyFailed: "Copy failed",
  copied: "Copied",
  refresh: "Refresh",
  branchNewChat: "Branch in new chat",
  turnDuration: (d) => `This turn took ${d}`,
  yesterday: (time) => `Yesterday, ${time}`,
  today: (time) => `Today, ${time}`,
  contextPercent: (pct) => `${pct}% context`,
  metricContextTitle: (detail) => `Context used ${detail}`,
  metricCacheTitle: "Cache hit rate",
  metricTpsTitle: "Output speed",
  metricCostTitle: "Cost this session",
  approvalTitle: "Needs your confirmation",
  clarifyTitle: "Question",
  approvalOnce: "Allow once",
  approvalSession: "Allow this session",
  approvalAlways: "Always allow",
  approvalDeny: "Deny",
  submit: "Submit",
  attachFiles: "Add files",
  pickModel: "Model and reasoning",
  reasoning: "Reasoning",
  reasoningLow: "Low",
  reasoningMedium: "Medium",
  reasoningHigh: "High",
  stopReasoningTitle: "Stop the current turn",
  filterModels: "Filter models…",
  noModels: "No matching models",
  loading: "Loading…",
  current: "current",
  noKey: "no API key",
  history: "History",
  historyEmpty: "No past sessions",
  historyLoading: "Loading…",
  refreshTitle: "Refresh",
  collapse: "Collapse",
  newChat: "New chat",
  closeTab: "Close",
  emptyTabs: "No open sessions",
  untitled: "Untitled",
  minutesAgo: (n) => `${n} min ago`,
  hoursAgo: (n) => `${n} h ago`,
  daysAgo: (n) => `${n} d ago`,
  editingHint: "Editing a sent message — sending rewrites the turn from here",
  titleRequired: "A title is required",
  editUnavailable: "That message is no longer in this transcript",
  editNoAnchor: "This message has no stored id yet, so the turn cannot be rewritten",
  sessionOpen: "Open in a tab",
  sessionRunning: "Running",
  jumpToMessage: "Jump to an earlier message",
  copyCode: "Copy code",
  edit: "Edit",
  rename: "Rename",
  delete: "Delete",
  deleteConfirm: "Delete this session? This cannot be undone.",
  deleteRefused: "The session is still active on the gateway, so it was not deleted. Close it first.",
  saved: "Saved",
  cheapModelConfirm: "That is an expensive model — switch cancelled",
  modelQueued: "Model switch queued; takes effect next turn",
  steered: "Inserted into the running turn; the model sees it at its next step",
  redirected: "Turn redirected",
  queued: "Queued — sends when the current turn ends",
  fileReadFailed: "Could not read the file",
  sessionNotReady: "Session is not ready yet",
  todos: "Tasks",
  todoProgress: (done, total) => `${done}/${total} done`,
  todoEmpty: "No tasks yet",
  subagents: "Subagents",
  subagentProgress: (done, total) => `${done}/${total} finished`,
  subagentTools: (n) => `${n} tools`,
  subagentStatus: (status) =>
    ({
      queued: "queued",
      running: "running",
      completed: "done",
      failed: "failed",
      error: "error",
      timeout: "timed out",
      interrupted: "interrupted",
    })[status] ?? status,
  notifyApprovalTitle: "Hermes needs your confirmation",
  notifyClarifyTitle: "Hermes is asking a question",
  notifyDoneTitle: "Hermes finished",
  notifyFailedTitle: "Hermes stopped with an error",
  notifyOnTitle: "Desktop notifications on (only while this window is in the background)",
  notifyOffTitle: "Desktop notifications off",
  notifyBlockedTitle: "Notifications are blocked in the browser settings",
};

const ZH: Messages = {
  empty: "开始一段对话。输入 / 唤起命令。",
  composerPlaceholder: "发消息，或输入 / 唤起命令",
  send: "发送",
  insert: "插入",
  stop: "停止",
  thought: "思考",
  chars: (n) => `${n} 字`,
  thinking: "思考中",
  copy: "复制",
  copyFailed: "复制失败",
  copied: "已复制",
  refresh: "重新生成",
  branchNewChat: "在新对话中分支",
  turnDuration: (d) => `本轮用时 ${d}`,
  yesterday: (time) => `昨天 ${time}`,
  today: (time) => `今天 ${time}`,
  contextPercent: (pct) => `上下文 ${pct}%`,
  metricContextTitle: (detail) => `上下文占用 ${detail}`,
  metricCacheTitle: "缓存命中率",
  metricTpsTitle: "输出速度",
  metricCostTitle: "本会话花费",
  approvalTitle: "需要你确认",
  clarifyTitle: "请选择",
  approvalOnce: "允许一次",
  approvalSession: "本次会话允许",
  approvalAlways: "总是允许",
  approvalDeny: "拒绝",
  submit: "提交",
  attachFiles: "添加文件",
  pickModel: "模型与思考强度",
  reasoning: "思考",
  reasoningLow: "低",
  reasoningMedium: "中",
  reasoningHigh: "高",
  stopReasoningTitle: "停止当前任务",
  filterModels: "筛选模型…",
  noModels: "没有匹配的模型",
  loading: "载入中…",
  current: "当前",
  noKey: "未配置密钥",
  history: "历史会话",
  historyEmpty: "没有历史会话",
  historyLoading: "载入中…",
  refreshTitle: "刷新",
  collapse: "收起",
  newChat: "新对话",
  closeTab: "关闭",
  emptyTabs: "没有打开的会话",
  untitled: "未命名",
  minutesAgo: (n) => `${n} 分钟前`,
  hoursAgo: (n) => `${n} 小时前`,
  daysAgo: (n) => `${n} 天前`,
  editingHint: "正在编辑已发送的消息 —— 发送将从这里重写这一轮",
  titleRequired: "标题不能为空",
  editUnavailable: "该消息已不在当前转写中",
  editNoAnchor: "该消息还没有存储行号，无法改写这一轮",
  sessionOpen: "已在页签中打开",
  sessionRunning: "正在运行",
  jumpToMessage: "跳到之前的消息",
  copyCode: "复制代码",
  edit: "编辑",
  rename: "重命名",
  delete: "删除",
  deleteConfirm: "删除这个会话？无法撤销。",
  deleteRefused: "该会话仍在网关中活跃，未能删除。请先关闭它。",
  saved: "已保存",
  cheapModelConfirm: "这是一个较贵的模型，已取消切换",
  modelQueued: "模型切换已排队，下一轮生效",
  steered: "已插入当前任务，模型会在下一步看到它",
  redirected: "已改为新方向",
  queued: "已排队，当前任务结束后发送",
  fileReadFailed: "读取文件失败",
  sessionNotReady: "会话尚未建立",
  todos: "任务清单",
  todoProgress: (done, total) => `完成 ${done}/${total}`,
  todoEmpty: "暂无任务",
  subagents: "子代理",
  subagentProgress: (done, total) => `完成 ${done}/${total}`,
  subagentTools: (n) => `${n} 次工具`,
  subagentStatus: (status) =>
    ({
      queued: "排队中",
      running: "运行中",
      completed: "已完成",
      failed: "失败",
      error: "出错",
      timeout: "超时",
      interrupted: "已中断",
    })[status] ?? status,
  notifyApprovalTitle: "Hermes 需要你确认",
  notifyClarifyTitle: "Hermes 有问题要问你",
  notifyDoneTitle: "Hermes 已完成",
  notifyFailedTitle: "Hermes 出错停止",
  notifyOnTitle: "桌面通知已开启（仅窗口不在前台时弹出）",
  notifyOffTitle: "桌面通知已关闭",
  notifyBlockedTitle: "浏览器里已阻止通知权限",
};

const CATALOG: Record<Locale, Messages> = { en: EN, zh: ZH };

export function messagesFor(locale: Locale): Messages {
  return CATALOG[locale] ?? EN;
}

/**
 * The reasoning tiers, as the composer's cycle button labels them.
 *
 * The list of legal values is protocol data and lives in `core/slash.ts`; only
 * their presentation is here. An unmapped value falls through to itself, so a
 * backend that adds a tier degrades to showing the raw name instead of blanking.
 */
const REASONING_LABELS: Record<Locale, Record<string, string>> = {
  en: {
    none: "off",
    minimal: "least",
    low: "low",
    medium: "medium",
    high: "high",
    xhigh: "very high",
    max: "max",
    ultra: "ultra",
  },
  zh: {
    none: "关闭",
    minimal: "最少",
    low: "低",
    medium: "中",
    high: "高",
    xhigh: "很高",
    max: "最大",
    ultra: "极限",
  },
};

export function reasoningLabel(value: string, locale: Locale): string {
  return REASONING_LABELS[locale]?.[value] ?? value;
}

/**
 * A compact clock, `HH:MM`, for the per-message timestamp.
 *
 * Takes MILLISECONDS (timeline items carry `at` / `completedAt` in ms — see
 * `core/types.ts`). It used to take seconds and multiply, while its callers were
 * already handing it milliseconds; that is the bug that rendered a 02:46 turn as
 * 19:32.
 *
 * `HH:MM` is the one format that does not need translating; the day is
 * disambiguated by the label instead of by a locale.
 */
export function clockTime(millis: number): string {
  if (!Number.isFinite(millis) || millis <= 0) return "";
  const date = new Date(millis);
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${hours}:${minutes}`;
}

/** `2026-10-17 01:50:03` — the tooltip's full stamp, locale-independent. Takes milliseconds. */
export function fullStamp(millis: number): string {
  if (!Number.isFinite(millis) || millis <= 0) return "";
  const date = new Date(millis);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/**
 * The bubble's timestamp label.
 *
 * Today and yesterday get named (matching the desktop app's `Yesterday, 3:27`
 * shape); anything older is a bare date plus the clock, which needs no word.
 */
export function messageStamp(millis: number, locale: Locale, now = Date.now()): string {
  const time = clockTime(millis);
  if (!time) return "";
  const t = messagesFor(locale);
  const then = new Date(millis);
  const today = new Date(now);
  // Compared against local midnight, so "today" is the viewer's today rather
  // than a UTC day boundary.
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  if (then.getTime() >= startOfToday) return t.today(time);
  if (then.getTime() >= startOfToday - 86_400_000) return t.yesterday(time);
  return `${then.getMonth() + 1}/${then.getDate()} ${time}`;
}

/** A duration like `2.3s` / `1m12s`, matching the tool card's formatting. */
export function formatElapsed(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "";
  if (seconds < 1) return `${Math.round(seconds * 1000)}ms`;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return `${minutes}m${rest}s`;
}
