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
  /** Tool-row names. `core/` only knows tool ids; the verb is chosen here. */
  toolTerminal: string;
  toolReadFile: string;
  toolWriteFile: string;
  toolPatch: string;
  toolSearchFiles: string;
  toolWebSearch: string;
  toolWebExtract: string;
  toolBrowserExec: string;
  toolDelegateTask: string;
  toolTodoList: string;
  toolMemory: string;
  toolSkillView: string;
  toolSkillManage: string;
  toolImageGen: string;
  toolTextToSpeech: string;
  /** The composer's status line while a turn runs with no backend text. */
  working: string;
  /** After the socket drops, until it comes back. */
  reconnecting: string;
  /** Fallback body for an error notice that carried no message. */
  genericError: string;
  /** Attachment screening. */
  attachmentTooLarge: (mib: number) => string;
  attachmentEmpty: string;
  /** Slash-menu rows for skills (the backend describes its own commands). */
  skill: string;
  skillOrigin: (origin: string) => string;
  /** A tool result the backend flagged. */
  outputRisk: (risk: string) => string;
  /** The whole page failed to mount. */
  renderFailed: (detail: string) => string;
  /** Slash-command outcomes and controller-side failures. */
  slashUnrecognized: (name: string) => string;
  slashDone: (name: string) => string;
  slashTypeUnsupported: (name: string, type: string) => string;
  replyNotFound: string;
  userMessageNotFound: string;
  attachmentNotAccepted: string;
  /** Transport failures: the socket's detail line and its thrown errors. */
  heartbeatTimeout: string;
  connectUnauthorized: string;
  connectChatDisabled: string;
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
  /** Workspace picker: the directory the NEXT new chat starts in. */
  workspace: string;
  workspaceForNewChat: string;
  workspaceDefault: string;
  workspaceRescan: string;
  workspaceCustom: string;
  workspaceApply: string;
  workspaceSessionCwd: string;
  workspaceLoadFailed: string;
  /** Git badge beside the workspace chip (nothing renders outside a repo). */
  gitRefresh: string;
  gitDetached: string;
  gitClean: string;
  gitStaged: (n: number) => string;
  gitUnstaged: (n: number) => string;
  gitUntracked: (n: number) => string;
  gitConflicts: (n: number) => string;
  gitAhead: (n: number) => string;
  gitBehind: (n: number) => string;
  gitTruncated: string;
  /** History panel: the flat recent list vs the project tree. */
  recent: string;
  projects: string;
  newChatInProject: string;
  ungrouped: string;
  noProjects: string;
  projectsFailed: string;
  projectSessionCount: (n: number) => string;
  showAllSessions: string;
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
  /** Other sessions as context (`core/context.ts`). */
  useAsContext: string;
  contextHeader: (title: string) => string;
  contextFooter: (included: number, omitted: number) => string;
  contextEmpty: string;
  contextFailed: (reason: string) => string;
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
  /** Switch is on in storage, but the browser has not been asked yet. */
  notifyPendingTitle: string;
  notifyTestTitle: string;
  notifyTestBody: string;
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
  toolTerminal: "Ran a command",
  toolReadFile: "Read a file",
  toolWriteFile: "Wrote a file",
  toolPatch: "Edited a file",
  toolSearchFiles: "Searched files",
  toolWebSearch: "Searched the web",
  toolWebExtract: "Fetched a page",
  toolBrowserExec: "Drove the browser",
  toolDelegateTask: "Delegated a task",
  toolTodoList: "Task list",
  toolMemory: "Memory",
  toolSkillView: "Viewed a skill",
  toolSkillManage: "Edited a skill",
  toolImageGen: "Generated an image",
  toolTextToSpeech: "Spoke text",
  working: "Working…",
  reconnecting: "Connection lost, reconnecting…",
  genericError: "Something went wrong",
  attachmentTooLarge: (mib) => `Over the ${mib} MiB limit`,
  attachmentEmpty: "Empty file",
  skill: "Skill",
  skillOrigin: (origin) => `Skill · ${origin}`,
  outputRisk: (risk) => `Output flagged as ${risk}`,
  renderFailed: (detail) => `The chat page failed to render: ${detail}`,
  slashUnrecognized: (name) => `/${name} returned something this page could not read`,
  slashDone: (name) => `/${name} ran`,
  slashTypeUnsupported: (name, type) => `/${name} returned a "${type}" result, which this page cannot show yet`,
  replyNotFound: "That reply is no longer in this transcript",
  userMessageNotFound: "Could not find the user message to rewrite",
  attachmentNotAccepted: "The backend did not accept that attachment",
  heartbeatTimeout: "Heartbeat timed out",
  connectUnauthorized: "Not authorised — reload the page",
  connectChatDisabled: "Chat is not enabled on this dashboard",
  approvalTitle: "Needs your confirmation",
  clarifyTitle: "Question",
  approvalOnce: "Allow once",
  approvalSession: "Allow this session",
  approvalAlways: "Always allow",
  approvalDeny: "Deny",
  submit: "Submit",
  attachFiles: "Add files",
  pickModel: "Model and reasoning",
  workspace: "Workspace",
  workspaceForNewChat: "Directory the next new chat starts in",
  workspaceDefault: "Default directory",
  workspaceRescan: "Rescan repositories",
  workspaceCustom: "Custom path…",
  workspaceApply: "Use",
  workspaceSessionCwd: "This chat's directory",
  workspaceLoadFailed: "Could not list workspaces",
  gitRefresh: "Refresh git status",
  gitDetached: "Detached HEAD",
  gitClean: "Working tree clean",
  gitStaged: (n) => `${n} staged`,
  gitUnstaged: (n) => `${n} unstaged`,
  gitUntracked: (n) => `${n} untracked`,
  gitConflicts: (n) => `${n} unmerged`,
  gitAhead: (n) => `ahead by ${n}`,
  gitBehind: (n) => `behind by ${n}`,
  gitTruncated: "too many changes — counts are a lower bound",
  recent: "Recent",
  projects: "Projects",
  newChatInProject: "New chat here",
  ungrouped: "Ungrouped",
  noProjects: "No projects yet",
  projectsFailed: "Could not load projects",
  projectSessionCount: (n) => `${n} ${n === 1 ? "session" : "sessions"}`,
  showAllSessions: "Show all",
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
  useAsContext: "Use as context (drag into the input too)",
  contextHeader: (title) => `=== Session context: "${title}" (another conversation, reference only) ===`,
  contextFooter: (included, omitted) =>
    omitted > 0
      ? `=== End of context (${included} messages; ${omitted} earlier ones omitted) ===`
      : `=== End of context (${included} messages) ===`,
  contextEmpty: "That session has no text to reuse",
  contextFailed: (reason) => `Could not read that session: ${reason}`,
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
  notifyPendingTitle: "Desktop notifications are not allowed yet — click to ask this browser",
  notifyTestTitle: "Desktop notifications are on",
  notifyTestBody: "This is what a finished turn looks like.",
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
  toolTerminal: "执行命令",
  toolReadFile: "读取文件",
  toolWriteFile: "写入文件",
  toolPatch: "修改文件",
  toolSearchFiles: "搜索",
  toolWebSearch: "联网搜索",
  toolWebExtract: "抓取网页",
  toolBrowserExec: "操作浏览器",
  toolDelegateTask: "委派子任务",
  toolTodoList: "任务清单",
  toolMemory: "记忆",
  toolSkillView: "查看技能",
  toolSkillManage: "编辑技能",
  toolImageGen: "生成图片",
  toolTextToSpeech: "语音合成",
  working: "正在处理…",
  reconnecting: "连接中断，重连中…",
  genericError: "发生错误",
  attachmentTooLarge: (mib) => `超过 ${mib} MiB 上限`,
  attachmentEmpty: "空文件",
  skill: "技能",
  skillOrigin: (origin) => `技能 · ${origin}`,
  outputRisk: (risk) => `输出被标记为 ${risk}`,
  renderFailed: (detail) => `气泡聊天页渲染失败：${detail}`,
  slashUnrecognized: (name) => `/${name} 返回了无法识别的结果`,
  slashDone: (name) => `/${name} 已执行`,
  slashTypeUnsupported: (name, type) => `/${name} 的结果类型 ${type} 暂不支持`,
  replyNotFound: "找不到该回复",
  userMessageNotFound: "找不到对应的用户消息",
  attachmentNotAccepted: "后端未接受该附件",
  heartbeatTimeout: "心跳超时",
  connectUnauthorized: "鉴权失败，请刷新页面",
  connectChatDisabled: "聊天功能未启用",
  approvalTitle: "需要你确认",
  clarifyTitle: "请选择",
  approvalOnce: "允许一次",
  approvalSession: "本次会话允许",
  approvalAlways: "总是允许",
  approvalDeny: "拒绝",
  submit: "提交",
  attachFiles: "添加文件",
  pickModel: "模型与思考强度",
  workspace: "工作区",
  workspaceForNewChat: "下一个新对话的起始目录",
  workspaceDefault: "默认目录",
  workspaceRescan: "重新扫描仓库",
  workspaceCustom: "自定义路径…",
  workspaceApply: "使用",
  workspaceSessionCwd: "本对话所在目录",
  workspaceLoadFailed: "无法列出工作区",
  gitRefresh: "刷新 Git 状态",
  gitDetached: "游离 HEAD",
  gitClean: "工作区干净",
  gitStaged: (n) => `已暂存 ${n}`,
  gitUnstaged: (n) => `未暂存 ${n}`,
  gitUntracked: (n) => `未跟踪 ${n}`,
  gitConflicts: (n) => `冲突 ${n}`,
  gitAhead: (n) => `领先远端 ${n}`,
  gitBehind: (n) => `落后远端 ${n}`,
  gitTruncated: "改动过多，计数为下限",
  recent: "最近",
  projects: "项目",
  newChatInProject: "在此新建对话",
  ungrouped: "未归类",
  noProjects: "还没有项目",
  projectsFailed: "加载项目失败",
  projectSessionCount: (n) => `${n} 个会话`,
  showAllSessions: "展开全部",
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
  useAsContext: "作为上下文（也可以直接拖进输入框）",
  contextHeader: (title) => `=== 会话上下文：「${title}」（另一个会话的记录，仅供参考）===`,
  contextFooter: (included, omitted) =>
    omitted > 0
      ? `=== 上下文结束（共 ${included} 条，更早的 ${omitted} 条已省略）===`
      : `=== 上下文结束（共 ${included} 条）===`,
  contextEmpty: "这个会话没有可复用的文本",
  contextFailed: (reason) => `读取该会话失败：${reason}`,
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
  notifyBlockedTitle: "浏览器里已阻止通知权限，需在站点设置里重新允许",
  notifyPendingTitle: "桌面通知还没生效——浏览器尚未授权，点这里授权",
  notifyTestTitle: "桌面通知已开启",
  notifyTestBody: "一轮结束时的通知就长这样。",
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
