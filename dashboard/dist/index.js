"use strict";
var HermesBubbles = (() => {
  // src/ui/sdk.ts
  function requireSdk() {
    const sdk = typeof window !== "undefined" ? window.__HERMES_PLUGIN_SDK__ : void 0;
    if (!sdk || !sdk.React) {
      throw new Error("hermes-bubbles: plugin SDK not available (window.__HERMES_PLUGIN_SDK__ missing)");
    }
    return sdk;
  }

  // src/core/attachments.ts
  function attachMethodFor(kind) {
    if (kind === "image") return "image.attach_bytes";
    if (kind === "pdf") return "pdf.attach";
    return "file.attach";
  }
  function isPreviewable(kind) {
    return kind === "image" || kind === "video";
  }
  function messageAttachments(queue) {
    return queue.filter((item) => item.status === "ready").map((item) => ({
      kind: item.kind,
      name: item.name,
      size: item.size,
      preview: item.previewUrl,
      ref: item.refText
    }));
  }
  function splitAttachmentRefs(text) {
    const cut = text.search(/\n+--- (?:Attached Context|Context Warnings) ---/);
    const body = cut >= 0 ? text.slice(0, cut) : text;
    const refs = [];
    const kept = [];
    for (const line of body.split("\n")) {
      const match = /^@(file|image):(.+)$/.exec(line.trim());
      if (!match) {
        kept.push(line);
        continue;
      }
      const raw = (match[2] ?? "").trim();
      const value = /^[`"']/.test(raw) && raw.length > 1 && raw.at(-1) === raw[0] ? raw.slice(1, -1) : raw;
      const kind = match[1] === "image" ? "image" : "file";
      if (!refs.some((ref) => ref.ref === `@${kind}:${value}`)) refs.push(refAttachment(kind, value));
    }
    const cleaned = kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
    return { text: cleaned, refs };
  }
  function refAttachment(kind, value) {
    const name = value.split(/[\\/]/).pop() || value;
    return { kind, name, ref: `@${kind === "image" ? "image" : "file"}:${value}` };
  }
  function attachmentPercent(item) {
    if (item.status !== "staging" || item.phase !== "reading") return null;
    const p = item.readProgress;
    if (typeof p !== "number" || !Number.isFinite(p)) return null;
    return Math.max(0, Math.min(100, Math.round(p * 100)));
  }
  function classifyFile(name, mime) {
    const lower = name.toLowerCase();
    if (lower.endsWith(".pdf") || mime === "application/pdf") return "pdf";
    if (mime?.startsWith("image/")) return "image";
    if (mime?.startsWith("video/")) return "video";
    if (/\.(png|jpe?g|gif|webp|bmp|avif|svg)$/.test(lower)) return "image";
    if (/\.(mp4|webm|mov|m4v|ogv)$/.test(lower)) return "video";
    return "file";
  }
  var MAX_ATTACHMENT_BYTES = 12 * 1024 * 1024;
  var MAX_ATTACHMENT_MIB = Math.round(MAX_ATTACHMENT_BYTES / 1024 / 1024);
  function screenFiles(files) {
    const accepted = [];
    const rejected = [];
    for (const file of files) {
      if (file.size > MAX_ATTACHMENT_BYTES) {
        rejected.push({ name: file.name, code: "too_large", limitMib: MAX_ATTACHMENT_MIB });
        continue;
      }
      if (file.size === 0) {
        rejected.push({ name: file.name, code: "empty" });
        continue;
      }
      accepted.push({ name: file.name, size: file.size, kind: classifyFile(file.name, file.type) });
    }
    return { accepted, rejected };
  }
  function addAttachment(queue, item) {
    return [...queue, item];
  }
  function removeAttachment(queue, id) {
    return queue.filter((item) => item.id !== id);
  }
  function updateAttachment(queue, id, patch) {
    return queue.map((item) => item.id === id ? { ...item, ...patch } : item);
  }
  function formatBytes(bytes) {
    if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) return "";
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KiB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
  }

  // src/core/cards.ts
  function ownerKeyOf(state, sessionId) {
    if (!sessionId) return null;
    const tab = state.tabs.find((candidate) => candidate.runtimeId === sessionId);
    return tab?.key ?? null;
  }
  function cardsForTab(state, cards, tabKey) {
    if (!tabKey) return [...cards];
    return cards.filter((card) => {
      const owner = ownerKeyOf(state, card.sessionId);
      if (owner === null) return tabKey === state.activeKey;
      return owner === tabKey;
    });
  }
  function waitingKeys(state, cards) {
    const keys = [];
    for (const card of cards) {
      const owner = ownerKeyOf(state, card.sessionId);
      if (owner !== null && !keys.includes(owner)) keys.push(owner);
    }
    return keys;
  }
  function str(value) {
    return typeof value === "string" ? value : "";
  }
  function withdrawalsFrom(event) {
    const payload = event.payload ?? {};
    const reason = str(payload.reason);
    if (event.type === "request.cancel") {
      const id = str(payload.id);
      return id ? [{ id, reason, sessionId: str(event.session_id) || str(payload.session_id) }] : [];
    }
    if (event.type === "approval.cancelled") {
      const ids = Array.isArray(payload.request_ids) ? payload.request_ids : [];
      const sessionId = str(payload.session_id);
      return ids.filter((id) => typeof id === "string" && id.length > 0).map((id) => ({ id, reason, sessionId }));
    }
    return [];
  }
  function isWithdrawalEvent(type) {
    return type === "request.cancel" || type === "approval.cancelled";
  }
  function withoutWithdrawn(cards, withdrawals) {
    if (!withdrawals.length) return cards;
    const gone = new Set(withdrawals.map((withdrawal) => withdrawal.id));
    const kept = cards.filter((card) => !gone.has(card.id));
    return kept.length === cards.length ? cards : kept;
  }

  // src/core/i18n.ts
  var DEFAULT_LOCALE = "en";
  var LOCALE_STORAGE_KEY = "hermes-locale";
  function normalizeLocale(raw) {
    if (!raw) return DEFAULT_LOCALE;
    const value = raw.trim().toLowerCase();
    if (!value || value === "auto") return DEFAULT_LOCALE;
    if (value === "zh" || value.startsWith("zh-")) return "zh";
    if (value.startsWith("en")) return "en";
    return DEFAULT_LOCALE;
  }
  var EN = {
    empty: "Start a conversation. Type / for commands.",
    composerPlaceholder: "Send a message, or type / for commands",
    composerPlaceholderShort: "Message\u2026",
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
    working: "Working\u2026",
    reconnecting: "Connection lost, reconnecting\u2026",
    genericError: "Something went wrong",
    attachmentTooLarge: (mib) => `Over the ${mib} MiB limit`,
    attachmentEmpty: "Empty file",
    skill: "Skill",
    skillOrigin: (origin) => `Skill \xB7 ${origin}`,
    outputRisk: (risk) => `Output flagged as ${risk}`,
    renderFailed: (detail) => `The chat page failed to render: ${detail}`,
    slashUnrecognized: (name) => `/${name} returned something this page could not read`,
    slashDone: (name) => `/${name} ran`,
    slashTypeUnsupported: (name, type) => `/${name} returned a "${type}" result, which this page cannot show yet`,
    replyNotFound: "That reply is no longer in this transcript",
    userMessageNotFound: "Could not find the user message to rewrite",
    attachmentNotAccepted: "The backend did not accept that attachment",
    heartbeatTimeout: "Heartbeat timed out",
    connectUnauthorized: "Not authorised \u2014 reload the page",
    connectChatDisabled: "Chat is not enabled on this dashboard",
    approvalTitle: "Needs your confirmation",
    clarifyTitle: "Question",
    clarifyOther: "Type your own answer",
    approvalOnce: "Allow once",
    approvalSession: "Allow this session",
    approvalAlways: "Always allow",
    approvalDeny: "Deny",
    submit: "Submit",
    modelConfirmTitle: "Confirm the model switch",
    modelConfirmFallback: "This switch needs your confirmation.",
    modelConfirmAccept: "Switch anyway",
    cancel: "Cancel",
    attachFiles: "Add files",
    attachReading: "Reading",
    attachUploading: "Uploading",
    attachmentsLabel: "Attachments",
    imageAttachment: "Image",
    videoAttachment: "Video",
    chatMenu: "Chats",
    refreshChat: "Refresh this chat",
    composerMore: "Model, reasoning, notifications",
    notifications: "Notifications",
    pickModel: "Model and reasoning",
    workspace: "Workspace",
    workspaceForNewChat: "Directory the next new chat starts in",
    workspaceDefault: "Default directory",
    workspaceRescan: "Rescan repositories",
    workspaceCustom: "Custom path\u2026",
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
    gitTruncated: "too many changes \u2014 counts are a lower bound",
    recent: "Recent",
    projects: "Projects",
    newChatInProject: "New chat here",
    ungrouped: "Ungrouped",
    noProjects: "No projects yet",
    projectsFailed: "Could not load projects",
    projectSessionCount: (n) => `${n} ${n === 1 ? "session" : "sessions"}`,
    showAllSessions: "Show all",
    projectMenu: "Project actions",
    projectHide: "Remove from list",
    projectHideHint: "Hides this repository here; nothing on disk or in the backend changes",
    projectHideConfirm: "Remove this repository from the project list? Your sessions and files stay.",
    projectDeleteHint: "Deletes the project entry; its folders and sessions stay",
    projectDeleteConfirm: "Delete this project? The folder and its sessions are not deleted, but the project entry cannot be restored from here.",
    projectRestoreHidden: (n) => `Show ${n} hidden`,
    projectRenameFailed: "Could not rename the project",
    projectRemoveFailed: "Could not remove the project",
    reasoning: "Reasoning",
    reasoningLow: "Low",
    reasoningMedium: "Medium",
    reasoningHigh: "High",
    approvalMode: "Approvals",
    approvalModeManual: "Manual",
    approvalModeSmart: "Smart",
    approvalModeOff: "Off",
    approvalModeTitle: (mode) => `Approval mode: ${mode}`,
    approvalModeHint: "How dangerous commands are approved \u2014 applies to all conversations on this profile",
    approvalModeCycleHint: "Click to change \xB7 applies to all conversations on this profile",
    stopReasoningTitle: "Stop the current turn",
    filterModels: "Filter models\u2026",
    noModels: "No matching models",
    loading: "Loading\u2026",
    current: "current",
    noKey: "no API key",
    history: "History",
    historyEmpty: "No past sessions",
    historyLoading: "Loading\u2026",
    refreshTitle: "Refresh",
    collapse: "Collapse",
    newChat: "New chat",
    closeTab: "Close",
    emptyTabs: "No open sessions",
    waitingForAnswer: "This chat is waiting for your answer",
    untitled: "Untitled",
    minutesAgo: (n) => `${n} min ago`,
    hoursAgo: (n) => `${n} h ago`,
    daysAgo: (n) => `${n} d ago`,
    editingHint: "Editing a sent message \u2014 sending rewrites the turn from here",
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
    contextFooter: (included, omitted) => omitted > 0 ? `=== End of context (${included} messages; ${omitted} earlier ones omitted) ===` : `=== End of context (${included} messages) ===`,
    contextEmpty: "That session has no text to reuse",
    contextFailed: (reason) => `Could not read that session: ${reason}`,
    saved: "Saved",
    modelQueued: "Model switch queued; takes effect next turn",
    steered: "Inserted into the running turn; the model sees it at its next step",
    redirected: "Turn redirected",
    queued: "Queued \u2014 sends when the current turn ends",
    fileReadFailed: "Could not read the file",
    sessionNotReady: "Session is not ready yet",
    noticeProcess: "Background process finished",
    noticeSubagents: (count) => `${count} background agent${count === 1 ? "" : "s"} finished`,
    noticeBackground: "Background work reported back",
    noticeModel: "Model changed",
    noticeContinue: "Resumed an interrupted turn",
    noticePersonality: "Personality changed",
    todos: "Tasks",
    todoProgress: (done, total) => `${done}/${total} done`,
    todoEmpty: "No tasks yet",
    subagents: "Subagents",
    activityThoughts: (n) => `${n} thought${n === 1 ? "" : "s"}`,
    activityTools: (n) => `${n} call${n === 1 ? "" : "s"}`,
    activitySubagents: (n) => `${n} delegation${n === 1 ? "" : "s"}`,
    activityNotices: (n) => `${n} notice${n === 1 ? "" : "s"}`,
    activityExpand: "Show all of it",
    activityCollapse: "Fold it back",
    subagentProgress: (done, total) => `${done}/${total} finished`,
    subagentTools: (n) => `${n} tools`,
    subagentStatus: (status) => ({
      queued: "queued",
      running: "running",
      completed: "done",
      failed: "failed",
      error: "error",
      timeout: "timed out",
      interrupted: "interrupted"
    })[status] ?? status,
    notifyApprovalTitle: "Hermes needs your confirmation",
    notifyClarifyTitle: "Hermes is asking a question",
    notifyDoneTitle: "Hermes finished",
    notifyFailedTitle: "Hermes stopped with an error",
    notifyOnTitle: "Desktop notifications on (only while this window is in the background)",
    notifyOffTitle: "Desktop notifications off",
    notifyBlockedTitle: "Notifications are blocked in the browser settings",
    notifyPendingTitle: "Desktop notifications are not allowed yet \u2014 click to ask this browser",
    notifyTestTitle: "Desktop notifications are on",
    notifyTestBody: "This is what a finished turn looks like."
  };
  var ZH = {
    empty: "\u5F00\u59CB\u4E00\u6BB5\u5BF9\u8BDD\u3002\u8F93\u5165 / \u5524\u8D77\u547D\u4EE4\u3002",
    composerPlaceholder: "\u53D1\u6D88\u606F\uFF0C\u6216\u8F93\u5165 / \u5524\u8D77\u547D\u4EE4",
    composerPlaceholderShort: "\u53D1\u6D88\u606F\u2026",
    send: "\u53D1\u9001",
    insert: "\u63D2\u5165",
    stop: "\u505C\u6B62",
    thought: "\u601D\u8003",
    chars: (n) => `${n} \u5B57`,
    thinking: "\u601D\u8003\u4E2D",
    copy: "\u590D\u5236",
    copyFailed: "\u590D\u5236\u5931\u8D25",
    copied: "\u5DF2\u590D\u5236",
    refresh: "\u91CD\u65B0\u751F\u6210",
    branchNewChat: "\u5728\u65B0\u5BF9\u8BDD\u4E2D\u5206\u652F",
    turnDuration: (d) => `\u672C\u8F6E\u7528\u65F6 ${d}`,
    yesterday: (time) => `\u6628\u5929 ${time}`,
    today: (time) => `\u4ECA\u5929 ${time}`,
    contextPercent: (pct) => `\u4E0A\u4E0B\u6587 ${pct}%`,
    metricContextTitle: (detail) => `\u4E0A\u4E0B\u6587\u5360\u7528 ${detail}`,
    metricCacheTitle: "\u7F13\u5B58\u547D\u4E2D\u7387",
    metricTpsTitle: "\u8F93\u51FA\u901F\u5EA6",
    metricCostTitle: "\u672C\u4F1A\u8BDD\u82B1\u8D39",
    toolTerminal: "\u6267\u884C\u547D\u4EE4",
    toolReadFile: "\u8BFB\u53D6\u6587\u4EF6",
    toolWriteFile: "\u5199\u5165\u6587\u4EF6",
    toolPatch: "\u4FEE\u6539\u6587\u4EF6",
    toolSearchFiles: "\u641C\u7D22",
    toolWebSearch: "\u8054\u7F51\u641C\u7D22",
    toolWebExtract: "\u6293\u53D6\u7F51\u9875",
    toolBrowserExec: "\u64CD\u4F5C\u6D4F\u89C8\u5668",
    toolDelegateTask: "\u59D4\u6D3E\u5B50\u4EFB\u52A1",
    toolTodoList: "\u4EFB\u52A1\u6E05\u5355",
    toolMemory: "\u8BB0\u5FC6",
    toolSkillView: "\u67E5\u770B\u6280\u80FD",
    toolSkillManage: "\u7F16\u8F91\u6280\u80FD",
    toolImageGen: "\u751F\u6210\u56FE\u7247",
    toolTextToSpeech: "\u8BED\u97F3\u5408\u6210",
    working: "\u6B63\u5728\u5904\u7406\u2026",
    reconnecting: "\u8FDE\u63A5\u4E2D\u65AD\uFF0C\u91CD\u8FDE\u4E2D\u2026",
    genericError: "\u53D1\u751F\u9519\u8BEF",
    attachmentTooLarge: (mib) => `\u8D85\u8FC7 ${mib} MiB \u4E0A\u9650`,
    attachmentEmpty: "\u7A7A\u6587\u4EF6",
    skill: "\u6280\u80FD",
    skillOrigin: (origin) => `\u6280\u80FD \xB7 ${origin}`,
    outputRisk: (risk) => `\u8F93\u51FA\u88AB\u6807\u8BB0\u4E3A ${risk}`,
    renderFailed: (detail) => `\u6C14\u6CE1\u804A\u5929\u9875\u6E32\u67D3\u5931\u8D25\uFF1A${detail}`,
    slashUnrecognized: (name) => `/${name} \u8FD4\u56DE\u4E86\u65E0\u6CD5\u8BC6\u522B\u7684\u7ED3\u679C`,
    slashDone: (name) => `/${name} \u5DF2\u6267\u884C`,
    slashTypeUnsupported: (name, type) => `/${name} \u7684\u7ED3\u679C\u7C7B\u578B ${type} \u6682\u4E0D\u652F\u6301`,
    replyNotFound: "\u627E\u4E0D\u5230\u8BE5\u56DE\u590D",
    userMessageNotFound: "\u627E\u4E0D\u5230\u5BF9\u5E94\u7684\u7528\u6237\u6D88\u606F",
    attachmentNotAccepted: "\u540E\u7AEF\u672A\u63A5\u53D7\u8BE5\u9644\u4EF6",
    heartbeatTimeout: "\u5FC3\u8DF3\u8D85\u65F6",
    connectUnauthorized: "\u9274\u6743\u5931\u8D25\uFF0C\u8BF7\u5237\u65B0\u9875\u9762",
    connectChatDisabled: "\u804A\u5929\u529F\u80FD\u672A\u542F\u7528",
    approvalTitle: "\u9700\u8981\u4F60\u786E\u8BA4",
    clarifyTitle: "\u8BF7\u9009\u62E9",
    clarifyOther: "\u81EA\u5DF1\u8F93\u5165\u7B54\u6848",
    approvalOnce: "\u5141\u8BB8\u4E00\u6B21",
    approvalSession: "\u672C\u6B21\u4F1A\u8BDD\u5141\u8BB8",
    approvalAlways: "\u603B\u662F\u5141\u8BB8",
    approvalDeny: "\u62D2\u7EDD",
    submit: "\u63D0\u4EA4",
    modelConfirmTitle: "\u786E\u8BA4\u5207\u6362\u6A21\u578B",
    modelConfirmFallback: "\u8FD9\u6B21\u5207\u6362\u9700\u8981\u4F60\u786E\u8BA4\u3002",
    modelConfirmAccept: "\u4ECD\u7136\u5207\u6362",
    cancel: "\u53D6\u6D88",
    attachFiles: "\u6DFB\u52A0\u6587\u4EF6",
    attachReading: "\u6B63\u5728\u8BFB\u53D6",
    attachUploading: "\u6B63\u5728\u4E0A\u4F20",
    attachmentsLabel: "\u9644\u4EF6",
    imageAttachment: "\u56FE\u7247",
    videoAttachment: "\u89C6\u9891",
    chatMenu: "\u4F1A\u8BDD",
    refreshChat: "\u5237\u65B0\u672C\u5BF9\u8BDD",
    composerMore: "\u6A21\u578B\u3001\u601D\u8003\u5F3A\u5EA6\u3001\u901A\u77E5",
    notifications: "\u901A\u77E5\u8BBE\u7F6E",
    pickModel: "\u6A21\u578B\u4E0E\u601D\u8003\u5F3A\u5EA6",
    workspace: "\u5DE5\u4F5C\u533A",
    workspaceForNewChat: "\u4E0B\u4E00\u4E2A\u65B0\u5BF9\u8BDD\u7684\u8D77\u59CB\u76EE\u5F55",
    workspaceDefault: "\u9ED8\u8BA4\u76EE\u5F55",
    workspaceRescan: "\u91CD\u65B0\u626B\u63CF\u4ED3\u5E93",
    workspaceCustom: "\u81EA\u5B9A\u4E49\u8DEF\u5F84\u2026",
    workspaceApply: "\u4F7F\u7528",
    workspaceSessionCwd: "\u672C\u5BF9\u8BDD\u6240\u5728\u76EE\u5F55",
    workspaceLoadFailed: "\u65E0\u6CD5\u5217\u51FA\u5DE5\u4F5C\u533A",
    gitRefresh: "\u5237\u65B0 Git \u72B6\u6001",
    gitDetached: "\u6E38\u79BB HEAD",
    gitClean: "\u5DE5\u4F5C\u533A\u5E72\u51C0",
    gitStaged: (n) => `\u5DF2\u6682\u5B58 ${n}`,
    gitUnstaged: (n) => `\u672A\u6682\u5B58 ${n}`,
    gitUntracked: (n) => `\u672A\u8DDF\u8E2A ${n}`,
    gitConflicts: (n) => `\u51B2\u7A81 ${n}`,
    gitAhead: (n) => `\u9886\u5148\u8FDC\u7AEF ${n}`,
    gitBehind: (n) => `\u843D\u540E\u8FDC\u7AEF ${n}`,
    gitTruncated: "\u6539\u52A8\u8FC7\u591A\uFF0C\u8BA1\u6570\u4E3A\u4E0B\u9650",
    recent: "\u6700\u8FD1",
    projects: "\u9879\u76EE",
    newChatInProject: "\u5728\u6B64\u65B0\u5EFA\u5BF9\u8BDD",
    ungrouped: "\u672A\u5F52\u7C7B",
    noProjects: "\u8FD8\u6CA1\u6709\u9879\u76EE",
    projectsFailed: "\u52A0\u8F7D\u9879\u76EE\u5931\u8D25",
    projectSessionCount: (n) => `${n} \u4E2A\u4F1A\u8BDD`,
    showAllSessions: "\u5C55\u5F00\u5168\u90E8",
    projectMenu: "\u9879\u76EE\u64CD\u4F5C",
    projectHide: "\u4ECE\u5217\u8868\u79FB\u9664",
    projectHideHint: "\u53EA\u5728\u8FD9\u4E2A\u9875\u9762\u9690\u85CF\u8BE5\u4ED3\u5E93\uFF0C\u78C1\u76D8\u548C\u540E\u7AEF\u90FD\u4E0D\u52A8",
    projectHideConfirm: "\u4ECE\u9879\u76EE\u5217\u8868\u79FB\u9664\u8FD9\u4E2A\u4ED3\u5E93\uFF1F\u4F1A\u8BDD\u548C\u6587\u4EF6\u90FD\u8FD8\u5728\u3002",
    projectDeleteHint: "\u5220\u9664\u9879\u76EE\u6761\u76EE\uFF1B\u6587\u4EF6\u5939\u4E0E\u4F1A\u8BDD\u90FD\u4E0D\u5220",
    projectDeleteConfirm: "\u5220\u9664\u8FD9\u4E2A\u9879\u76EE\uFF1F\u6587\u4EF6\u5939\u548C\u4F1A\u8BDD\u4E0D\u4F1A\u88AB\u5220\u9664\uFF0C\u4F46\u9879\u76EE\u6761\u76EE\u65E0\u6CD5\u5728\u8FD9\u91CC\u6062\u590D\u3002",
    projectRestoreHidden: (n) => `\u663E\u793A ${n} \u4E2A\u5DF2\u9690\u85CF`,
    projectRenameFailed: "\u9879\u76EE\u91CD\u547D\u540D\u5931\u8D25",
    projectRemoveFailed: "\u79FB\u9664\u9879\u76EE\u5931\u8D25",
    reasoning: "\u601D\u8003",
    reasoningLow: "\u4F4E",
    reasoningMedium: "\u4E2D",
    reasoningHigh: "\u9AD8",
    approvalMode: "\u5BA1\u6279",
    approvalModeManual: "\u624B\u52A8",
    approvalModeSmart: "\u667A\u80FD",
    approvalModeOff: "\u5173\u95ED",
    approvalModeTitle: (mode) => `\u5BA1\u6279\u6A21\u5F0F\uFF1A${mode}`,
    approvalModeHint: "\u5371\u9669\u547D\u4EE4\u5982\u4F55\u5BA1\u6279\u2014\u2014\u4F5C\u7528\u4E8E\u672C\u914D\u7F6E\u4E0B\u7684\u6240\u6709\u5BF9\u8BDD",
    approvalModeCycleHint: "\u70B9\u4E00\u4E0B\u5207\u6362 \xB7 \u4F5C\u7528\u4E8E\u672C\u914D\u7F6E\u4E0B\u7684\u6240\u6709\u5BF9\u8BDD",
    stopReasoningTitle: "\u505C\u6B62\u5F53\u524D\u4EFB\u52A1",
    filterModels: "\u7B5B\u9009\u6A21\u578B\u2026",
    noModels: "\u6CA1\u6709\u5339\u914D\u7684\u6A21\u578B",
    loading: "\u8F7D\u5165\u4E2D\u2026",
    current: "\u5F53\u524D",
    noKey: "\u672A\u914D\u7F6E\u5BC6\u94A5",
    history: "\u5386\u53F2\u4F1A\u8BDD",
    historyEmpty: "\u6CA1\u6709\u5386\u53F2\u4F1A\u8BDD",
    historyLoading: "\u8F7D\u5165\u4E2D\u2026",
    refreshTitle: "\u5237\u65B0",
    collapse: "\u6536\u8D77",
    newChat: "\u65B0\u5BF9\u8BDD",
    closeTab: "\u5173\u95ED",
    emptyTabs: "\u6CA1\u6709\u6253\u5F00\u7684\u4F1A\u8BDD",
    waitingForAnswer: "\u8FD9\u4E2A\u5BF9\u8BDD\u5728\u7B49\u4F60\u56DE\u7B54",
    untitled: "\u672A\u547D\u540D",
    minutesAgo: (n) => `${n} \u5206\u949F\u524D`,
    hoursAgo: (n) => `${n} \u5C0F\u65F6\u524D`,
    daysAgo: (n) => `${n} \u5929\u524D`,
    editingHint: "\u6B63\u5728\u7F16\u8F91\u5DF2\u53D1\u9001\u7684\u6D88\u606F \u2014\u2014 \u53D1\u9001\u5C06\u4ECE\u8FD9\u91CC\u91CD\u5199\u8FD9\u4E00\u8F6E",
    titleRequired: "\u6807\u9898\u4E0D\u80FD\u4E3A\u7A7A",
    editUnavailable: "\u8BE5\u6D88\u606F\u5DF2\u4E0D\u5728\u5F53\u524D\u8F6C\u5199\u4E2D",
    editNoAnchor: "\u8BE5\u6D88\u606F\u8FD8\u6CA1\u6709\u5B58\u50A8\u884C\u53F7\uFF0C\u65E0\u6CD5\u6539\u5199\u8FD9\u4E00\u8F6E",
    sessionOpen: "\u5DF2\u5728\u9875\u7B7E\u4E2D\u6253\u5F00",
    sessionRunning: "\u6B63\u5728\u8FD0\u884C",
    jumpToMessage: "\u8DF3\u5230\u4E4B\u524D\u7684\u6D88\u606F",
    copyCode: "\u590D\u5236\u4EE3\u7801",
    edit: "\u7F16\u8F91",
    rename: "\u91CD\u547D\u540D",
    delete: "\u5220\u9664",
    deleteConfirm: "\u5220\u9664\u8FD9\u4E2A\u4F1A\u8BDD\uFF1F\u65E0\u6CD5\u64A4\u9500\u3002",
    deleteRefused: "\u8BE5\u4F1A\u8BDD\u4ECD\u5728\u7F51\u5173\u4E2D\u6D3B\u8DC3\uFF0C\u672A\u80FD\u5220\u9664\u3002\u8BF7\u5148\u5173\u95ED\u5B83\u3002",
    useAsContext: "\u4F5C\u4E3A\u4E0A\u4E0B\u6587\uFF08\u4E5F\u53EF\u4EE5\u76F4\u63A5\u62D6\u8FDB\u8F93\u5165\u6846\uFF09",
    contextHeader: (title) => `=== \u4F1A\u8BDD\u4E0A\u4E0B\u6587\uFF1A\u300C${title}\u300D\uFF08\u53E6\u4E00\u4E2A\u4F1A\u8BDD\u7684\u8BB0\u5F55\uFF0C\u4EC5\u4F9B\u53C2\u8003\uFF09===`,
    contextFooter: (included, omitted) => omitted > 0 ? `=== \u4E0A\u4E0B\u6587\u7ED3\u675F\uFF08\u5171 ${included} \u6761\uFF0C\u66F4\u65E9\u7684 ${omitted} \u6761\u5DF2\u7701\u7565\uFF09===` : `=== \u4E0A\u4E0B\u6587\u7ED3\u675F\uFF08\u5171 ${included} \u6761\uFF09===`,
    contextEmpty: "\u8FD9\u4E2A\u4F1A\u8BDD\u6CA1\u6709\u53EF\u590D\u7528\u7684\u6587\u672C",
    contextFailed: (reason) => `\u8BFB\u53D6\u8BE5\u4F1A\u8BDD\u5931\u8D25\uFF1A${reason}`,
    saved: "\u5DF2\u4FDD\u5B58",
    modelQueued: "\u6A21\u578B\u5207\u6362\u5DF2\u6392\u961F\uFF0C\u4E0B\u4E00\u8F6E\u751F\u6548",
    steered: "\u5DF2\u63D2\u5165\u5F53\u524D\u4EFB\u52A1\uFF0C\u6A21\u578B\u4F1A\u5728\u4E0B\u4E00\u6B65\u770B\u5230\u5B83",
    redirected: "\u5DF2\u6539\u4E3A\u65B0\u65B9\u5411",
    queued: "\u5DF2\u6392\u961F\uFF0C\u5F53\u524D\u4EFB\u52A1\u7ED3\u675F\u540E\u53D1\u9001",
    fileReadFailed: "\u8BFB\u53D6\u6587\u4EF6\u5931\u8D25",
    sessionNotReady: "\u4F1A\u8BDD\u5C1A\u672A\u5EFA\u7ACB",
    noticeProcess: "\u540E\u53F0\u8FDB\u7A0B\u5DF2\u7ED3\u675F",
    noticeSubagents: (count) => `${count} \u4E2A\u540E\u53F0\u5B50\u4EE3\u7406\u5DF2\u5B8C\u6210`,
    noticeBackground: "\u540E\u53F0\u4EFB\u52A1\u5DF2\u56DE\u62A5",
    noticeModel: "\u6A21\u578B\u5DF2\u5207\u6362",
    noticeContinue: "\u7EE7\u7EED\u4E86\u88AB\u4E2D\u65AD\u7684\u4E00\u8F6E",
    noticePersonality: "\u4EBA\u683C\u5DF2\u5207\u6362",
    todos: "\u4EFB\u52A1\u6E05\u5355",
    todoProgress: (done, total) => `\u5B8C\u6210 ${done}/${total}`,
    todoEmpty: "\u6682\u65E0\u4EFB\u52A1",
    subagents: "\u5B50\u4EE3\u7406",
    activityThoughts: (n) => `${n} \u6BB5\u601D\u8003`,
    activityTools: (n) => `${n} \u6B21\u8C03\u7528`,
    activitySubagents: (n) => `${n} \u7EC4\u5B50\u4EE3\u7406`,
    activityNotices: (n) => `${n} \u6761\u4E8B\u4EF6`,
    activityExpand: "\u5C55\u5F00\u5168\u90E8",
    activityCollapse: "\u6298\u53E0",
    subagentProgress: (done, total) => `\u5B8C\u6210 ${done}/${total}`,
    subagentTools: (n) => `${n} \u6B21\u5DE5\u5177`,
    subagentStatus: (status) => ({
      queued: "\u6392\u961F\u4E2D",
      running: "\u8FD0\u884C\u4E2D",
      completed: "\u5DF2\u5B8C\u6210",
      failed: "\u5931\u8D25",
      error: "\u51FA\u9519",
      timeout: "\u8D85\u65F6",
      interrupted: "\u5DF2\u4E2D\u65AD"
    })[status] ?? status,
    notifyApprovalTitle: "Hermes \u9700\u8981\u4F60\u786E\u8BA4",
    notifyClarifyTitle: "Hermes \u6709\u95EE\u9898\u8981\u95EE\u4F60",
    notifyDoneTitle: "Hermes \u5DF2\u5B8C\u6210",
    notifyFailedTitle: "Hermes \u51FA\u9519\u505C\u6B62",
    notifyOnTitle: "\u684C\u9762\u901A\u77E5\u5DF2\u5F00\u542F\uFF08\u4EC5\u7A97\u53E3\u4E0D\u5728\u524D\u53F0\u65F6\u5F39\u51FA\uFF09",
    notifyOffTitle: "\u684C\u9762\u901A\u77E5\u5DF2\u5173\u95ED",
    notifyBlockedTitle: "\u6D4F\u89C8\u5668\u91CC\u5DF2\u963B\u6B62\u901A\u77E5\u6743\u9650\uFF0C\u9700\u5728\u7AD9\u70B9\u8BBE\u7F6E\u91CC\u91CD\u65B0\u5141\u8BB8",
    notifyPendingTitle: "\u684C\u9762\u901A\u77E5\u8FD8\u6CA1\u751F\u6548\u2014\u2014\u6D4F\u89C8\u5668\u5C1A\u672A\u6388\u6743\uFF0C\u70B9\u8FD9\u91CC\u6388\u6743",
    notifyTestTitle: "\u684C\u9762\u901A\u77E5\u5DF2\u5F00\u542F",
    notifyTestBody: "\u4E00\u8F6E\u7ED3\u675F\u65F6\u7684\u901A\u77E5\u5C31\u957F\u8FD9\u6837\u3002"
  };
  var CATALOG = { en: EN, zh: ZH };
  function messagesFor(locale) {
    return CATALOG[locale] ?? EN;
  }
  var REASONING_LABELS = {
    en: {
      none: "off",
      minimal: "least",
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "very high",
      max: "max",
      ultra: "ultra"
    },
    zh: {
      none: "\u5173\u95ED",
      minimal: "\u6700\u5C11",
      low: "\u4F4E",
      medium: "\u4E2D",
      high: "\u9AD8",
      xhigh: "\u5F88\u9AD8",
      max: "\u6700\u5927",
      ultra: "\u6781\u9650"
    }
  };
  function reasoningLabel(value, locale) {
    return REASONING_LABELS[locale]?.[value] ?? value;
  }
  function approvalModeLabel(value, locale) {
    const m = messagesFor(locale);
    switch (value) {
      case "manual":
        return m.approvalModeManual;
      case "off":
        return m.approvalModeOff;
      case "smart":
        return m.approvalModeSmart;
      default:
        return value || m.approvalMode;
    }
  }
  function clockTime(millis) {
    if (!Number.isFinite(millis) || millis <= 0) return "";
    const date = new Date(millis);
    const hours = String(date.getHours()).padStart(2, "0");
    const minutes = String(date.getMinutes()).padStart(2, "0");
    return `${hours}:${minutes}`;
  }
  function messageStamp(millis, locale, now = Date.now()) {
    const time = clockTime(millis);
    if (!time) return "";
    const t = messagesFor(locale);
    const then = new Date(millis);
    const today = new Date(now);
    const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
    if (then.getTime() >= startOfToday) return t.today(time);
    if (then.getTime() >= startOfToday - 864e5) return t.yesterday(time);
    return `${then.getMonth() + 1}/${then.getDate()} ${time}`;
  }
  function formatElapsed(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return "";
    if (seconds < 1) return `${Math.round(seconds * 1e3)}ms`;
    if (seconds < 60) return `${seconds.toFixed(1)}s`;
    const minutes = Math.floor(seconds / 60);
    const rest = Math.round(seconds % 60);
    return `${minutes}m${rest}s`;
  }

  // src/core/context.ts
  var SESSION_CONTEXT_MIME = "application/x-hb-session";
  var CONTEXT_MAX_CHARS = 8e3;
  var CONTEXT_PER_MESSAGE_CHARS = 1500;
  function usable(row) {
    if (row.display_kind === "hidden") return null;
    const role = row.role === "user" || row.role === "assistant" ? row.role : null;
    if (!role) return null;
    const text = (textOf(row.display_content) || textOf(row.text) || textOf(row.content)).trim();
    if (!text) return null;
    return { role, text };
  }
  function textOf(value) {
    if (typeof value === "string") return value;
    if (!Array.isArray(value)) return "";
    const parts = [];
    for (const part of value) {
      if (typeof part === "string") {
        parts.push(part);
        continue;
      }
      if (!part || typeof part !== "object") continue;
      const record = part;
      const text = typeof record.text === "string" ? record.text : record.content;
      if (typeof text === "string" && text) parts.push(text);
    }
    return parts.join("\n");
  }
  function clip(text, limit) {
    if (text.length <= limit) return text;
    return `${text.slice(0, limit).trimEnd()}\u2026`;
  }
  function render(role, text) {
    return `[${role}]
${text}`;
  }
  function sessionContextBlock(ref, messages, options) {
    const t = messagesFor(options.locale);
    const budget = options.maxChars ?? CONTEXT_MAX_CHARS;
    const perMessage = options.perMessageChars ?? CONTEXT_PER_MESSAGE_CHARS;
    const header = t.contextHeader(ref.title || ref.id.slice(0, 8));
    const footerReserve = 120;
    const room = Math.max(budget - header.length - footerReserve, 0);
    const kept = [];
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
        omitted += i + 1;
        break;
      }
      kept.push(block);
      used += cost;
    }
    if (!kept.length) return { text: "", included: 0, omitted };
    kept.reverse();
    const footer = t.contextFooter(kept.length, omitted);
    return { text: `${header}

${kept.join("\n\n")}

${footer}`, included: kept.length, omitted };
  }
  function sessionDragPayload(ref) {
    return JSON.stringify({ id: ref.id, title: ref.title });
  }
  function parseSessionDrop(raw) {
    const value = (raw ?? "").trim();
    if (!value) return null;
    if (value.startsWith("{")) {
      try {
        const parsed = JSON.parse(value);
        if (typeof parsed.id === "string" && parsed.id) {
          return { id: parsed.id, title: typeof parsed.title === "string" ? parsed.title : "" };
        }
      } catch {
        return null;
      }
      return null;
    }
    return /^[A-Za-z0-9_.:-]+$/.test(value) ? { id: value, title: "" } : null;
  }
  function insertContext(draft, block) {
    const body = draft.trim();
    if (!body) return block;
    return `${block}

${body}`;
  }

  // src/core/gitinfo.ts
  function parseGitStatus(status, root = "", truncated = false) {
    const info = {
      root: root ?? "",
      oid: "",
      branch: "",
      detached: false,
      upstream: "",
      ahead: 0,
      behind: 0,
      staged: 0,
      unstaged: 0,
      untracked: 0,
      conflicts: 0,
      truncated: truncated === true
    };
    let sawHeader = false;
    for (const line of (status ?? "").split(/\r?\n/)) {
      if (!line) continue;
      if (line.startsWith("# ")) {
        sawHeader = true;
        const rest = line.slice(2);
        const space = rest.indexOf(" ");
        const key = space === -1 ? rest : rest.slice(0, space);
        const value = space === -1 ? "" : rest.slice(space + 1);
        if (key === "branch.oid") info.oid = value === "(initial)" ? "" : value;
        else if (key === "branch.head") {
          if (value === "(detached)") info.detached = true;
          else info.branch = value;
        } else if (key === "branch.upstream") info.upstream = value;
        else if (key === "branch.ab") {
          const match = /^\+(\d+)\s+-(\d+)$/.exec(value.trim());
          if (match) {
            info.ahead = Number(match[1]);
            info.behind = Number(match[2]);
          }
        }
        continue;
      }
      const kind = line[0];
      if (kind === "?") {
        info.untracked += 1;
        continue;
      }
      if (kind === "1" || kind === "2") {
        const x = line[2] ?? ".";
        const y = line[3] ?? ".";
        if (x !== ".") info.staged += 1;
        if (y !== ".") info.unstaged += 1;
        continue;
      }
      if (kind === "u") {
        info.conflicts += 1;
        continue;
      }
    }
    return sawHeader ? info : null;
  }
  function changedCount(info) {
    return info.staged + info.unstaged + info.untracked + info.conflicts;
  }
  function gitBranchLabel(info) {
    if (!info.detached) return info.branch || "HEAD";
    return info.oid ? info.oid.slice(0, 7) : "HEAD";
  }
  function gitTargetDir(sessionCwd, pick, home) {
    const open = (sessionCwd ?? "").trim();
    if (open) return open;
    const preference = (pick ?? "").trim();
    if (preference) return preference;
    return (home ?? "").trim();
  }

  // src/core/pin.ts
  var STICK_SLACK_PX = 24;
  var RELEASE_INTENT_PX = 8;
  var pinnedState = { lastTop: 0, released: false };
  function distanceFromBottom(metrics) {
    const overflow = metrics.scrollHeight - metrics.clientHeight;
    if (!Number.isFinite(overflow) || overflow <= 0) return 0;
    const scrolled = Math.max(0, Math.min(overflow, metrics.scrollTop));
    return overflow - scrolled;
  }
  function atBottom(metrics) {
    return distanceFromBottom(metrics) <= STICK_SLACK_PX;
  }
  function pinAfterScroll(metrics, state) {
    if (atBottom(metrics)) return { lastTop: metrics.scrollTop, released: false };
    const movedUp = state.lastTop - metrics.scrollTop;
    return {
      lastTop: metrics.scrollTop,
      released: state.released || movedUp > RELEASE_INTENT_PX
    };
  }
  function followAfterChange(metrics, state) {
    if (atBottom(metrics)) {
      return { decision: "follow", state: { lastTop: metrics.scrollTop, released: false } };
    }
    const movedUp = state.lastTop - metrics.scrollTop;
    const released = state.released || movedUp > RELEASE_INTENT_PX;
    return {
      decision: released ? "hold" : "follow",
      state: { lastTop: metrics.scrollTop, released }
    };
  }

  // src/core/slash.ts
  function findSlashToken(text, caret) {
    const pos = Math.max(0, Math.min(caret, text.length));
    let start = -1;
    for (let i = pos - 1; i >= 0; i -= 1) {
      const ch = text[i];
      if (ch === "/") {
        start = i;
        break;
      }
      if (ch === void 0 || /\s/.test(ch)) break;
    }
    if (start === -1) return null;
    if (start > 0) {
      const before = text[start - 1];
      if (before !== void 0 && !/\s/.test(before)) return null;
    }
    const raw = text.slice(start, pos);
    const body = raw.slice(1);
    if (body && !/^[\w:.-]*$/.test(body)) return null;
    return { raw, query: body, start, end: pos };
  }
  function applyCompletion(text, token, name) {
    const inserted = `/${name} `;
    const next = text.slice(0, token.start) + inserted + text.slice(token.end);
    return { text: next, caret: token.start + inserted.length };
  }
  function filterCommands(entries, query, limit = 50) {
    const q = query.trim().toLowerCase();
    const matched = q ? entries.filter(
      (entry) => entry.name.toLowerCase().includes(q) || entry.description.toLowerCase().includes(q)
    ) : entries.slice();
    return matched.sort((a, b) => {
      const aPrefix = q && a.name.toLowerCase().startsWith(q) ? 0 : 1;
      const bPrefix = q && b.name.toLowerCase().startsWith(q) ? 0 : 1;
      if (aPrefix !== bPrefix) return aPrefix - bPrefix;
      if (!q && a.kind !== b.kind) return a.kind === "command" ? -1 : 1;
      if (a.kind === "skill" && b.kind === "skill") return (b.usage ?? 0) - (a.usage ?? 0);
      return a.name.localeCompare(b.name);
    }).slice(0, limit);
  }
  function entriesFromCatalog(catalog) {
    const out = [];
    const seen = /* @__PURE__ */ new Set();
    const push = (pair) => {
      const name = (pair?.[0] ?? "").replace(/^\//, "").trim();
      if (!name || seen.has(name)) return;
      seen.add(name);
      out.push({ name, description: pair?.[1] ?? "", kind: "command" });
    };
    if (catalog.categories?.length) {
      for (const category of catalog.categories) {
        for (const pair of category.pairs ?? []) push(pair);
      }
    }
    if (!out.length) {
      for (const pair of catalog.pairs ?? []) push(pair);
    }
    for (const [name, meta] of Object.entries(catalog.skills ?? {})) {
      const clean = name.replace(/^\//, "").trim();
      if (!clean || seen.has(clean)) continue;
      seen.add(clean);
      out.push({ name: clean, description: "", kind: "skill", origin: meta?.origin ?? "", usage: meta?.usage ?? 0 });
    }
    return out;
  }
  function parseCommandInput(text) {
    const trimmed = text.trim();
    if (!trimmed.startsWith("/")) return null;
    const body = trimmed.slice(1);
    const match = /^([\w:.-]+)\s*([\s\S]*)$/.exec(body);
    if (!match) return null;
    return { name: match[1] ?? "", arg: (match[2] ?? "").trim() };
  }
  function parseDispatch(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const row = raw;
    const str4 = (v) => typeof v === "string" ? v : "";
    switch (row.type) {
      case "alias":
        return typeof row.target === "string" ? { type: "alias", target: row.target } : null;
      case "exec":
      case "plugin":
        return { type: row.type, output: str4(row.output) };
      case "prefill":
        return typeof row.message === "string" ? { type: "prefill", message: row.message, notice: str4(row.notice) } : null;
      case "send":
        return typeof row.message === "string" ? { type: "send", message: row.message, display: str4(row.display), notice: str4(row.notice) } : null;
      case "skill":
        return typeof row.name === "string" ? { type: "skill", name: row.name, message: str4(row.message), display: str4(row.display) } : null;
      default:
        return null;
    }
  }
  var REASONING_LEVELS = [
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
    "ultra"
  ];
  var REASONING_VALUES = ["none", ...REASONING_LEVELS];

  // src/core/dedupe.ts
  var SEEN_PER_SESSION_MAX = 2048;
  var SESSIONS_MAX = 64;
  var EventDedupe = class {
    sessions = /* @__PURE__ */ new Map();
    epoch = "";
    /** Called with `gateway.ready.payload.replay_epoch`. */
    setEpoch(epoch) {
      if (epoch === this.epoch) return;
      this.epoch = epoch;
      this.sessions.clear();
    }
    getEpoch() {
      return this.epoch;
    }
    /** True when the frame is new and must be handled. */
    admit(event) {
      const { session_id: sid, seq } = event;
      if (!sid || typeof seq !== "number" || !Number.isFinite(seq)) return true;
      const key = `${this.epoch}\0${sid}`;
      let entry = this.sessions.get(key);
      if (entry) {
        this.sessions.delete(key);
      } else {
        entry = { seen: /* @__PURE__ */ new Set() };
      }
      this.sessions.set(key, entry);
      while (this.sessions.size > SESSIONS_MAX) {
        const oldest = this.sessions.keys().next().value;
        if (oldest === void 0) break;
        this.sessions.delete(oldest);
      }
      if (entry.seen.has(seq)) return false;
      entry.seen.add(seq);
      while (entry.seen.size > SEEN_PER_SESSION_MAX) {
        const oldest = entry.seen.values().next().value;
        if (oldest === void 0) break;
        entry.seen.delete(oldest);
      }
      return true;
    }
  };

  // src/core/types.ts
  var TERMINAL_SUBAGENT_STATUSES = [
    "completed",
    "failed",
    "error",
    "timeout",
    "interrupted"
  ];
  function isSubagentTerminal(status) {
    return TERMINAL_SUBAGENT_STATUSES.includes(status);
  }
  var emptyMeta = {
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
    todo: null
  };
  var emptyTimeline = { items: [], meta: { ...emptyMeta } };
  function lastAssistant(items) {
    for (let i = items.length - 1; i >= 0; i -= 1) {
      const item = items[i];
      if (item && item.kind === "assistant") return item;
    }
    return null;
  }
  function openAssistant(items) {
    const last = lastAssistant(items);
    return last && last.streaming ? last : null;
  }
  function findTool(items, toolId) {
    for (let i = items.length - 1; i >= 0; i -= 1) {
      const item = items[i];
      if (item && item.kind === "tool" && item.toolId === toolId) return item;
    }
    return null;
  }

  // src/core/reduce.ts
  var counter = 0;
  function nextId(prefix) {
    counter += 1;
    return `${prefix}-${counter}`;
  }
  function str2(value) {
    return typeof value === "string" ? value : "";
  }
  function num(value) {
    return typeof value === "number" && Number.isFinite(value) ? value : void 0;
  }
  function sameText(a, b) {
    const norm = (value) => value.replace(/\s+/g, " ").trim();
    const left = norm(a);
    return left.length > 0 && left === norm(b);
  }
  function turnAssistant(items) {
    let turnStart = -1;
    for (let i = items.length - 1; i >= 0; i -= 1) {
      if (items[i]?.kind === "user") {
        turnStart = i;
        break;
      }
    }
    const last = lastAssistant(items);
    if (!last) return null;
    return items.lastIndexOf(last) > turnStart ? last : null;
  }
  function replaceLast(items, item) {
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
  function patchAssistant(items, target, patch) {
    return items.map((item) => item === target ? patch(item) : item);
  }
  function sealAssistant(items) {
    const open = openAssistant(items);
    if (!open) return items;
    return patchAssistant(items, open, (item) => ({ ...item, streaming: false }));
  }
  function openReasoning(items) {
    const last = items[items.length - 1];
    return last && last.kind === "reasoning" && last.streaming ? last : null;
  }
  function sealReasoning(items) {
    const open = openReasoning(items);
    if (!open) return items;
    const copy = items.slice();
    copy[copy.length - 1] = { ...open, streaming: false };
    return copy;
  }
  function appendReasoning(items, text) {
    const open = openReasoning(items);
    if (open) {
      const copy = items.slice();
      copy[copy.length - 1] = { ...open, text: open.text + text };
      return copy;
    }
    const fresh = { kind: "reasoning", id: nextId("reasoning"), at: Date.now(), text, streaming: true };
    return [...items, fresh];
  }
  function inferToolStatus(payload) {
    if (payload.error) return "error";
    const summary = str2(payload.summary);
    if (/\b(error|failed|failure|traceback|exception|denied|refused|timed out)\b/i.test(summary)) {
      return "error";
    }
    const result = payload.result;
    if (result && typeof result === "object" && !Array.isArray(result)) {
      if (result.error) return "error";
    }
    return "ok";
  }
  function toolFromStart(event) {
    const p = event.payload ?? {};
    const name = str2(p.name) || "tool";
    return {
      kind: "tool",
      id: nextId("tool"),
      at: Date.now(),
      toolId: str2(p.tool_id),
      name,
      summary: str2(p.context) || str2(p.preview) || "",
      status: "running",
      args: p.args,
      argsText: str2(p.args_text) || void 0
    };
  }
  var MAX_PROGRESS_LINES = 6;
  function todoEntry(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const row = value;
    const id = str2(row.id);
    const content = str2(row.content);
    if (!id || !content) return null;
    const parent = str2(row.parent);
    return { id, content, status: (str2(row.status) || "pending").toLowerCase(), parent: parent || void 0 };
  }
  function reduceTodos(current, payload) {
    if (!Array.isArray(payload.todos)) return void 0;
    const revision = num(payload.revision) ?? 0;
    if (current && revision < current.revision) return void 0;
    const todos = payload.todos.map(todoEntry).filter((entry) => entry !== null);
    if (!todos.length && revision === 0) return void 0;
    return { todos, revision };
  }
  var SUBAGENT_STATUSES = [
    "queued",
    "running",
    "completed",
    "failed",
    "error",
    "timeout",
    "interrupted"
  ];
  function subagentStatusOf(value) {
    const raw = str2(value).toLowerCase();
    return SUBAGENT_STATUSES.includes(raw) ? raw : void 0;
  }
  function stringList(value) {
    if (!Array.isArray(value)) return void 0;
    const out = value.filter((item) => typeof item === "string" && item.trim() !== "");
    return out.length ? out : void 0;
  }
  function outputTailOf(value) {
    if (!Array.isArray(value)) return void 0;
    const rows = value.filter((row) => Boolean(row) && typeof row === "object").map((row) => ({
      tool: str2(row.tool),
      preview: str2(row.preview),
      isError: Boolean(row.is_error)
    })).filter((row) => row.tool || row.preview);
    return rows.length ? rows.slice(-6) : void 0;
  }
  function batchKeyOf(p) {
    const delegation = str2(p.delegation_id);
    if (delegation) return delegation;
    const parent = str2(p.parent_id);
    return parent ? `flat:${parent}` : "flat";
  }
  function mergeChild(prev, type, p, key, taskIndex) {
    const base = prev ?? {
      key,
      taskIndex,
      goal: "",
      status: "queued",
      toolCount: 0,
      lastTool: "",
      progress: [],
      thinking: ""
    };
    const next = { ...base, progress: base.progress.slice() };
    const goal = str2(p.goal);
    if (goal) next.goal = goal;
    const model = str2(p.model);
    if (model) next.model = model;
    const toolsets = stringList(p.toolsets);
    if (toolsets) next.toolsets = toolsets;
    const toolCount = num(p.tool_count);
    if (toolCount !== void 0) next.toolCount = toolCount;
    const filesRead = stringList(p.files_read);
    if (filesRead) next.filesRead = filesRead;
    const filesWritten = stringList(p.files_written);
    if (filesWritten) next.filesWritten = filesWritten;
    const input = num(p.input_tokens);
    const output = num(p.output_tokens);
    if (input !== void 0 || output !== void 0) {
      next.tokens = { input: input ?? base.tokens?.input, output: output ?? base.tokens?.output };
    }
    switch (type) {
      case "subagent.start":
        next.status = "running";
        break;
      case "subagent.progress": {
        const line = str2(p.text);
        if (line) next.progress = [...base.progress, line].slice(-MAX_PROGRESS_LINES);
        break;
      }
      case "subagent.thinking": {
        const text = str2(p.text);
        if (text) next.thinking = text.length > 240 ? `\u2026${text.slice(-240)}` : text;
        break;
      }
      case "subagent.tool": {
        const tool = str2(p.tool_name) || str2(p.name);
        if (tool) next.lastTool = tool;
        const preview = str2(p.tool_preview) || str2(p.text);
        if (preview) next.progress = [...base.progress, preview].slice(-MAX_PROGRESS_LINES);
        break;
      }
      case "subagent.complete": {
        next.status = subagentStatusOf(p.status) ?? "completed";
        const summary = str2(p.summary) || str2(p.text);
        if (summary) next.summary = summary;
        const duration = num(p.duration_seconds);
        if (duration !== void 0) next.durationS = duration;
        const tail = outputTailOf(p.output_tail);
        if (tail) next.outputTail = tail;
        break;
      }
      default:
        break;
    }
    return next;
  }
  function upsertSubagent(items, event) {
    const p = event.payload ?? {};
    const type = event.type;
    const key = str2(p.subagent_id) || `idx:${num(p.task_index) ?? 0}`;
    const batchKey = batchKeyOf(p);
    const taskCount = num(p.task_count) ?? 1;
    const taskIndex = num(p.task_index) ?? 0;
    const anonymous = batchKey.startsWith("flat");
    let found = -1;
    for (let i = items.length - 1; i >= 0 && found < 0; i -= 1) {
      const item = items[i];
      if (item?.kind !== "subagents") continue;
      if (item.children.some((child2) => child2.key === key)) found = i;
    }
    if (found < 0) {
      for (let i = items.length - 1; i >= 0 && found < 0; i -= 1) {
        const item = items[i];
        if (item?.kind !== "subagents") continue;
        if (anonymous) {
          if (!item.finishedAt && item.children.length < item.taskCount) found = i;
        } else if (item.batchKey === batchKey && !item.finishedAt) {
          found = i;
        }
      }
    }
    const prev = found >= 0 ? items[found] : null;
    const base = prev ?? {
      kind: "subagents",
      id: nextId("subagents"),
      at: Date.now(),
      batchKey,
      taskCount,
      depth: num(p.depth),
      children: []
    };
    const existing = base.children.find((child2) => child2.key === key) ?? null;
    const child = mergeChild(existing, type, p, key, taskIndex);
    const children = existing ? base.children.map((row) => row.key === key ? child : row) : [...base.children, child].sort((a, b) => a.taskIndex - b.taskIndex);
    const done = children.length > 0 && children.every((row) => isSubagentTerminal(row.status));
    const next = {
      ...base,
      children,
      finishedAt: done ? base.finishedAt ?? Date.now() : void 0
    };
    if (found < 0) return [...items, next];
    const copy = items.slice();
    copy[found] = next;
    return copy;
  }
  function resultTextOf(p) {
    const explicit = str2(p.result_text);
    if (explicit) return explicit;
    const result = p.result;
    if (result === void 0 || result === null) return void 0;
    if (typeof result === "string") return result;
    try {
      return JSON.stringify(result, null, 2);
    } catch {
      return String(result);
    }
  }
  function reduceEvent(timeline, event) {
    const { items, meta } = timeline;
    const p = event.payload ?? {};
    switch (event.type) {
      case "gateway.ready":
        return { items, meta: { ...meta, connected: true, status: "", statusKind: "" } };
      case "gateway.closed":
      case "gateway.reconnecting":
        return { items, meta: { ...meta, connected: false, status: "", statusKind: "reconnecting" } };
      case "message.start":
        return {
          items: sealReasoning(sealAssistant(items)),
          meta: { ...meta, running: true, status: "", statusKind: "" }
        };
      case "message.delta": {
        const text = str2(p.text);
        if (!text) return timeline;
        const base = sealReasoning(items);
        const open = openAssistant(base);
        if (open) {
          return { items: replaceLast(base, { ...open, text: open.text + text }), meta };
        }
        const fresh = {
          kind: "assistant",
          id: nextId("assistant"),
          at: Date.now(),
          text,
          streaming: true
        };
        return { items: [...base, fresh], meta: { ...meta, running: true } };
      }
      case "message.interim": {
        const sealed = sealReasoning(sealAssistant(items));
        if (p.already_streamed) return { items: sealed, meta };
        const text = str2(p.text);
        if (!text) return { items: sealed, meta };
        const last = lastAssistant(sealed);
        if (last) return { items: replaceLast(sealed, { ...last, text: last.text + text }), meta };
        const fresh = {
          kind: "assistant",
          id: nextId("assistant"),
          at: Date.now(),
          text,
          streaming: false
        };
        return { items: [...sealed, fresh], meta };
      }
      case "message.complete": {
        const status = str2(p.status);
        const finalText = str2(p.text);
        const error = str2(p.error) || str2(p.failure_reason);
        const usage = p.usage ?? null;
        const settled = sealReasoning(items);
        const target = openAssistant(settled) ?? turnAssistant(settled);
        const completedAt = Date.now();
        const durationS = turnDuration(items, completedAt);
        let nextItems;
        if (target) {
          const merged = target.text.trim() ? target.text : finalText || target.text;
          nextItems = patchAssistant(settled, target, (item) => ({
            ...item,
            text: merged,
            streaming: false,
            error: status === "error" ? error || "turn failed" : void 0,
            partial: Boolean(p.partial),
            usage: usage ?? item.usage,
            completedAt,
            durationS
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
              error: status === "error" ? error || "turn failed" : void 0,
              partial: Boolean(p.partial),
              usage: usage ?? void 0,
              completedAt,
              durationS
            }
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
              durationS
            }
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
            usage: usage ?? meta.usage
          }
        };
      }
      case "reasoning.delta": {
        const text = str2(p.text);
        if (!text) return timeline;
        return { items: appendReasoning(sealAssistant(items), text), meta };
      }
      case "reasoning.available": {
        const text = str2(p.text);
        if (!text) return timeline;
        const reply = lastAssistant(items);
        if (reply && sameText(reply.text, text)) return timeline;
        return { items: appendReasoning(sealAssistant(items), text), meta };
      }
      case "tool.start": {
        const tool = toolFromStart(event);
        return { items: [...sealReasoning(sealAssistant(items)), tool], meta };
      }
      case "tool.complete": {
        const toolId = str2(p.tool_id);
        const existing = findTool(items, toolId);
        const status = inferToolStatus(p);
        const resultText = resultTextOf(p);
        if (!existing) {
          const orphan = {
            kind: "tool",
            id: nextId("tool"),
            at: Date.now(),
            toolId,
            name: str2(p.name) || "tool",
            summary: str2(p.summary),
            status,
            args: p.args,
            resultText,
            durationS: num(p.duration_s)
          };
          return { items: [...items, orphan], meta };
        }
        const updated = {
          ...existing,
          status,
          summary: str2(p.summary) || existing.summary,
          resultText: resultText ?? existing.resultText,
          durationS: num(p.duration_s) ?? existing.durationS
        };
        return { items: items.map((item) => item === existing ? updated : item), meta };
      }
      case "tool.output_risk": {
        const toolId = str2(p.tool_id);
        const existing = findTool(items, toolId);
        if (!existing) return timeline;
        const updated = { ...existing, risk: str2(p.risk) || "unknown" };
        return { items: items.map((item) => item === existing ? updated : item), meta };
      }
      case "todo.updated": {
        const todo = reduceTodos(meta.todo, p);
        if (todo === void 0) return timeline;
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
        const text = str2(p.text);
        const kind = str2(p.kind);
        return { items, meta: { ...meta, status: text || (kind ? `${kind}\u2026` : ""), statusKind: "" } };
      }
      case "session.usage": {
        const usage = p.usage ?? null;
        return { items, meta: { ...meta, usage: usage ?? meta.usage } };
      }
      case "session.title":
        return { items, meta: { ...meta, title: str2(p.title) || meta.title } };
      case "session.info": {
        const info = p;
        return {
          items,
          meta: {
            ...meta,
            model: str2(info.model) || meta.model,
            provider: str2(info.provider) || meta.provider,
            reasoningEffort: str2(info.reasoning_effort) || meta.reasoningEffort,
            running: typeof info.running === "boolean" ? info.running : meta.running,
            title: str2(info.title) || meta.title,
            usage: info.usage ?? meta.usage
          }
        };
      }
      case "notice":
        return {
          items: [
            ...items,
            { kind: "notice", id: nextId("notice"), at: Date.now(), text: str2(p.text) || str2(p.message), tone: "info" }
          ],
          meta
        };
      case "error":
        return {
          items: [
            ...items,
            { kind: "notice", id: nextId("notice"), at: Date.now(), text: str2(p.message), tone: "error" }
          ],
          meta: { ...meta, running: false }
        };
      default:
        return timeline;
    }
  }
  function appendUser(timeline, text, attachments = []) {
    return {
      items: [
        ...timeline.items,
        {
          kind: "user",
          id: nextId("user"),
          at: Date.now(),
          text,
          pending: true,
          ...attachments.length ? { attachments } : {}
        }
      ],
      meta: { ...timeline.meta, running: true, status: "", statusKind: "" }
    };
  }
  function ackUser(timeline, rowId) {
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
  function turnDuration(items, completedAt) {
    for (let i = items.length - 1; i >= 0; i -= 1) {
      const item = items[i];
      if (!item || item.kind !== "user") continue;
      const elapsed = (completedAt - item.at) / 1e3;
      if (!Number.isFinite(elapsed) || elapsed <= 0 || elapsed > 6 * 3600) return void 0;
      return elapsed;
    }
    return void 0;
  }
  function settleTimeline(timeline, note) {
    return {
      items: sealReasoning(sealAssistant(timeline.items)),
      meta: { ...timeline.meta, running: false, status: note ?? "", statusKind: "" }
    };
  }

  // src/core/history.ts
  var historyCounter = 0;
  function historyId(prefix) {
    historyCounter += 1;
    return `h${prefix}-${historyCounter}`;
  }
  function textOf2(value) {
    if (typeof value === "string") return value;
    if (value === null || value === void 0) return "";
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }
  var ASSISTANT_DETAIL_KEYS = ["reasoning", "thinking", "reasoning_text"];
  function assistantReasoning(row) {
    const parts = [];
    for (const key of ASSISTANT_DETAIL_KEYS) {
      const value = row[key];
      if (typeof value === "string" && value.trim()) parts.push(value);
    }
    return parts.join("\n\n");
  }
  function timestampOf(row, fallback) {
    const ts = row.timestamp;
    if (typeof ts !== "number" || !Number.isFinite(ts) || ts <= 0) return fallback;
    return ts > 1e11 ? ts : ts * 1e3;
  }
  var MACHINERY_KINDS = {
    process_complete: "process",
    async_delegation_complete: "subagents",
    internal_notification: "background",
    model_switch: "model",
    auto_continue: "continue",
    personality_switch: "personality"
  };
  function steerText(text) {
    const match = /\[OUT-OF-BAND USER MESSAGE[^\]]*\]\s*([\s\S]*?)\s*\[\/OUT-OF-BAND USER MESSAGE\]/.exec(text);
    return (match?.[1] ?? text).trim();
  }
  function projectHistory(messages, now = Date.now()) {
    const items = [];
    for (const row of messages) {
      const role = row.role;
      if (role !== "user" && role !== "assistant" && role !== "tool" && role !== "system") continue;
      if (row.display_kind === "hidden") continue;
      const at = timestampOf(row, now);
      const rowId = typeof row.row_id === "number" ? row.row_id : void 0;
      const rawText = typeof row.text === "string" ? row.text : "";
      const machinery = row.display_kind ? MACHINERY_KINDS[row.display_kind] : void 0;
      if (machinery) {
        const detail = rawText.trim();
        if (!detail) continue;
        items.push({ kind: "notice", id: historyId("notice"), at, text: "", tone: "info", noticeKind: machinery, detail });
        continue;
      }
      if (role === "tool") {
        const name = row.name ?? "tool";
        const item = {
          kind: "tool",
          id: historyId("tool"),
          at,
          toolId: row.tool_call_id ?? "",
          name,
          summary: row.context ?? "",
          // History does not record whether a call failed; the summary line is
          // the only signal and it is a display projection, not a verdict.
          status: "ok",
          args: row.args ?? void 0,
          resultText: row.content === void 0 ? void 0 : textOf2(row.content)
        };
        items.push(item);
        continue;
      }
      const text = rawText;
      if (role === "user") {
        const spoken = row.display_kind === "steer" ? steerText(text) : text;
        const split = splitAttachmentRefs(spoken);
        if (!split.text.trim() && !split.refs.length) continue;
        items.push({
          kind: "user",
          id: historyId("user"),
          at,
          text: split.text,
          rowId,
          ...split.refs.length ? { attachments: split.refs } : {}
        });
        continue;
      }
      if (role === "assistant") {
        const reasoning = assistantReasoning(row);
        if (!text.trim() && !reasoning) continue;
        if (reasoning) {
          items.push({ kind: "reasoning", id: historyId("reasoning"), at, text: reasoning, streaming: false });
        }
        if (!text.trim()) continue;
        const item = {
          kind: "assistant",
          id: historyId("assistant"),
          at,
          text,
          streaming: false,
          rowId
        };
        items.push(item);
        continue;
      }
      if (!text.trim()) continue;
      items.push({ kind: "notice", id: historyId("notice"), at, text, tone: "info" });
    }
    return items;
  }
  function timelineFromSnapshot(snapshot, now = Date.now()) {
    const info = snapshot.info ?? {};
    const todo = reduceTodos(null, snapshot.todo_state ?? {}) ?? null;
    return {
      items: projectHistory(snapshot.messages ?? [], now),
      meta: {
        runtimeId: snapshot.session_id ?? null,
        storedId: snapshot.stored_session_id ?? null,
        title: info.title ?? "",
        model: info.model ?? "",
        provider: info.provider ?? "",
        reasoningEffort: info.reasoning_effort ?? "",
        cwd: info.cwd ?? "",
        running: Boolean(info.running ?? snapshot.running),
        usage: info.usage ?? null,
        status: "",
        statusKind: "",
        connected: true,
        todo
      }
    };
  }

  // src/core/sessions.ts
  var emptyMultiState = { sessions: {}, tabs: [], activeKey: null, workspace: "" };
  function withWorkspace(state, cwd) {
    return state.workspace === cwd ? state : { ...state, workspace: cwd };
  }
  var draftCounter = 0;
  function nextDraftKey() {
    draftCounter += 1;
    return `draft:${draftCounter}`;
  }
  function timelineOf(state, key) {
    if (!key) return { items: [], meta: { ...emptyMeta } };
    return state.sessions[key] ?? { items: [], meta: { ...emptyMeta } };
  }
  function activeTimeline(state) {
    return timelineOf(state, state.activeKey);
  }
  function withTimeline(state, key, timeline) {
    return { ...state, sessions: { ...state.sessions, [key]: timeline } };
  }
  function openDraft(state) {
    const key = nextDraftKey();
    const tab = { key, runtimeId: null, storedId: null, title: "", draft: true };
    return {
      sessions: { ...state.sessions, [key]: { items: [], meta: { ...emptyMeta } } },
      tabs: [...state.tabs, tab],
      activeKey: key,
      workspace: state.workspace
    };
  }
  function bindSnapshot(state, key, snapshot, options = {}) {
    const timeline = timelineFromSnapshot(snapshot);
    const runtimeId = snapshot.session_id ?? null;
    const nextKey = runtimeId ?? key;
    const existing = state.sessions[key];
    const items = options.keepLocalItems && existing ? [...timeline.items, ...existing.items.filter((i) => i.kind === "user")] : timeline.items;
    const sessions = { ...state.sessions };
    if (nextKey !== key) delete sessions[key];
    const connected = options.connected ?? existing?.meta.connected ?? timeline.meta.connected;
    sessions[nextKey] = {
      items,
      // A snapshot without `todo_state` must not wipe the live list the panel is
      // already showing: the resume response only carries one when the backend
      // has a stored snapshot.
      meta: { ...timeline.meta, connected, todo: timeline.meta.todo ?? existing?.meta.todo ?? null }
    };
    const tabs = state.tabs.map(
      (tab) => tab.key === key ? {
        ...tab,
        key: nextKey,
        runtimeId,
        storedId: snapshot.stored_session_id ?? tab.storedId,
        title: timeline.meta.title || tab.title,
        draft: false
      } : tab
    );
    return {
      sessions,
      tabs,
      activeKey: state.activeKey === key ? nextKey : state.activeKey,
      workspace: state.workspace
    };
  }
  function openStored(state, storedId, title) {
    const key = `stored:${storedId}`;
    const existing = state.tabs.find((tab) => tab.storedId === storedId);
    if (existing) return { ...state, activeKey: existing.key };
    return {
      sessions: { ...state.sessions, [key]: { items: [], meta: { ...emptyMeta } } },
      tabs: [...state.tabs, { key, runtimeId: null, storedId, title, draft: false }],
      activeKey: key,
      workspace: state.workspace
    };
  }
  function focus(state, key) {
    if (!state.tabs.some((tab) => tab.key === key)) return state;
    return { ...state, activeKey: key };
  }
  function closeTab(state, key) {
    const tabs = state.tabs.filter((tab) => tab.key !== key);
    const sessions = { ...state.sessions };
    delete sessions[key];
    let activeKey = state.activeKey;
    if (activeKey === key) {
      activeKey = tabs.length ? tabs[tabs.length - 1]?.key ?? null : null;
    }
    return { sessions, tabs, activeKey, workspace: state.workspace };
  }
  function withTitleFromTimeline(state, key, timeline) {
    const title = timeline.meta.title;
    if (!title) return state;
    const tab = state.tabs.find((candidate) => candidate.key === key);
    if (!tab || tab.title === title) return state;
    return { ...state, tabs: state.tabs.map((candidate) => candidate.key === key ? { ...candidate, title } : candidate) };
  }
  function routeEvent(state, event, dedupe) {
    const isConnectionFrame = event.type === "gateway.ready" || event.type === "gateway.closed";
    if (isConnectionFrame) {
      const sessions = {};
      for (const [key2, timeline2] of Object.entries(state.sessions)) {
        sessions[key2] = reduceEvent(timeline2, event);
      }
      return { state: { ...state, sessions }, applied: true };
    }
    if (event.session_id) {
      const key2 = state.tabs.find((tab) => tab.runtimeId === event.session_id)?.key;
      if (!key2) return { state, applied: false };
      if (!dedupe.admit({ session_id: event.session_id, seq: event.seq, replayEpoch: event.replayEpoch })) {
        return { state, applied: false };
      }
      const timeline2 = timelineOf(state, key2);
      const next2 = reduceEvent(timeline2, event);
      if (next2 === timeline2) return { state, applied: false };
      const withTimelineState2 = withTimeline(state, key2, next2);
      return { state: withTitleFromTimeline(withTimelineState2, key2, next2), applied: true };
    }
    const key = state.activeKey;
    if (!key) return { state, applied: false };
    const timeline = timelineOf(state, key);
    const next = reduceEvent(timeline, event);
    if (next === timeline) return { state, applied: false };
    const withTimelineState = withTimeline(state, key, next);
    return { state: withTitleFromTimeline(withTimelineState, key, next), applied: true };
  }
  function appendUserToActive(state, text, attachments = []) {
    const key = state.activeKey;
    if (!key) return state;
    return withTimeline(state, key, appendUser(timelineOf(state, key), text, attachments));
  }
  function ackUserInActive(state, rowId) {
    const key = state.activeKey;
    if (!key) return state;
    return withTimeline(state, key, ackUser(timelineOf(state, key), rowId));
  }
  function settleActive(state, note) {
    const key = state.activeKey;
    if (!key) return state;
    return withTimeline(state, key, settleTimeline(timelineOf(state, key), note));
  }
  function replaceHistory(state, key, messages) {
    const timeline = timelineOf(state, key);
    const restored = projectHistory(messages);
    const tail = [];
    if (timeline.meta.running) {
      for (let i = timeline.items.length - 1; i >= 0; i -= 1) {
        const item = timeline.items[i];
        if (item && item.kind === "assistant" && item.streaming) {
          tail.push(...timeline.items.slice(i));
          break;
        }
      }
    }
    return withTimeline(state, key, { items: [...restored, ...tail], meta: timeline.meta });
  }
  function runningKeys(state) {
    return Object.entries(state.sessions).filter(([, timeline]) => timeline.meta.running).map(([key]) => key);
  }
  function tabLabel(tab, t) {
    if (tab.title) return tab.title;
    if (tab.storedId) return tab.storedId.slice(0, 8);
    return t.untitled;
  }
  function editTargetFor(items, itemId) {
    const index = items.findIndex((item) => item.id === itemId);
    if (index < 0) return null;
    const target = items[index];
    if (!target || target.kind !== "user") return null;
    let userTurnsRemoved = 0;
    for (let i = index; i < items.length; i += 1) {
      if (items[i]?.kind === "user") userTurnsRemoved += 1;
    }
    return {
      itemId,
      text: target.text ?? "",
      rowId: typeof target.rowId === "number" ? target.rowId : null,
      userTurnsRemoved
    };
  }
  function retitleStoredSession(tabs, storedId, title) {
    return tabs.map((tab) => tab.storedId === storedId ? { ...tab, title } : tab);
  }

  // src/core/run.ts
  var RUN_MIN_ITEMS = 2;
  function isFurniture(item) {
    switch (item.kind) {
      case "reasoning":
      case "tool":
      case "subagents":
        return true;
      case "notice":
        return Boolean(item.noticeKind) && item.tone !== "error";
      default:
        return false;
    }
  }
  function groupTranscript(items, minItems = RUN_MIN_ITEMS) {
    const segments = [];
    let run = [];
    const flush = () => {
      if (!run.length) return;
      if (run.length >= minItems) {
        segments.push({ type: "run", key: `run:${run[0].id}`, items: run });
      } else {
        for (const item of run) segments.push({ type: "item", key: item.id, item });
      }
      run = [];
    };
    for (const item of items) {
      if (isFurniture(item)) {
        run.push(item);
        continue;
      }
      flush();
      segments.push({ type: "item", key: item.id, item });
    }
    flush();
    return segments;
  }
  function runCounts(items) {
    const counts = { thoughts: 0, tools: 0, subagents: 0, notices: 0 };
    for (const item of items) {
      switch (item.kind) {
        case "reasoning":
          counts.thoughts += 1;
          break;
        case "tool":
          counts.tools += 1;
          break;
        case "subagents":
          counts.subagents += 1;
          break;
        case "notice":
          counts.notices += 1;
          break;
        default:
          break;
      }
    }
    return counts;
  }
  function endOf(item, now) {
    if (item.kind === "assistant" && item.completedAt) return item.completedAt;
    if (item.kind === "reasoning" && item.streaming) return now;
    if (item.kind === "tool") {
      if (item.status === "running") return now;
      if (typeof item.durationS === "number") return item.at + item.durationS * 1e3;
    }
    if (item.kind === "subagents" && item.finishedAt) return item.finishedAt;
    return item.at;
  }
  function runIsLive(items) {
    const last = items.at(-1);
    if (!last) return false;
    if (last.kind === "tool") return last.status === "running";
    if (last.kind === "reasoning") return last.streaming;
    if (last.kind === "subagents") return last.finishedAt === void 0;
    return false;
  }
  function runElapsedMs(items, now) {
    const first = items[0];
    const last = items.at(-1);
    if (!first || !last) return null;
    const span = endOf(last, now) - first.at;
    return Number.isFinite(span) && span > 0 ? span : null;
  }

  // src/core/workspaces.ts
  var WORKSPACE_STORAGE_PREFIX = "hermes-bubbles-workspace:";
  function workspaceStorageKey(profile) {
    return `${WORKSPACE_STORAGE_PREFIX}${profile ?? ""}`;
  }
  function readStoredWorkspace(storage, profile) {
    if (!storage) return "";
    try {
      return storage.getItem(workspaceStorageKey(profile)) ?? "";
    } catch {
      return "";
    }
  }
  function writeStoredWorkspace(storage, profile, cwd) {
    if (!storage) return;
    try {
      const key = workspaceStorageKey(profile);
      if (cwd) storage.setItem(key, cwd);
      else storage.removeItem(key);
    } catch {
    }
  }
  function abbreviateHomePath(path, home) {
    const trimmed = path.replace(/[\\/]+$/, "");
    const root = (home ?? "").replace(/[\\/]+$/, "");
    if (!root) return path;
    if (trimmed === root) return "~";
    const sep = trimmed.startsWith(`${root}/`) ? "/" : trimmed.startsWith(`${root}\\`) ? "\\" : null;
    return sep ? `~${sep}${trimmed.slice(root.length + 1)}` : path;
  }
  function baseName(path) {
    const parts = path.split(/[\\/]+/).filter(Boolean);
    return parts[parts.length - 1] ?? path;
  }
  function workspaceOptions(data) {
    if (!data) return [];
    const home = data.home ?? "";
    const seen = /* @__PURE__ */ new Set();
    const out = [];
    const push = (value, label) => {
      if (!value || seen.has(value)) return;
      seen.add(value);
      out.push({ value, label, hint: abbreviateHomePath(value, home) });
    };
    for (const project of data.projects ?? []) {
      if (project.archived) continue;
      const folders = project.folders?.length ? project.folders : project.primary_path ? [{ path: project.primary_path, label: null, is_primary: true }] : [];
      for (const folder of folders) {
        const suffix = folders.length > 1 ? ` \xB7 ${folder.label || baseName(folder.path)}` : "";
        push(folder.path, `${project.name}${suffix}`);
      }
    }
    const repos = [...data.repos ?? []].sort((a, b) => (b.last_active ?? 0) - (a.last_active ?? 0));
    for (const repo of repos) {
      push(repo.root, repo.label || baseName(repo.root));
    }
    return out;
  }
  function workspaceLabel(cwd, options, home, defaultLabel) {
    if (!cwd) return defaultLabel;
    const hit = options.find((option) => option.value === cwd);
    return hit ? hit.label : abbreviateHomePath(cwd, home);
  }
  function createCwdParams(cwd) {
    const value = (cwd ?? "").trim();
    return value ? { cwd: value, cwd_explicit: true } : {};
  }

  // src/core/projects.ts
  function projectRows(tree2) {
    const projects = [...tree2?.projects ?? []];
    const rows = projects.map((project) => ({
      project,
      preview: [...project.previewSessions ?? []],
      workspace: projectWorkspacePath(project)
    }));
    rows.sort((a, b) => {
      if (Boolean(a.project.isNoProject) !== Boolean(b.project.isNoProject)) {
        return a.project.isNoProject ? 1 : -1;
      }
      const byActive = (b.project.lastActive ?? 0) - (a.project.lastActive ?? 0);
      if (byActive !== 0) return byActive;
      return a.project.label.localeCompare(b.project.label);
    });
    return rows;
  }
  function projectWorkspacePath(project) {
    if (project.isNoProject) return "";
    const direct = (project.path ?? "").trim();
    if (direct) return direct;
    for (const repo of project.repos ?? []) {
      const path = (repo.path ?? "").trim();
      if (path) return path;
    }
    return "";
  }
  function sessionsOfProject(project) {
    if (!project) return [];
    const byId = /* @__PURE__ */ new Map();
    const push = (row) => {
      if (!row?.id) return;
      const existing = byId.get(row.id);
      if (existing) {
        byId.set(row.id, { ...existing, ...Object.fromEntries(Object.entries(row).filter(([, v]) => v != null)) });
        return;
      }
      byId.set(row.id, row);
    };
    for (const repo of project.repos ?? []) {
      for (const lane of repo.groups ?? []) {
        for (const session of lane.sessions ?? []) push(session);
      }
    }
    for (const session of project.previewSessions ?? []) push(session);
    const rows = [...byId.values()];
    rows.sort((a, b) => lastActiveOf(b) - lastActiveOf(a));
    return rows;
  }
  function lastActiveOf(row) {
    const value = row.last_active ?? row.started_at ?? 0;
    return Number.isFinite(value) ? Number(value) : 0;
  }
  function projectRemoval(project) {
    if (project.isNoProject) return "none";
    return project.isAuto ? "hide" : "delete";
  }
  function canRenameProject(project) {
    return !project.isNoProject && !project.isAuto;
  }
  var HIDDEN_PROJECTS_STORAGE_PREFIX = "hermes-bubbles-hidden-projects:";
  function hiddenProjectsKey(profile) {
    return `${HIDDEN_PROJECTS_STORAGE_PREFIX}${profile ?? ""}`;
  }
  function readHiddenProjects(storage, profile) {
    if (!storage) return [];
    try {
      const raw = storage.getItem(hiddenProjectsKey(profile));
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((id) => typeof id === "string" && id.length > 0);
    } catch {
      return [];
    }
  }
  function writeHiddenProjects(storage, profile, ids) {
    if (!storage) return;
    try {
      const key = hiddenProjectsKey(profile);
      const unique = [...new Set(ids.filter((id) => id.length > 0))];
      if (unique.length) storage.setItem(key, JSON.stringify(unique));
      else storage.removeItem(key);
    } catch {
    }
  }
  function visibleProjectRows(rows, hidden) {
    if (!hidden.length) return [...rows];
    const hiddenSet = new Set(hidden);
    return rows.filter((row) => !(row.project.isAuto === true && hiddenSet.has(row.project.id)));
  }
  function hiddenProjectCount(rows, hidden) {
    if (!hidden.length) return 0;
    const hiddenSet = new Set(hidden);
    return rows.filter((row) => row.project.isAuto === true && hiddenSet.has(row.project.id)).length;
  }

  // src/core/mutation.ts
  function newRequestId(prefix = "hb", now = Date.now(), random = Math.random()) {
    return `${prefix}-${now.toString(36)}-${Math.floor(random * 4294967296).toString(36)}`;
  }
  function mutationFence(snapshot, requestId) {
    if (!snapshot) return null;
    const revision = snapshot.runtime_revision;
    if (typeof revision !== "number" || !Number.isFinite(revision) || revision < 0) return null;
    const generation = snapshot.runtime_generation;
    return {
      request_id: requestId,
      expected_revision: revision,
      ...typeof generation === "number" && Number.isFinite(generation) && generation >= 0 ? { expected_generation: generation } : {}
    };
  }
  function fenceQuery(fence) {
    const params = new URLSearchParams({
      request_id: fence.request_id,
      expected_revision: String(fence.expected_revision)
    });
    if (fence.expected_generation !== void 0) {
      params.set("expected_generation", String(fence.expected_generation));
    }
    return params.toString();
  }
  function isBusyRefusal(error) {
    const text = error instanceof Error ? error.message : typeof error === "string" ? error : "";
    return /session_busy|storage_unavailable|runtime_draining/i.test(text);
  }

  // src/gateway/channel.ts
  var DEFAULT_REQUEST_TIMEOUT_MS = 12e4;
  var DEFAULT_HEARTBEAT_INTERVAL_MS = 15e3;
  var DEFAULT_HEARTBEAT_DEADLINE_MS = 45e3;
  var GatewayError = class extends Error {
    code;
    constructor(message, code) {
      super(message);
      this.name = "GatewayError";
      this.code = code;
    }
  };
  function isServerRequestFrame(frame) {
    return typeof frame.id === "string" && typeof frame.method === "string" && frame.method !== "event";
  }
  var Channel = class {
    options;
    transport = null;
    nextId = 0;
    pending = /* @__PURE__ */ new Map();
    heartbeatTimer = null;
    outstandingPings = /* @__PURE__ */ new Set();
    lastInboundAt = 0;
    lastPingAt = 0;
    heartbeatSeq = 0;
    closed = false;
    constructor(options = {}) {
      this.options = {
        requestTimeoutMs: options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
        heartbeatIntervalMs: options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS,
        heartbeatDeadlineMs: options.heartbeatDeadlineMs ?? DEFAULT_HEARTBEAT_DEADLINE_MS,
        ...options
      };
    }
    /** Bind a socket generation. Replaces (and rejects) any previous one. */
    bind(transport) {
      this.unbind(new GatewayError("socket replaced"));
      this.transport = transport;
      this.closed = false;
      this.lastInboundAt = Date.now();
      this.lastPingAt = 0;
    }
    unbind(reason = new GatewayError("socket closed")) {
      this.stopHeartbeat();
      this.transport = null;
      this.closed = true;
      for (const [id, call] of this.pending) {
        if (call.timer) clearTimeout(call.timer);
        this.pending.delete(id);
        call.reject(reason);
      }
    }
    get isBound() {
      return this.transport !== null && !this.closed;
    }
    request(method, params = {}) {
      const transport = this.transport;
      if (!transport) {
        return Promise.reject(new GatewayError("gateway not connected"));
      }
      this.nextId += 1;
      const id = this.nextId;
      return new Promise((resolve, reject) => {
        const timer = this.options.requestTimeoutMs > 0 ? setTimeout(() => {
          this.pending.delete(id);
          reject(new GatewayError(`request timed out: ${method}`));
        }, this.options.requestTimeoutMs) : null;
        this.pending.set(id, { resolve, reject, timer });
        try {
          transport.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
        } catch (error) {
          if (timer) clearTimeout(timer);
          this.pending.delete(id);
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
    }
    /** Feed one inbound text frame. Returns the decoded frame, or null when it was not JSON. */
    handleFrame(text) {
      let frame;
      try {
        const parsed = JSON.parse(text);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
        frame = parsed;
      } catch {
        return null;
      }
      this.lastInboundAt = Date.now();
      if (isServerRequestFrame(frame)) {
        this.deliverServerRequest(frame);
        return frame;
      }
      const rawId = frame.id;
      if (typeof rawId === "number") {
        if (this.outstandingPings.delete(`heartbeat-${rawId}`)) {
          return frame;
        }
        const call = this.pending.get(rawId);
        if (call) {
          if (call.timer) clearTimeout(call.timer);
          this.pending.delete(rawId);
          const error = frame.error;
          if (error) {
            call.reject(new GatewayError(error.message || "Hermes RPC failed", error.code));
          } else {
            call.resolve(frame.result);
          }
        }
        return frame;
      }
      if (typeof rawId === "string" && this.outstandingPings.delete(rawId)) {
        return frame;
      }
      if (frame.method === "event" && frame.params && typeof frame.params === "object") {
        const event = frame.params;
        if (typeof event.type === "string") {
          if (event.type === "gateway.ready") {
            const payload = event.payload;
            if (payload?.heartbeat) this.startHeartbeat();
            void this.advertiseCapabilities();
          }
          this.options.onEvent?.(event);
        }
      }
      return frame;
    }
    /**
     * Tell the backend this client answers server→client requests. Without it the
     * backend treats us as a build older than server requests and fails every
     * approval / clarify immediately instead of waiting for the user.
     */
    async advertiseCapabilities() {
      try {
        await this.request("client.capabilities", { server_requests: true });
      } catch {
      }
    }
    deliverServerRequest(frame) {
      const id = frame.id;
      const method = frame.method;
      const params = frame.params && typeof frame.params === "object" ? frame.params : {};
      let answered = false;
      const respond = (result) => {
        if (answered) return;
        answered = true;
        this.sendRaw({ jsonrpc: "2.0", id, result });
      };
      const fail = (code, message) => {
        if (answered) return;
        answered = true;
        this.sendRaw({ jsonrpc: "2.0", id, error: { code, message } });
      };
      const handled = this.options.onServerRequest?.({ id, method, params, respond, fail });
      if (handled === false || !handled) {
        this.options.onUnhandledRequest?.({ id, method });
        fail(-32601, `client does not handle ${method}`);
      }
    }
    sendRaw(frame) {
      try {
        this.transport?.send(JSON.stringify(frame));
      } catch {
      }
    }
    startHeartbeat() {
      this.stopHeartbeat();
      if (this.options.heartbeatIntervalMs <= 0) return;
      this.lastInboundAt = Date.now();
      this.heartbeatTimer = setInterval(() => {
        if (!this.transport) return;
        const now = Date.now();
        if (this.lastPingAt > this.lastInboundAt && now - this.lastInboundAt >= this.options.heartbeatDeadlineMs) {
          this.stopHeartbeat();
          this.options.onHeartbeatFailure?.(new Error("WebSocket heartbeat timed out"));
          return;
        }
        this.heartbeatSeq += 1;
        const id = `heartbeat-${this.heartbeatSeq}`;
        this.outstandingPings.add(id);
        while (this.outstandingPings.size > 32) {
          const oldest = this.outstandingPings.values().next().value;
          if (oldest === void 0) break;
          this.outstandingPings.delete(oldest);
        }
        this.lastPingAt = now;
        try {
          this.transport.send(JSON.stringify({ jsonrpc: "2.0", id, method: "gateway.ping", params: {} }));
        } catch (error) {
          this.options.onHeartbeatFailure?.(error instanceof Error ? error : new Error(String(error)));
        }
      }, this.options.heartbeatIntervalMs);
    }
    stopHeartbeat() {
      this.outstandingPings.clear();
      if (this.heartbeatTimer !== null) {
        clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = null;
      }
    }
  };

  // src/gateway/client.ts
  var BACKOFF_MS = [500, 1e3, 2e3, 4e3, 8e3, 15e3];
  var GatewayClient = class {
    options;
    channel;
    socket = null;
    state = "idle";
    attempt = 0;
    reconnectTimer = null;
    disposed = false;
    everConnected = false;
    /** Short machine tag for the last terminal failure: "auth" | "scope" | "". */
    failureKind = "";
    /** Human-facing text for that failure. */
    failureMessage = "";
    /**
     * Callers that need a usable socket (any RPC) park here until one exists.
     * Without this, `connect(); openSession();` races: the RPC is sent before the
     * URL even resolves, and the caller sees "gateway not connected" on a socket
     * that comes up milliseconds later.
     */
    openWaiters = [];
    /** Epoch reported by the backend, exposed so the dedupe gate can key on it. */
    epoch = "";
    constructor(options) {
      this.options = options;
      this.channel = new Channel({
        onEvent: (event) => {
          if (event.type === "gateway.ready") {
            const payload = event.payload;
            if (payload?.replay_epoch) this.epoch = payload.replay_epoch;
          }
          this.options.onEvent(event);
        },
        onServerRequest: options.onServerRequest,
        onUnhandledRequest: options.onUnhandledRequest,
        onHeartbeatFailure: () => {
          this.dropAndReconnect(this.messages().heartbeatTimeout);
        }
      });
    }
    getState() {
      return this.state;
    }
    /** The catalog in the dashboard's language; English when the caller did not supply one. */
    messages() {
      return this.options.messages?.() ?? messagesFor("en");
    }
    setState(state, detail) {
      this.state = state;
      this.options.onState?.(state, detail);
    }
    async connect() {
      if (this.disposed) return;
      if (this.state === "open" || this.state === "connecting") return;
      this.setState("connecting");
      let url;
      try {
        url = await this.options.urlProvider();
      } catch (error) {
        this.setState("error", error instanceof Error ? error.message : String(error));
        this.scheduleReconnect();
        return;
      }
      const factory = this.options.socketFactory ?? ((u) => new WebSocket(u));
      let socket;
      try {
        socket = factory(url);
      } catch (error) {
        this.setState("error", error instanceof Error ? error.message : String(error));
        this.scheduleReconnect();
        return;
      }
      this.socket = socket;
      socket.onopen = () => {
        if (this.socket !== socket) return;
        this.attempt = 0;
        this.setState("open");
        const transport = {
          send: (text) => {
            if (this.socket === socket && socket.readyState === 1) socket.send(text);
          },
          close: () => socket.close()
        };
        this.channel.bind(transport);
        this.settleOpenWaiters(null);
        if (this.everConnected) this.options.onReconnected?.();
        this.everConnected = true;
      };
      socket.onmessage = (message) => {
        if (this.socket !== socket) return;
        const data = message.data;
        if (typeof data === "string") {
          this.channel.handleFrame(data);
        } else if (data instanceof ArrayBuffer) {
          this.channel.handleFrame(new TextDecoder().decode(data));
        }
      };
      socket.onerror = () => {
        if (this.socket !== socket) return;
        this.setState("error", "socket error");
      };
      socket.onclose = (event) => {
        if (this.socket !== socket) return;
        this.socket = null;
        this.channel.unbind();
        if (event.code === 4401 || event.code === 4403) {
          this.failureKind = event.code === 4401 ? "auth" : "scope";
          this.failureMessage = event.code === 4401 ? this.messages().connectUnauthorized : this.messages().connectChatDisabled;
          this.settleOpenWaiters(new Error(this.failureMessage));
          this.setState("error", this.failureMessage);
          return;
        }
        this.dropAndReconnect();
      };
    }
    dropAndReconnect(detail) {
      const socket = this.socket;
      this.socket = null;
      this.channel.unbind();
      if (socket && socket.readyState <= 1) {
        try {
          socket.close();
        } catch {
        }
      }
      this.setState("closed", detail);
      this.scheduleReconnect();
    }
    scheduleReconnect() {
      if (this.disposed || this.reconnectTimer !== null) return;
      const delay = BACKOFF_MS[Math.min(this.attempt, BACKOFF_MS.length - 1)] ?? 15e3;
      this.attempt += 1;
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        void this.connect();
      }, delay);
    }
    request(method, params = {}) {
      return this.channel.request(method, params);
    }
    /**
     * Resolve once a socket is usable, starting one if needed.
     *
     * Callers should await this instead of `connect()` when they are about to send
     * an RPC. `connect()` alone is fire-and-forget: it returns before the URL
     * provider resolves, so an immediate `request()` fails on a socket that is
     * about to be fine.
     */
    async ensureOpen() {
      if (this.disposed) throw new Error("gateway disposed");
      if (this.state === "open" && this.channel.isBound) return;
      if (this.state === "error" && (this.failureKind === "auth" || this.failureKind === "scope")) {
        throw new Error(this.failureMessage || "gateway unavailable");
      }
      const waiter = new Promise((resolve, reject) => {
        this.openWaiters.push({ resolve, reject });
      });
      void this.connect();
      return waiter;
    }
    settleOpenWaiters(error) {
      const waiters = this.openWaiters;
      this.openWaiters = [];
      for (const waiter of waiters) {
        if (error) waiter.reject(error);
        else waiter.resolve();
      }
    }
    dispose() {
      this.disposed = true;
      this.settleOpenWaiters(new Error("gateway disposed"));
      if (this.reconnectTimer !== null) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
      this.channel.unbind();
      const socket = this.socket;
      this.socket = null;
      try {
        socket?.close();
      } catch {
      }
      this.setState("idle");
    }
  };

  // src/app/controller.ts
  var HANDLED_REQUESTS = /* @__PURE__ */ new Set(["approval", "clarify"]);
  var ChatController = class {
    client;
    dedupe = new EventDedupe();
    listeners = /* @__PURE__ */ new Set();
    state = emptyMultiState;
    connection = "idle";
    detail = "";
    resyncing = false;
    cardSink = null;
    /**
     * Requests that arrived while the page was unmounted.
     *
     * The backend blocks on an answer (clarify waits 3600s), so refusing a request
     * that arrives mid-navigation would break the turn. Park it and replay it when
     * the page mounts again.
     */
    pendingCards = [];
    /**
     * Requests the backend withdrew while the page was unmounted.
     *
     * Same parking rule as `pendingCards`: the page subscribes on mount, so an id
     * that was cancelled in between must still reach it, or a card replayed from
     * `pendingCards` would outlive the request it answers.
     */
    pendingWithdrawals = [];
    /** Desktop-notification sink (see `setNoticeSink`). */
    noticeSink = null;
    /** Page sink for withdrawn cards (see `setWithdrawalSink`). */
    withdrawalSink = null;
    /** Auth-aware REST transport, injected by the page (SDK.fetchJSON). */
    http = null;
    /** Storage sink for workspace picks; absent means "this document only". */
    persistWorkspace = null;
    setHttpFetcher(fn) {
      this.http = fn;
    }
    /** Locale for controller-emitted strings (notices, errors). The page keeps it current. */
    locale = normalizeLocale(null);
    setLocale(locale) {
      this.locale = locale;
    }
    constructor(options) {
      this.cardSink = options.onServerRequest ?? null;
      this.persistWorkspace = options.persistWorkspace ?? null;
      this.state = { ...emptyMultiState, workspace: (options.initialWorkspace ?? "").trim() };
      this.client = new GatewayClient({
        urlProvider: options.urlProvider,
        socketFactory: options.socketFactory,
        // The transport renders its own failure sentences, so it reads the catalog
        // in whatever language the page is currently in.
        messages: () => messagesFor(this.locale),
        onState: (state, detail) => {
          this.connection = state;
          this.detail = detail ?? "";
          if (state !== "open") {
            const sessions = {};
            for (const [key, timeline] of Object.entries(this.state.sessions)) {
              sessions[key] = { items: timeline.items, meta: { ...timeline.meta, connected: false } };
            }
            this.state = { ...this.state, sessions };
          }
          this.emit();
        },
        onEvent: (event) => this.handleEvent(event),
        onServerRequest: (request) => this.handleServerRequest(request)
      });
    }
    // ── React interop ────────────────────────────────────────────────────────
    subscribe = (listener) => {
      this.listeners.add(listener);
      return () => this.listeners.delete(listener);
    };
    getSnapshot = () => this.state;
    getConnection = () => ({
      state: this.connection,
      detail: this.detail
    });
    /** The focused tab's timeline — what the transcript renders. */
    getActiveTimeline = () => activeTimeline(this.state);
    emit() {
      for (const listener of this.listeners) listener();
    }
    setState(next) {
      this.state = next;
      this.emit();
    }
    /** Cards parked while the page was unmounted, for the remounting page. */
    takeParkedCards() {
      const parked = this.pendingCards;
      this.pendingCards = [];
      return parked;
    }
    /** Withdrawals parked while the page was unmounted (see `pendingWithdrawals`). */
    takeParkedWithdrawals() {
      const parked = this.pendingWithdrawals;
      this.pendingWithdrawals = [];
      return parked;
    }
    setServerRequestSink(sink) {
      this.cardSink = sink;
    }
    /**
     * Page sink for "this card is withdrawn".
     *
     * Cleared with the card sink on unmount and replayed from
     * `pendingWithdrawals` on the next mount, so the two always move together.
     */
    setWithdrawalSink(sink) {
      this.withdrawalSink = sink;
    }
    /** Desktop-notification sink. Set by the page; absent means "notify nobody". */
    setNoticeSink(sink) {
      this.noticeSink = sink;
    }
    /**
     * Every RPC goes through here so the socket is guaranteed before the frame is
     * sent.
     *
     * Calling `client.request` directly is how the page shipped a
     * "gateway not connected" banner: the call raced the async connect and failed
     * on a socket that came up milliseconds later. Routing everything through one
     * guarded helper makes that impossible to reintroduce by accident.
     */
    /**
     * An auth-aware REST call.
     *
     * Uses the injected `fetchJSON` (the SDK's, which carries the session token),
     * never a bare `fetch` — see AGENTS.md: a bare fetch 401s against this server.
     */
    async fetchJSON(path, init) {
      if (!this.http) throw new Error("REST transport unavailable");
      return this.http(path, {
        method: init.method,
        headers: { "Content-Type": "application/json" },
        body: init.body === void 0 ? void 0 : JSON.stringify(init.body)
      });
    }
    async rpc(method, params = {}) {
      await this.client.ensureOpen();
      return this.client.request(method, params);
    }
    // ── lifecycle ────────────────────────────────────────────────────────────
    dispose() {
      this.client.dispose();
      this.listeners.clear();
    }
    /** Connect (if needed) and make sure there is at least one open tab. */
    async start() {
      await this.client.ensureOpen();
      if (!this.state.tabs.length) {
        this.setState(openDraft(this.state));
        await this.ensureSession();
      }
    }
    /** A fresh chat tab. */
    async newSession() {
      this.setState(openDraft(this.state));
      await this.ensureSession();
    }
    // ── workspace ────────────────────────────────────────────────────────────
    /**
     * The directory the next NEW chat starts in ("" = the gateway's default).
     *
     * Already-created sessions keep the cwd the backend stamped on them: changing
     * this never moves a running conversation.
     */
    getWorkspace() {
      return this.state.workspace;
    }
    /** Pick the workspace for the next new chat, and remember it. */
    setWorkspace(cwd) {
      const next = (cwd ?? "").trim();
      if (next === this.state.workspace) return;
      this.setState(withWorkspace(this.state, next));
      this.persistWorkspace?.(next);
    }
    /**
     * The user picked a directory in the workspace panel.
     *
     * `setWorkspace` alone is not enough: the page mints a session on load, in
     * whatever directory was current then, and the backend stamps `cwd` on the row
     * at `session.create` — a session can never be moved afterwards. So picking a
     * repo and then typing used to deliver the message into the page-load session,
     * i.e. straight back into the default directory. When the open tab has not been
     * spoken into, replace it: there is nothing in it to lose.
     *
     * The pick also gets spent by the next create (see `ensureSession`), which is
     * what makes a new chat you did not aim anywhere land in the default directory.
     */
    async pickWorkspace(cwd) {
      const next = (cwd ?? "").trim();
      if (next === this.state.workspace) return;
      this.setWorkspace(next);
      if (!next) return;
      const key = this.state.activeKey;
      const tab = key ? this.state.tabs.find((candidate) => candidate.key === key) : void 0;
      if (!key || !tab) return;
      const timeline = timelineOf(this.state, key);
      if (timeline.items.length > 0 || timeline.meta.running) return;
      this.setState(closeTab(this.state, key));
      await this.newSession();
    }
    /**
     * Projects + discovered repos a fresh chat may start in.
     *
     * REST rather than RPC: `/api/chat/workspaces` is the same endpoint the
     * dashboard's own `/chat` picker uses, so both surfaces offer one list. The
     * payload is profile-scoped server-side; `scan` asks the host to re-walk its
     * discovery roots first.
     */
    async listWorkspaces(scan = false) {
      const path = scan ? "/api/chat/workspaces?scan=1" : "/api/chat/workspaces";
      const payload = await this.fetchJSON(path, { method: "GET" });
      return payload ?? {};
    }
    /**
     * Git branch + working-tree state for one directory.
     *
     * This plugin's own host route (`plugin_api.py::/git`) rather than RPC: the
     * gateway answers only a branch (`config.get{key:"project"}`) and probes the
     * machine the gateway runs on. `null` means "render no badge" — not a repo, no
     * git on PATH, or an older installed copy of the plugin with no `/git` route.
     */
    async gitInfo(dir) {
      const path = (dir ?? "").trim();
      if (!path) return null;
      let payload;
      try {
        payload = await this.fetchJSON(
          `/api/plugins/hermes-bubbles/git?path=${encodeURIComponent(path)}`,
          { method: "GET" }
        );
      } catch {
        return null;
      }
      if (!payload || payload.ok === false || !payload.is_repo) return null;
      return parseGitStatus(payload.status ?? "", payload.root ?? "", payload.truncated === true);
    }
    // ── projects ─────────────────────────────────────────────────────────────
    /**
     * Projects + their recent sessions, from the tree the desktop sidebar uses.
     *
     * `hydrate` is off in this call and the preview is deliberately tiny: the
     * backend resolves a git branch per distinct session cwd, and asking for the
     * whole tree on a Windows checkout is seconds, not milliseconds. The drill-in
     * (`projectSessions`) is what pays for the rest, one project at a time.
     */
    async projectsTree(previewLimit = 2, sessionLimit = 2e3) {
      const result = await this.rpc("projects.tree", {
        preview_limit: previewLimit,
        session_limit: sessionLimit
      });
      return result ?? {};
    }
    /** One project's lanes, fully hydrated (every session, not just the preview). */
    async projectSessions(projectId, sessionLimit = 300) {
      const result = await this.rpc("projects.project_sessions", {
        project_id: projectId,
        session_limit: sessionLimit
      });
      return result?.project ?? null;
    }
    /**
     * Rename a project (`projects.update {id, name}`).
     *
     * Only an explicit project has a `projects.db` row to patch — an auto node's
     * id is a repo path and the backend answers `5062`. The reply is the refreshed
     * `ProjectInfo`, not the tree, so the caller re-reads the tree to pick up the
     * new label.
     */
    async renameProject(projectId, name) {
      await this.rpc("projects.update", { id: projectId, name });
    }
    /**
     * Delete an explicit project (`projects.delete {id}`).
     *
     * Deletes the `projects` row and its folders (cascade); the sessions and the
     * directory itself stay on disk. Answers the whole project list, not the tree.
     */
    async deleteProject(projectId) {
      await this.rpc("projects.delete", { id: projectId });
    }
    /**
     * Attach to a stored session.
     *
     * `session.resume` reuses the live session when there is one, so reopening a
     * tab you already have open is cheap; the store dedupes the tab either way.
     */
    async openStoredSession(storedId, title) {
      await this.client.ensureOpen();
      this.setState(openStored(this.state, storedId, title));
      const key = `stored:${storedId}`;
      try {
        const snapshot = await this.client.request("session.resume", {
          session_id: storedId,
          omit_messages: false
        });
        this.setState(bindSnapshot(this.state, key, snapshot, { connected: this.connection === "open" }));
      } catch (error) {
        this.setState(this.markError(key, error));
      }
    }
    focusSession(key) {
      this.setState(focus(this.state, key));
    }
    /**
     * Focus whichever tab owns this runtime session, if any.
     *
     * Used by the notification click: a request is scoped to one session, and the
     * click is the human saying "show me the one that needs me". Resolved at click
     * time rather than at notification time because the tab may have been closed
     * and reopened (a new key) in between.
     */
    focusSessionId(sessionId) {
      const key = sessionId ? this.state.tabs.find((tab) => tab.runtimeId === sessionId)?.key : void 0;
      if (!key) return false;
      this.focusSession(key);
      return true;
    }
    closeSession(key) {
      this.setState(closeTab(this.state, key));
    }
    /** Stored sessions for the sidebar. */
    async listSessions(limit = 40) {
      const result = await this.rpc("session.list", { limit });
      return result.sessions ?? [];
    }
    /**
     * Read a stored session's transcript as a context block.
     *
     * Goes through REST (`GET /api/sessions/{id}/messages`), NOT `session.history`:
     * that RPC is live-session-only (`_with_session` answers 4001 for a stored id)
     * and `session.resume` would make the row the backend's active session just
     * because the user pointed at it. The dashboard's own router reads the store
     * read-only, which is exactly the semantics wanted here.
     */
    async contextForStoredSession(storedId, title = "") {
      const payload = await this.fetchJSON(
        `/api/sessions/${encodeURIComponent(storedId)}/messages?limit=200&order=latest`,
        { method: "GET" }
      );
      return sessionContextBlock({ id: storedId, title }, payload?.messages ?? [], {
        locale: this.locale
      });
    }
    /**
     * Give the focused tab a backend session if it does not have one.
     *
     * A draft becomes real here rather than at page load, so opening a second tab
     * does not mint a session the user never speaks into.
     */
    async ensureSession() {
      const key = this.state.activeKey;
      if (!key) return null;
      const tab = this.state.tabs.find((t) => t.key === key);
      if (!tab) return null;
      if (tab.runtimeId) return tab.runtimeId;
      const method = tab.storedId ? "session.resume" : "session.create";
      const workspace = this.state.workspace;
      const params = tab.storedId ? { session_id: tab.storedId, omit_messages: false } : { source: "desktop", ...createCwdParams(workspace) };
      const snapshot = await this.client.request(method, params);
      this.setState(bindSnapshot(this.state, key, snapshot, { connected: this.connection === "open" }));
      if (!tab.storedId && workspace) this.setWorkspace("");
      return snapshot.session_id ?? null;
    }
    markError(key, error) {
      const message = error instanceof Error ? error.message : String(error);
      const timeline = timelineOf(this.state, key);
      const items = [
        ...timeline.items,
        { kind: "notice", id: `err-${Date.now()}`, at: Date.now(), text: message, tone: "error" }
      ];
      return { ...this.state, sessions: { ...this.state.sessions, [key]: { items, meta: timeline.meta } } };
    }
    // ── sending ──────────────────────────────────────────────────────────────
    /**
     * Send a turn.
     *
     * A leading `/` is a command, not a message: it goes through
     * `command.dispatch` and the reply's `type` decides what happens next.
     */
    async send(text, attachments = []) {
      const trimmed = text.trim();
      if (!trimmed && !attachments.length) return;
      if (!this.state.activeKey) await this.newSession();
      const command = trimmed ? parseCommandInput(trimmed) : null;
      if (command) {
        await this.dispatchCommand(command.name, command.arg);
        return;
      }
      const refs = attachments.map((item) => item.ref).filter((ref) => Boolean(ref));
      const modelText = refs.length ? `${trimmed}

${refs.join("\n")}`.trim() : trimmed;
      await this.submitMessage(modelText, trimmed, attachments);
    }
    /**
     * Run a slash command and apply its directive.
     *
     * The dispatch reply is a small instruction language (see the contract): most
     * shapes either show text or turn into a normal message. Anything unrecognised
     * becomes a visible notice rather than a silent no-op.
     */
    async dispatchCommand(name, arg) {
      const runtimeId = this.state.tabs.find((t) => t.key === this.state.activeKey)?.runtimeId ?? null;
      let reply;
      try {
        reply = await this.client.request("command.dispatch", {
          name,
          arg: arg || void 0,
          session_id: runtimeId ?? void 0
        });
      } catch (error) {
        this.notice(error instanceof Error ? error.message : String(error), "error");
        return null;
      }
      const directive = parseDispatch(reply);
      if (!directive) {
        this.notice(messagesFor(this.locale).slashUnrecognized(name), "error");
        return null;
      }
      switch (directive.type) {
        case "alias":
          return this.dispatchCommand((directive.target ?? "").replace(/^\//, ""), arg);
        case "exec":
        case "plugin":
          this.notice(directive.output || messagesFor(this.locale).slashDone(name));
          return directive;
        case "prefill":
          if (directive.notice) this.notice(directive.notice);
          return directive;
        case "send":
        case "skill":
          await this.submitMessage(directive.message ?? "", directive.display || directive.message || "");
          if (directive.notice) this.notice(directive.notice);
          return directive;
        default:
          this.notice(
            messagesFor(this.locale).slashTypeUnsupported(name, String(directive.type)),
            "error"
          );
          return directive;
      }
    }
    /**
     * Submit a resolved message, with the text shown to the user when it differs.
     *
     * Sending while a turn is live is deliberately allowed: the gateway's busy path
     * decides whether the text queues, steers (injected into the running turn's
     * next tool result) or redirects, and reports which in `status`. The composer
     * used to disable itself instead, which is not how Hermes behaves elsewhere —
     * mid-turn input is a correction, not an error.
     */
    async submitMessage(message, display, attachments = []) {
      if (!message.trim() && !attachments.length) return;
      const runtimeId = await this.ensureSession();
      if (!runtimeId) throw new Error(messagesFor(this.locale).sessionNotReady);
      const wasRunning = activeTimeline(this.state).meta.running;
      this.setState(appendUserToActive(this.state, display || message, attachments.slice()));
      const result = await this.client.request("prompt.submit", {
        session_id: runtimeId,
        text: message
      });
      this.setState(ackUserInActive(this.state, result?.user_row_id));
      if (wasRunning) {
        const status = result?.status;
        const t = messagesFor(this.locale);
        if (status === "steered") this.notice(t.steered, "info");
        else if (status === "redirected") this.notice(t.redirected, "info");
        else if (status === "queued") this.notice(t.queued, "info");
      }
    }
    // ── per-message actions ──────────────────────────────────────────────────
    /**
     * Replace the focused turn's reply with a fresh one.
     *
     * The backend's own retry shape: a plain `session.undo` rewinds the last turn
     * WITHOUT resending it, so the caller re-submits to get a new reply. Two
     * differences from the initial send matter here:
     *
     *   - `session.undo` is destructive, so a failure is surfaced rather than
     *     swallowed; the transcript is untouched when it throws.
     *   - the re-submitted text is the ORIGINAL user text, which is what makes
     *     this a regenerate rather than a new message.
     */
    async regenerateAssistant(itemId) {
      const key = this.state.activeKey;
      if (!key) return;
      const runtimeId = await this.ensureSession();
      if (!runtimeId) throw new Error(messagesFor(this.locale).sessionNotReady);
      const timeline = timelineOf(this.state, key);
      const index = timeline.items.findIndex((entry) => entry.id === itemId);
      if (index < 0) throw new Error(messagesFor(this.locale).replyNotFound);
      let prompt = null;
      for (let i = index - 1; i >= 0; i -= 1) {
        const entry = timeline.items[i];
        if (entry && entry.kind === "user") {
          prompt = entry.text;
          break;
        }
      }
      if (prompt === null) throw new Error(messagesFor(this.locale).userMessageNotFound);
      const kept = timeline.items.slice(0, index);
      this.setState({
        ...this.state,
        sessions: {
          ...this.state.sessions,
          [key]: { items: kept, meta: { ...timeline.meta, running: true, status: "" } }
        }
      });
      try {
        await this.client.request("session.undo", { session_id: runtimeId, intent: "retry" });
      } catch (error) {
        this.setState({
          ...this.state,
          sessions: { ...this.state.sessions, [key]: { items: timeline.items, meta: timeline.meta } }
        });
        throw error;
      }
      const result = await this.client.request("prompt.submit", {
        session_id: runtimeId,
        text: prompt
      });
      this.setState(ackUserInActive(this.state, result?.user_row_id));
    }
    /**
     * Fork the session into a new stored child, opened as a second tab.
     *
     * `count` and the idempotency key exist so a retried call returns the SAME
     * child instead of forking twice — the backend documents that as the desktop
     * client's contract, and a lost response is exactly when this is called again.
     */
    async branchSession(itemId) {
      const key = this.state.activeKey;
      const tab = this.state.tabs.find((t) => t.key === key);
      if (!tab) return;
      const runtimeId = tab.runtimeId;
      if (!runtimeId) {
        if (!tab.storedId) throw new Error(messagesFor(this.locale).sessionNotReady);
        const forked2 = await this.rpc(
          "session.branch_stored",
          { parent_session_id: tab.storedId }
        );
        await this.openStoredSession(forked2.stored_session_id, forked2.title || tab.title);
        return;
      }
      const items = timelineOf(this.state, key).items;
      const index = itemId ? items.findIndex((entry) => entry.id === itemId) : -1;
      let count;
      if (index >= 0) {
        let rows = 0;
        for (let i = 0; i <= index; i += 1) {
          const entry = items[i];
          if (entry && "rowId" in entry && typeof entry.rowId === "number") rows += 1;
        }
        if (rows > 0) count = rows;
      }
      const forked = await this.rpc("session.branch", {
        session_id: runtimeId,
        count,
        idempotency_key: `hb-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
      });
      await this.openStoredSession(forked.stored_session_id, forked.title || tab.title);
    }
    // ── stored-session management ────────────────────────────────────────────
    /**
     * The optimistic-concurrency fence a session mutation needs on 0.22.5+.
     *
     * Read fresh per attempt: a revision that changed since the sidebar rendered is
     * exactly what the fence exists to catch, and reusing a stale one just gets
     * refused. `null` when the backend has no snapshot route (older build), so the
     * request goes out the way it always did.
     */
    async mutationFence(storedId) {
      try {
        const snapshot = await this.fetchJSON(
          `/api/sessions/${encodeURIComponent(storedId)}/mutation-snapshot`,
          { method: "GET" }
        );
        return mutationFence(snapshot ?? null, newRequestId());
      } catch {
        return null;
      }
    }
    /**
     * DELETE / PATCH, retried while the store still reports the row busy.
     *
     * `session.close` returns before the gateway has finished retiring the session,
     * so a mutation issued straight after it is answered `409 session_busy`
     * (`MUTATION_GUARD_REFUSALS`). Measured on 0.22.5, that window outlives a few
     * hundred milliseconds: retries at 200ms still lost, ~1.5s won. The fence also
     * has to be re-read per attempt, because the revision moves as the close
     * settles.
     *
     * Four attempts (~2s total) is a settle delay a human will not notice on a
     * delete; a longer one would need a progress indicator to be honest.
     */
    async mutateStoredSession(storedId, init) {
      const RETRY_DELAYS_MS = [200, 500, 1200];
      const path = `/api/sessions/${encodeURIComponent(storedId)}`;
      let lastError = null;
      for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
        if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS_MS[attempt - 1]));
        const fence = await this.mutationFence(storedId);
        const url = init.method === "DELETE" && fence ? `${path}?${fenceQuery(fence)}` : path;
        const body = init.method === "PATCH" ? { ...init.body ?? {}, ...fence ?? {} } : void 0;
        try {
          return await this.fetchJSON(url, { method: init.method, body });
        } catch (error) {
          lastError = error;
          if (!isBusyRefusal(error)) throw error;
        }
      }
      throw lastError;
    }
    /**
     * Delete a stored session.
     *
     * Goes through REST (`DELETE /api/sessions/{id}`), NOT `session.delete`: the
     * RPC refuses with 4023 while a session is active anywhere, and a session
     * resumed for any reason stays active for a moment. REST works on the stored
     * row regardless and is what the desktop app uses for the same verb.
     *
     * Any tab holding this session is closed first so no tab is left pointing at
     * a deleted row.
     */
    async deleteStoredSession(storedId) {
      const openTab = this.state.tabs.find((tab) => tab.storedId === storedId);
      if (openTab?.runtimeId) {
        try {
          await this.client.request("session.close", { session_id: openTab.runtimeId });
        } catch {
        }
      }
      if (openTab) this.closeSession(openTab.key);
      await this.mutateStoredSession(storedId, { method: "DELETE" });
      const still = await this.listSessions(200);
      if (still.some((row) => row.id === storedId)) {
        throw new Error(messagesFor(this.locale).deleteRefused);
      }
    }
    /**
     * Rename a stored session.
     *
     * REST `PATCH /api/sessions/{id}` — the same call the desktop app makes.
     * `session.title` was the obvious-looking choice and it "works", but only for
     * a LIVE session: reaching a runtime id means resuming the row, which makes it
     * active and then blocks a later delete with 4023. PATCH addresses the stored
     * row directly, so renaming has no side effect on liveness.
     */
    async renameStoredSession(storedId, title) {
      const next = title.trim();
      if (!next) throw new Error(messagesFor(this.locale).titleRequired);
      const result = await this.mutateStoredSession(storedId, {
        method: "PATCH",
        body: { title: next }
      });
      const finalTitle = result?.title || next;
      this.setState({ ...this.state, tabs: retitleStoredSession(this.state.tabs, storedId, finalTitle) });
      return finalTitle;
    }
    /**
     * Edit an already-sent message and continue from there.
     *
     * The desktop app's shape: interrupt whatever is running, then submit the
     * corrected text with `truncate_before_row_id` + `confirm_truncate` so the
     * backend drops that turn and everything after it. A target without a durable
     * row id is refused rather than sent as a cut the gateway would reject.
     */
    async editAndResend(itemId, text) {
      const key = this.state.activeKey;
      if (!key) return;
      const next = text.trim();
      if (!next) return;
      const runtimeId = await this.ensureSession();
      if (!runtimeId) throw new Error(messagesFor(this.locale).sessionNotReady);
      const timeline = timelineOf(this.state, key);
      const target = editTargetFor(
        timeline.items,
        itemId
      );
      if (!target) throw new Error(messagesFor(this.locale).editUnavailable);
      if (target.rowId === null) throw new Error(messagesFor(this.locale).editNoAnchor);
      if (timeline.meta.running) {
        try {
          await this.client.request("session.interrupt", { session_id: runtimeId });
        } catch {
        }
      }
      const cutIndex = timeline.items.findIndex((item) => item.id === itemId);
      const kept = timeline.items.slice(0, cutIndex);
      this.setState({
        ...this.state,
        sessions: {
          ...this.state.sessions,
          [key]: { items: kept, meta: { ...timeline.meta, running: true, status: "" } }
        }
      });
      this.setState(appendUserToActive(this.state, next));
      try {
        const result = await this.client.request("prompt.submit", {
          session_id: runtimeId,
          text: next,
          truncate_before_row_id: target.rowId,
          confirm_truncate: true,
          // Only meaningful when the cut empties the transcript; the gateway
          // ignores it for a non-empty prefix.
          ...kept.length === 0 ? { confirm_empty_truncate: true } : {},
          // A cut of more than one user turn is a deep truncate on newer gateways.
          ...target.userTurnsRemoved > 1 ? { confirm_deep_truncate: true } : {}
        });
        this.setState(ackUserInActive(this.state, result?.user_row_id));
      } catch (error) {
        this.setState({
          ...this.state,
          sessions: { ...this.state.sessions, [key]: { items: timeline.items, meta: timeline.meta } }
        });
        throw error;
      }
    }
    /** Append a local notice line to the focused transcript. */
    notice(text, tone = "info") {
      const key = this.state.activeKey;
      if (!key) return;
      const timeline = timelineOf(this.state, key);
      const items = [
        ...timeline.items,
        { kind: "notice", id: `n-${Date.now()}-${timeline.items.length}`, at: Date.now(), text, tone }
      ];
      this.setState({ ...this.state, sessions: { ...this.state.sessions, [key]: { items, meta: timeline.meta } } });
    }
    async interrupt() {
      const runtimeId = this.state.tabs.find((t) => t.key === this.state.activeKey)?.runtimeId;
      if (!runtimeId) return;
      try {
        await this.client.request("session.interrupt", { session_id: runtimeId });
      } catch {
      }
      this.setState(settleActive(this.state));
    }
    // ── model & reasoning ────────────────────────────────────────────────────
    /** Provider/model inventory for the picker. */
    async listModels() {
      const runtimeId = this.state.tabs.find((t) => t.key === this.state.activeKey)?.runtimeId;
      const result = await this.rpc("model.options", runtimeId ? { session_id: runtimeId } : {});
      return { providers: result.providers ?? [], model: result.model ?? "", provider: result.provider ?? "" };
    }
    /**
     * Switch the focused session's model.
     *
     * The value carries a `--provider` suffix because the backend parses the pair
     * out of one string. ` --session` keeps a pick scoped to this tab instead of
     * rewriting the profile default.
     */
    async setModel(model, provider, options = {}) {
      const runtimeId = this.state.tabs.find((t) => t.key === this.state.activeKey)?.runtimeId;
      const scope = options.sessionOnly === false ? "" : " --session";
      const result = await this.rpc("config.set", {
        session_id: runtimeId ?? void 0,
        key: "model",
        value: `${model} --provider ${provider}${scope}`,
        ...options.confirmExpensive ? { confirm_expensive_model: true } : {}
      });
      const confirmRequired = result?.confirm_required === true;
      if (!confirmRequired && result?.warning) this.notice(result.warning);
      return {
        deferred: result?.deferred,
        confirmRequired,
        confirmMessage: result?.confirm_message
      };
    }
    /** Set the reasoning level for the focused session. */
    async setReasoning(level) {
      const runtimeId = this.state.tabs.find((t) => t.key === this.state.activeKey)?.runtimeId;
      await this.rpc("config.set", {
        session_id: runtimeId ?? void 0,
        key: "reasoning",
        value: level,
        scope: "session"
      });
    }
    /**
     * Read the current dangerous-command approval mode.
     *
     * `config.get` reports `{value}` for `approvals.mode`; the value is `manual`
     * (ask before every guarded command), `smart` (only ask for the risky ones)
     * or `off` (never ask). This is a **profile-scoped** setting, not a session
     * one: the backend has no per-conversation approval override, so switching
     * here changes it for every conversation on this profile — the UI says so.
     */
    async getApprovalMode() {
      const result = await this.rpc("config.get", { key: "approvals.mode" });
      return (result?.value ?? "").trim();
    }
    /** Persist the approval mode (`approvals.mode`) for this profile. */
    async setApprovalMode(mode) {
      await this.rpc("config.set", { key: "approvals.mode", value: mode });
    }
    // ── attachments ──────────────────────────────────────────────────────────
    /**
     * Stage one file.
     *
     * The browser can only supply bytes — there is no host path to hand over — so
     * images and PDFs go through the base64 variants and everything else through
     * `file.attach`'s `data_url`. The reply's `ref_text` is what the composer
     * inserts.
     */
    async attachFile(file, id, onProgress) {
      const kind = file.type === "application/pdf" || /\.pdf$/i.test(file.name) ? "pdf" : file.type.startsWith("image/") ? "image" : file.type.startsWith("video/") ? "video" : "file";
      const runtimeId = await this.ensureSession();
      if (!runtimeId) throw new Error(messagesFor(this.locale).sessionNotReady);
      onProgress?.({ phase: "reading", readProgress: 0 });
      const dataUrl = await file.dataUrl((fraction) => onProgress?.({ phase: "reading", readProgress: fraction }));
      onProgress?.({ phase: "uploading" });
      const params = { session_id: runtimeId };
      if (kind === "file" || kind === "video") {
        params.data_url = dataUrl;
        params.name = file.name;
      } else {
        params.content_base64 = dataUrl.replace(/^data:[^;]+;base64,/, "");
        params.filename = file.name;
      }
      const result = await this.rpc(attachMethodFor(kind), params);
      if (!result?.attached) throw new Error(messagesFor(this.locale).attachmentNotAccepted);
      return {
        id,
        kind,
        name: result.name || file.name,
        size: file.size,
        path: result.path,
        refText: result.ref_text,
        status: "ready"
      };
    }
    /** Path / `@`-reference completions for the composer. */
    async completePath(word) {
      const runtimeId = this.state.tabs.find((t) => t.key === this.state.activeKey)?.runtimeId;
      const result = await this.rpc(
        "complete.path",
        { word, session_id: runtimeId ?? void 0 }
      );
      return result.items ?? [];
    }
    /** Slash completions for a `/token`. */
    async completeSlash(text) {
      const runtimeId = this.state.tabs.find((t) => t.key === this.state.activeKey)?.runtimeId;
      const result = await this.rpc("complete.slash", { text, session_id: runtimeId ?? void 0 });
      return { items: result.items ?? [], replace_from: result.replace_from };
    }
    /** The full command catalog; fetched once and filtered locally for instant menus. */
    async commandsCatalog() {
      return this.rpc("commands.catalog", {});
    }
    // ── resync ───────────────────────────────────────────────────────────────
    /** Re-read the focused session's durable transcript after a reconnect. */
    async resync() {
      const key = this.state.activeKey;
      if (!key || this.resyncing) return;
      const tab = this.state.tabs.find((t) => t.key === key);
      const sessionId = tab?.runtimeId ?? tab?.storedId;
      if (!sessionId) return;
      this.resyncing = true;
      try {
        await this.client.ensureOpen();
        const result = await this.rpc("session.history", {
          session_id: sessionId
        });
        this.setState(replaceHistory(this.state, key, result.messages ?? []));
      } catch {
      } finally {
        this.resyncing = false;
      }
    }
    // ── event intake ─────────────────────────────────────────────────────────
    handleEvent(event) {
      if (event.type === "gateway.ready") this.dedupe.setEpoch(this.client.epoch);
      if (isWithdrawalEvent(event.type)) {
        const withdrawals = withdrawalsFrom(event);
        if (!withdrawals.length) return;
        for (const withdrawal of withdrawals) {
          if (this.withdrawalSink) this.withdrawalSink(withdrawal);
          else this.pendingWithdrawals.push(withdrawal);
        }
        return;
      }
      const result = routeEvent(this.state, event, this.dedupe);
      if (result.applied && result.state !== this.state) {
        this.setState(result.state);
        this.announce(event, result.state);
      }
    }
    /**
     * Tell the page a turn ended, so it can decide whether to ring the desktop.
     *
     * The text is taken from the timeline rather than the frame: `message.complete`
     * often carries an empty `text` because the reply already streamed, and a
     * notification whose body is blank is worse than none.
     */
    announce(event, state) {
      if (!this.noticeSink) return;
      if (event.type !== "message.complete" && event.type !== "error") return;
      const key = event.session_id ? state.tabs.find((tab) => tab.runtimeId === event.session_id)?.key ?? null : state.activeKey;
      if (!key) return;
      const timeline = state.sessions[key];
      if (!timeline) return;
      const p = event.payload ?? {};
      const textOf3 = (value) => typeof value === "string" ? value : "";
      let fallback = "";
      for (let i = timeline.items.length - 1; i >= 0; i -= 1) {
        const item = timeline.items[i];
        if (item?.kind === "assistant") {
          fallback = item.text;
          break;
        }
      }
      const error = event.type === "error" ? textOf3(p.message) || "error" : textOf3(p.error) || textOf3(p.failure_reason) || void 0;
      this.noticeSink({
        kind: "complete",
        sessionKey: key,
        title: timeline.meta.title,
        text: textOf3(p.text) || fallback,
        error
      });
    }
    handleServerRequest(request) {
      if (!HANDLED_REQUESTS.has(request.method)) return false;
      const sessionId = typeof request.params.session_id === "string" ? request.params.session_id : "";
      const card = {
        id: request.id,
        method: request.method,
        params: request.params,
        sessionId,
        respond: request.respond,
        fail: request.fail
      };
      const owner = sessionId ? this.state.tabs.find((tab) => tab.runtimeId === sessionId) : void 0;
      this.noticeSink?.({
        kind: "request",
        method: request.method,
        params: request.params,
        requestId: request.id,
        sessionKey: sessionId,
        title: owner?.title ?? "",
        text: ""
      });
      if (!this.cardSink) {
        this.pendingCards.push(card);
        return true;
      }
      this.cardSink(card);
      return true;
    }
    answerRequest(card, result) {
      card.respond(result);
    }
  };

  // src/app/persistent.ts
  function createControllerHolder(factory) {
    let instance = null;
    let refs = 0;
    return {
      acquire() {
        if (!instance) instance = factory();
        refs += 1;
        return instance;
      },
      release() {
        refs = Math.max(0, refs - 1);
        return refs;
      },
      peek() {
        return instance;
      },
      reset() {
        const current = instance;
        instance = null;
        refs = 0;
        current?.dispose();
      },
      refCount() {
        return refs;
      }
    };
  }

  // src/ui/icons.ts
  var PATHS = {
    // Circular arrow: the chat-page refresh (data only, not a browser reload).
    refresh: ["M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8", "M21 3v5h-5"],
    // Three dots: the menu affordance ("···" as the brief calls it).
    dots: ["M6 12h.01", "M12 12h.01", "M18 12h.01"],
    send: ["M12 19V5", "M5.5 11.5 12 5l6.5 6.5"],
    // A filled square is the universal stop; `fill` is set per icon below.
    stop: ["M8 8h8v8H8z"],
    // Arrow into a tray line: delivering the message into a running turn.
    insert: ["M12 7v14", "m18 13-6-6-6 6", "M5 3h14"],
    paperclip: [
      "m16 6-8.414 8.586a2 2 0 0 0 2.829 2.829l8.414-8.586a4 4 0 1 0-5.657-5.657l-8.379 8.551a6 6 0 1 0 8.485 8.485l8.379-8.551"
    ],
    plus: ["M5 12h14", "M12 5v14"],
    // Model: a chip with its pins.
    model: [
      "M12 2v2",
      "M12 20v2",
      "M17 2v2",
      "M17 20v2",
      "M2 7h2",
      "M2 12h2",
      "M2 17h2",
      "M20 7h2",
      "M20 12h2",
      "M20 17h2",
      "M7 2v2",
      "M7 20v2",
      "M7 4h10a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z",
      "M10 8h4a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1h-4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z"
    ],
    // Reasoning effort: a dial.
    reasoning: ["m12 14 4-4", "M3.34 19a10 10 0 1 1 17.32 0"],
    bell: [
      "M10.268 21a2 2 0 0 0 3.464 0",
      "M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326"
    ],
    bellOff: [
      "M10.268 21a2 2 0 0 0 3.464 0",
      "M17 17H4a1 1 0 0 1-.74-1.673C4.59 13.956 6 12.499 6 8a6 6 0 0 1 .258-1.742",
      "m2 2 20 20",
      "M8.668 3.01A6 6 0 0 1 18 8c0 2.687.77 4.653 1.707 6.05"
    ],
    close: ["M18 6 6 18", "m6 6 12 12"],
    image: [
      "M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z",
      "M9 11a2 2 0 1 0 0-4 2 2 0 0 0 0 4z",
      "m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"
    ],
    video: [
      "m16 13 5.223 3.482a.5.5 0 0 0 .777-.416V7.87a.5.5 0 0 0-.752-.432L16 10.5",
      "M4 6h10a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2z"
    ],
    file: [
      "M8 2h6.4a2.4 2.4 0 0 1 1.7.706l3.594 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z",
      "M14 2v5a1 1 0 0 0 1 1h5",
      "M10 9H8",
      "M16 13H8",
      "M16 17H8"
    ],
    chevron: ["m9 18 6-6-6-6"],
    // Branch in a new chat: the two-commit fork the desktop app uses.
    branch: ["M15 6a9 9 0 0 0-9 9V3", "M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6z", "M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6z"],
    copy: [
      "M10 8h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-8a2 2 0 0 1-2-2V10a2 2 0 0 1 2-2z",
      "M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"
    ],
    check: ["M20 6 9 17l-5-5"],
    // Regenerate: the clockwise circle arrow every chat UI uses for it.
    redo: ["M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8", "M21 3v5h-5"],
    pencil: [
      "M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z",
      "m15 5 4 4"
    ],
    trash: [
      "M10 11v6",
      "M14 11v6",
      "M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6",
      "M3 6h18",
      "M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"
    ],
    // Session as context: it goes down into the composer.
    download: ["M12 3v14", "m6 11 6 6 6-6", "M5 21h14"],
    alert: ["M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z", "M12 8v4", "M12 16h.01"],
    // Todo status glyphs. Same 24 grid, so the list lines up with everything
    // else in a row instead of using a font's ○ ◐ ✓/✕ (which never share a size).
    circle: ["M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z"],
    circleDot: ["M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z", "M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8z"]
  };
  var FILLED = /* @__PURE__ */ new Set(["stop"]);
  var CIRCLES = {
    dots: [
      [6, 12, 1.55],
      [12, 12, 1.55],
      [18, 12, 1.55]
    ]
  };
  var RECTS = {
    stop: [[8, 8, 8, 8, 2]]
  };
  function Icon(sdk, props) {
    const { React } = sdk;
    const size = props.size ?? 18;
    const filled = FILLED.has(props.name);
    const circles = CIRCLES[props.name] ?? [];
    const rects = RECTS[props.name] ?? [];
    const paths = circles.length || rects.length ? [] : PATHS[props.name];
    return React.createElement(
      "svg",
      {
        className: props.className ? `hb-icon ${props.className}` : "hb-icon",
        // The icon's identity as an attribute: a script (or the acceptance suite)
        // cannot read a glyph off an SVG the way it could off a text character,
        // and "which icon is showing" is exactly what the copy button's
        // confirmation state is.
        "data-icon": props.name,
        width: size,
        height: size,
        viewBox: "0 0 24 24",
        fill: filled || circles.length || rects.length ? "currentColor" : "none",
        stroke: filled || circles.length || rects.length ? "none" : "currentColor",
        strokeWidth: 1.75,
        strokeLinecap: "round",
        strokeLinejoin: "round",
        "aria-hidden": "true",
        focusable: "false"
      },
      ...paths.map((d, index) => React.createElement("path", { key: `p${index}`, d })),
      ...circles.map(
        ([cx, cy, r], index) => React.createElement("circle", { key: `c${index}`, cx, cy, r })
      ),
      ...rects.map(
        ([x, y, w, h, rx], index) => React.createElement("rect", { key: `r${index}`, x, y, width: w, height: h, rx })
      )
    );
  }

  // src/core/notice.ts
  function subagentCount(detail) {
    const envelopes = detail.match(/\[IMPORTANT:/g)?.length ?? 0;
    if (envelopes > 0) return envelopes;
    const prose = /(\d+)\s+(?:background\s+)?(?:process|agent|delegat|subagent|task)/i.exec(detail);
    return prose ? Math.max(1, Number(prose[1])) : 1;
  }
  function noticeText(item, locale) {
    const t = messagesFor(locale);
    switch (item.noticeKind) {
      case "process":
        return t.noticeProcess;
      case "subagents":
        return t.noticeSubagents(subagentCount(item.detail ?? item.text));
      case "background":
        return t.noticeBackground;
      case "model":
        return t.noticeModel;
      case "continue":
        return t.noticeContinue;
      case "personality":
        return t.noticePersonality;
      default:
        return item.text;
    }
  }

  // src/core/markdown.ts
  var ESCAPABLE = new Set("\\`*_{}[]()#+-.!>~|".split(""));
  function parseMarkdown(source) {
    if (!source) return [];
    return parseBlocks(source.replace(/\r\n?/g, "\n").split("\n"));
  }
  var FENCE_RE = /^ {0,3}(`{3,}|~{3,})[ \t]*([^`]*)$/;
  var HEADING_RE = /^ {0,3}(#{1,6})[ \t]+(.*)$/;
  var HR_RE = /^ {0,3}(?:-{3,}|\*{3,}|_{3,})[ \t]*$/;
  var LIST_RE = /^(\s*)([-*+]|\d{1,9}[.)])[ \t]+(.*)$/;
  var QUOTE_RE = /^ {0,3}>[ \t]?(.*)$/;
  var TABLE_SEP_RE = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;
  function indentOf(line) {
    let n = 0;
    while (line[n] === " ") n += 1;
    return n;
  }
  function matchFence(line) {
    const m = FENCE_RE.exec(line);
    if (!m) return null;
    const marker = m[1];
    return { char: marker[0], length: marker.length, info: (m[2] ?? "").trim() };
  }
  function parseBlocks(lines) {
    const blocks = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) {
        i += 1;
        continue;
      }
      const fence = matchFence(line);
      if (fence) {
        const body = [];
        let closed = false;
        i += 1;
        while (i < lines.length) {
          const candidate = lines[i];
          const closing = matchFence(candidate);
          if (closing && closing.char === fence.char && closing.length >= fence.length && !closing.info) {
            closed = true;
            i += 1;
            break;
          }
          body.push(candidate);
          i += 1;
        }
        blocks.push({ type: "code", lang: fence.info.split(/\s+/)[0] ?? "", value: body.join("\n"), closed });
        continue;
      }
      const heading = HEADING_RE.exec(line);
      if (heading) {
        blocks.push({
          type: "heading",
          level: heading[1].length,
          children: parseInline(heading[2].trim())
        });
        i += 1;
        continue;
      }
      if (HR_RE.test(line)) {
        blocks.push({ type: "hr" });
        i += 1;
        continue;
      }
      if (QUOTE_RE.test(line)) {
        const inner = [];
        while (i < lines.length) {
          const quoted = QUOTE_RE.exec(lines[i]);
          if (quoted) {
            inner.push(quoted[1]);
            i += 1;
            continue;
          }
          const next = lines[i];
          if (next.trim() && !matchFence(next) && !HEADING_RE.test(next) && !LIST_RE.test(next) && !HR_RE.test(next)) {
            inner.push(next);
            i += 1;
            continue;
          }
          break;
        }
        blocks.push({ type: "blockquote", children: parseBlocks(inner) });
        continue;
      }
      if (LIST_RE.test(line)) {
        const result = parseList(lines, i);
        blocks.push(result.block);
        i = result.next;
        continue;
      }
      if (isTableStart(lines, i)) {
        const result = parseTable(lines, i);
        blocks.push(result.block);
        i = result.next;
        continue;
      }
      const paragraph = [];
      while (i < lines.length) {
        const current = lines[i];
        if (!current.trim()) break;
        if (paragraph.length > 0 && (matchFence(current) || HEADING_RE.test(current) || HR_RE.test(current) || LIST_RE.test(current) || QUOTE_RE.test(current) || isTableStart(lines, i))) {
          break;
        }
        paragraph.push(current.trim());
        i += 1;
      }
      if (paragraph.length) {
        blocks.push({ type: "paragraph", children: parseInline(paragraph.join("\n")) });
      }
    }
    return blocks;
  }
  function parseList(lines, start) {
    const first = LIST_RE.exec(lines[start]);
    const baseIndent = first[1].length;
    const ordered = /\d/.test(first[2]);
    const startNumber = ordered ? Number.parseInt(first[2].replace(/[.)]$/, ""), 10) : 1;
    const raw = [[first[3]]];
    let loose = false;
    let i = start + 1;
    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) {
        let j = i + 1;
        while (j < lines.length && !lines[j].trim()) j += 1;
        if (j >= lines.length) break;
        const nextLine = lines[j];
        const nextMarker = LIST_RE.exec(nextLine);
        const continues = nextMarker ? indentOf(nextLine) >= baseIndent : indentOf(nextLine) >= baseIndent + 2;
        if (!continues) break;
        loose = true;
        raw[raw.length - 1].push("");
        i += 1;
        continue;
      }
      const marker = LIST_RE.exec(line);
      const indent = indentOf(line);
      if (marker && indent === baseIndent) {
        raw.push([marker[3]]);
        i += 1;
        continue;
      }
      if (indent >= baseIndent + 2 || !marker && indent > baseIndent) {
        const dedent = Math.min(indent, baseIndent + 2);
        raw[raw.length - 1].push(line.slice(dedent));
        i += 1;
        continue;
      }
      if (marker && indent > baseIndent) {
        const dedent = Math.min(indent, baseIndent + 2);
        raw[raw.length - 1].push(line.slice(dedent));
        i += 1;
        continue;
      }
      break;
    }
    return {
      block: {
        type: "list",
        ordered,
        start: Number.isFinite(startNumber) ? startNumber : 1,
        items: raw.map((itemLines) => parseBlocks(itemLines)),
        loose
      },
      next: i
    };
  }
  function isTableStart(lines, i) {
    const header = lines[i];
    const separator = lines[i + 1];
    if (header === void 0 || separator === void 0) return false;
    if (!header.includes("|")) return false;
    if (!separator.includes("|") && !separator.includes("-")) return false;
    return TABLE_SEP_RE.test(separator);
  }
  function splitTableRow(line) {
    const cells = [];
    const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
    let current = "";
    let inCode = false;
    for (let i = 0; i < trimmed.length; i += 1) {
      const ch = trimmed[i];
      if (ch === "\\" && i + 1 < trimmed.length) {
        current += trimmed[i + 1];
        i += 1;
        continue;
      }
      if (ch === "`") {
        inCode = !inCode;
        current += ch;
        continue;
      }
      if (ch === "|" && !inCode) {
        cells.push(current.trim());
        current = "";
        continue;
      }
      current += ch;
    }
    cells.push(current.trim());
    return cells;
  }
  function parseAlign(separator) {
    return splitTableRow(separator).map((cell) => {
      const left = cell.startsWith(":");
      const right = cell.endsWith(":");
      if (left && right) return "center";
      if (right) return "right";
      if (left) return "left";
      return null;
    });
  }
  function parseTable(lines, start) {
    const head = splitTableRow(lines[start]).map((cell) => parseInline(cell));
    const align = parseAlign(lines[start + 1]);
    const rows = [];
    let i = start + 2;
    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim() || !line.includes("|")) break;
      const cells = splitTableRow(line);
      while (cells.length < head.length) cells.push("");
      rows.push(cells.slice(0, head.length).map((cell) => parseInline(cell)));
      i += 1;
    }
    return { block: { type: "table", align, head, rows }, next: i };
  }
  function runLength(source, at, ch) {
    let n = 0;
    while (source[at + n] === ch) n += 1;
    return n;
  }
  function findRun(source, from, ch, len) {
    let i = from;
    while (i < source.length) {
      if (source[i] === ch && runLength(source, i, ch) === len) return i;
      i += 1;
    }
    return -1;
  }
  function safeHref(raw) {
    const value = raw.trim();
    if (!value) return null;
    if (/^[a-z][a-z0-9+.-]*:/i.test(value)) {
      return /^(https?:|mailto:|tel:)/i.test(value) ? value : null;
    }
    return value;
  }
  function findClosingDelim(source, from, delim, underscore) {
    let j = from;
    while (j < source.length) {
      const at = source.indexOf(delim, j);
      if (at === -1) return -1;
      if (underscore) {
        const after = source[at + delim.length];
        if (after !== void 0 && /[A-Za-z0-9]/.test(after)) {
          j = at + delim.length;
          continue;
        }
      }
      return at;
    }
    return -1;
  }
  function parseEmphasis(source, at) {
    const ch = source[at];
    const underscore = ch === "_";
    if (underscore && at > 0 && /[A-Za-z0-9]/.test(source[at - 1])) return null;
    const run = runLength(source, at, ch);
    const maxLen = Math.min(run, 3);
    for (let len = maxLen; len >= 1; len -= 1) {
      const afterOpen = source[at + len];
      if (afterOpen === void 0 || /\s/.test(afterOpen)) continue;
      const delim = ch.repeat(len);
      const close = findClosingDelim(source, at + len, delim, underscore);
      if (close === -1 || close === at + len) continue;
      if (/\s/.test(source[close - 1])) continue;
      const children = parseInline(source.slice(at + len, close));
      const node = len === 3 ? { type: "strong", children: [{ type: "em", children }] } : len === 2 ? { type: "strong", children } : { type: "em", children };
      return { node, end: close + len };
    }
    return null;
  }
  function parseLinkLike(source, at) {
    const closeBracket = findClosingBracket(source, at);
    if (closeBracket === -1) return null;
    if (source[closeBracket + 1] !== "(") return null;
    const closeParen = findClosingParen(source, closeBracket + 1);
    if (closeParen === -1) return null;
    const target = source.slice(closeBracket + 2, closeParen).trim();
    const href = target.split(/\s+/)[0] ?? "";
    if (!href) return null;
    return { href, children: parseInline(source.slice(at + 1, closeBracket)), end: closeParen + 1 };
  }
  function findClosingParen(source, from) {
    let depth = 0;
    for (let i = from; i < source.length; i += 1) {
      const ch = source[i];
      if (ch === "\\") {
        i += 1;
        continue;
      }
      if (ch === "(") depth += 1;
      else if (ch === ")") {
        depth -= 1;
        if (depth === 0) return i;
      }
    }
    return -1;
  }
  function findClosingBracket(source, from) {
    let depth = 0;
    let inCode = false;
    for (let i = from; i < source.length; i += 1) {
      const ch = source[i];
      if (ch === "\\") {
        i += 1;
        continue;
      }
      if (ch === "`") inCode = !inCode;
      if (inCode) continue;
      if (ch === "[") depth += 1;
      else if (ch === "]") {
        depth -= 1;
        if (depth === 0) return i;
      }
    }
    return -1;
  }
  function flatten(nodes) {
    let out = "";
    for (const node of nodes) {
      if (node.type === "text" || node.type === "code") out += node.value;
      else if (node.type === "image") out += node.alt;
      else if ("children" in node) out += flatten(node.children);
    }
    return out;
  }
  function stripTrailingPunctuation(url) {
    let out = url;
    for (; ; ) {
      const last = out[out.length - 1];
      if (last === void 0) return out;
      if (/[.,;:!?'"]/.test(last)) {
        out = out.slice(0, -1);
        continue;
      }
      if (last === ")") {
        const opens = (out.match(/\(/g) ?? []).length;
        const closes = (out.match(/\)/g) ?? []).length;
        if (closes > opens) {
          out = out.slice(0, -1);
          continue;
        }
      }
      return out;
    }
  }
  function parseInline(source) {
    const nodes = [];
    let buffer = "";
    const flush = () => {
      if (!buffer) return;
      const last = nodes[nodes.length - 1];
      if (last && last.type === "text") last.value += buffer;
      else nodes.push({ type: "text", value: buffer });
      buffer = "";
    };
    let i = 0;
    while (i < source.length) {
      const ch = source[i];
      if (ch === "\\" && i + 1 < source.length && ESCAPABLE.has(source[i + 1])) {
        buffer += source[i + 1];
        i += 2;
        continue;
      }
      if (ch === "`") {
        const open = runLength(source, i, "`");
        const close = findRun(source, i + open, "`", open);
        if (close !== -1) {
          flush();
          const raw = source.slice(i + open, close);
          nodes.push({ type: "code", value: raw.replace(/^ (.*) $/s, "$1") });
          i = close + open;
          continue;
        }
      }
      if (ch === "!" && source[i + 1] === "[") {
        const parsed = parseLinkLike(source, i + 1);
        if (parsed) {
          flush();
          nodes.push({ type: "image", href: safeHref(parsed.href), alt: flatten(parsed.children) });
          i = parsed.end;
          continue;
        }
      }
      if (ch === "[") {
        const parsed = parseLinkLike(source, i);
        if (parsed) {
          const href = safeHref(parsed.href);
          flush();
          if (href) nodes.push({ type: "link", href, children: parsed.children });
          else nodes.push(...parsed.children);
          i = parsed.end;
          continue;
        }
      }
      if (ch === "<") {
        const end = source.indexOf(">", i + 1);
        if (end !== -1) {
          const inner = source.slice(i + 1, end);
          if (/^(https?:\/\/|mailto:)\S+$/i.test(inner)) {
            flush();
            nodes.push({
              type: "link",
              href: inner,
              children: [{ type: "text", value: inner.replace(/^mailto:/i, "") }]
            });
            i = end + 1;
            continue;
          }
        }
      }
      if (ch === "~" && source[i + 1] === "~") {
        const close = findRun(source, i + 2, "~", 2);
        if (close !== -1 && close > i + 2 && !/\s$/.test(source.slice(i + 2, close))) {
          flush();
          nodes.push({ type: "del", children: parseInline(source.slice(i + 2, close)) });
          i = close + 2;
          continue;
        }
      }
      if (ch === "*" || ch === "_") {
        const match = parseEmphasis(source, i);
        if (match) {
          flush();
          nodes.push(match.node);
          i = match.end;
          continue;
        }
      }
      if ((ch === "h" || ch === "H") && /^https?:\/\//i.test(source.slice(i, i + 8))) {
        const match = /^https?:\/\/[^\s<>`]+/i.exec(source.slice(i));
        if (match) {
          const url = stripTrailingPunctuation(match[0]);
          if (url.length > "https://".length && safeHref(url)) {
            flush();
            nodes.push({ type: "link", href: url, children: [{ type: "text", value: url }] });
            i += url.length;
            continue;
          }
        }
      }
      buffer += ch;
      i += 1;
    }
    flush();
    return nodes;
  }

  // src/ui/Markdown.ts
  var CODE_MAX_HEIGHT = "20rem";
  var HEADING_SIZE = {
    1: "1.15em",
    2: "1.08em",
    3: "1em",
    4: "0.95em",
    5: "0.9em",
    6: "0.9em"
  };
  function renderInline(ctx, nodes, keyPrefix) {
    const { React } = ctx;
    return nodes.map((node, index) => {
      const key = `${keyPrefix}-i${index}`;
      switch (node.type) {
        case "text":
          return node.value;
        case "code":
          return React.createElement(
            "code",
            {
              key,
              className: "hb-inline-code"
            },
            node.value
          );
        case "strong":
          return React.createElement("strong", { key, style: { fontWeight: 600 } }, renderInline(ctx, node.children, key));
        case "em":
          return React.createElement("em", { key }, renderInline(ctx, node.children, key));
        case "del":
          return React.createElement("del", { key, style: { opacity: 0.7 } }, renderInline(ctx, node.children, key));
        case "link":
          return React.createElement(
            "a",
            {
              key,
              href: node.href,
              title: node.href,
              // `noreferrer` also implies noopener; the dashboard is same-origin
              // with nothing we want to hand a window reference to.
              rel: "noreferrer noopener",
              target: "_blank",
              className: "hb-link",
              onClick: () => ctx.onOpenLink(node.href)
            },
            renderInline(ctx, node.children, key)
          );
        case "image":
          return node.href ? React.createElement("img", {
            key,
            src: node.href,
            alt: node.alt,
            className: "hb-md-image",
            loading: "lazy"
          }) : React.createElement("span", { key, className: "hb-muted" }, `\u{1F5BC} ${node.alt}`);
      }
    });
  }
  function fallbackCopy(text) {
    try {
      const area = document.createElement("textarea");
      area.value = text;
      area.setAttribute("readonly", "");
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand("copy");
      area.remove();
      return ok;
    } catch {
      return false;
    }
  }
  function caretNode(ctx, key) {
    return ctx.React.createElement(
      "span",
      {
        key,
        className: "hb-caret",
        style: { color: "var(--color-primary)", marginLeft: "0.1em" }
      },
      "\u258C"
    );
  }
  function CodeBlock({
    ctx,
    value,
    lang
  }) {
    const { React } = ctx;
    const { useState } = ctx.hooks;
    const [copied, setCopied] = useState(false);
    const [failed, setFailed] = useState(false);
    const copy = () => {
      const done = () => {
        setCopied(true);
        setFailed(false);
        window.setTimeout(() => setCopied(false), 1500);
      };
      const fail = () => {
        setFailed(true);
        window.setTimeout(() => setFailed(false), 1500);
      };
      const viaFallback = () => ctx.fallbackCopy(value) ? done() : fail();
      try {
        const writing = navigator.clipboard?.writeText(value);
        if (writing) writing.then(done).catch(viaFallback);
        else viaFallback();
      } catch {
        viaFallback();
      }
    };
    return React.createElement(
      "div",
      { className: "hb-md-codeblock" },
      React.createElement(
        "div",
        { className: "hb-md-codebar" },
        lang ? React.createElement(
          "span",
          { className: "hb-md-code-lang", style: { color: "var(--color-muted-foreground)" } },
          lang
        ) : null,
        React.createElement(
          "button",
          {
            type: "button",
            // Localized label, plus the glyph as its own confirmation state.
            title: ctx.copyCodeLabel,
            "aria-label": ctx.copyCodeLabel,
            "data-hb": "copy-code",
            "data-copied": copied ? "true" : "false",
            "data-failed": failed ? "true" : "false",
            className: "hb-code-copy",
            onClick: copy
          },
          Icon(ctx.sdk, { name: copied ? "check" : failed ? "alert" : "copy", size: 14 })
        )
      ),
      React.createElement(
        "pre",
        {
          className: "hb-pre hb-md-pre",
          style: { maxHeight: CODE_MAX_HEIGHT, overflow: "auto" }
        },
        React.createElement("code", null, value)
      )
    );
  }
  function renderBlocks(ctx, blocks, keyPrefix = "b", caret = false) {
    const { React } = ctx;
    const nodes = blocks.map((block, index) => {
      const key = `${keyPrefix}-${index}`;
      const withCaret = caret && index === blocks.length - 1;
      switch (block.type) {
        case "paragraph":
          return React.createElement(
            "p",
            { key, className: "hb-md-p" },
            renderInline(ctx, block.children, key),
            withCaret ? caretNode(ctx, `${key}-caret`) : null
          );
        case "heading": {
          const tag = `h${Math.min(Math.max(block.level, 1), 6)}`;
          return React.createElement(
            tag,
            {
              key,
              className: "hb-md-h",
              style: { fontSize: HEADING_SIZE[block.level] ?? "1em" }
            },
            renderInline(ctx, block.children, key),
            withCaret ? caretNode(ctx, `${key}-caret`) : null
          );
        }
        case "code":
          return React.createElement(CodeBlock, {
            key,
            ctx,
            value: block.value,
            lang: block.lang
          });
        case "list": {
          const tag = block.ordered ? "ol" : "ul";
          return React.createElement(
            tag,
            {
              key,
              className: block.ordered ? "hb-md-ol" : "hb-md-ul",
              start: block.ordered && block.start !== 1 ? block.start : void 0,
              style: { listStyleType: block.ordered ? "decimal" : "disc" }
            },
            block.items.map(
              (item, itemIndex) => React.createElement(
                "li",
                {
                  key: `${key}-l${itemIndex}`,
                  className: block.loose ? "hb-md-li-loose" : void 0
                },
                renderBlocks(ctx, item, `${key}-l${itemIndex}`)
              )
            )
          );
        }
        case "blockquote":
          return React.createElement(
            "blockquote",
            {
              key,
              className: "hb-md-quote",
              style: { borderLeft: "2px solid var(--color-border)", color: "var(--color-muted-foreground)" }
            },
            renderBlocks(ctx, block.children, key)
          );
        case "hr":
          return React.createElement("hr", {
            key,
            className: "hb-md-hr",
            style: { borderColor: "var(--color-border)" }
          });
        case "table":
          return React.createElement(
            "div",
            {
              key,
              className: "hb-md-table-wrap",
              style: { borderColor: "var(--color-border)", borderRadius: "calc(var(--radius) * 0.6)" }
            },
            React.createElement(
              "table",
              { className: "hb-md-table" },
              React.createElement(
                "thead",
                null,
                React.createElement(
                  "tr",
                  null,
                  block.head.map(
                    (cell, cellIndex) => React.createElement(
                      "th",
                      {
                        key: `${key}-h${cellIndex}`,
                        style: {
                          textAlign: block.align[cellIndex] ?? "left",
                          borderColor: "var(--color-border)",
                          background: "color-mix(in oklab, var(--color-muted) 50%, transparent)"
                        }
                      },
                      renderInline(ctx, cell, `${key}-h${cellIndex}`)
                    )
                  )
                )
              ),
              React.createElement(
                "tbody",
                null,
                block.rows.map(
                  (row, rowIndex) => React.createElement(
                    "tr",
                    { key: `${key}-r${rowIndex}` },
                    row.map(
                      (cell, cellIndex) => React.createElement(
                        "td",
                        {
                          key: `${key}-r${rowIndex}c${cellIndex}`,
                          style: {
                            textAlign: block.align[cellIndex] ?? "left",
                            borderColor: "var(--color-border)"
                          }
                        },
                        renderInline(ctx, cell, `${key}-r${rowIndex}c${cellIndex}`)
                      )
                    )
                  )
                )
              )
            )
          );
      }
    });
    if (caret) {
      const last = blocks[blocks.length - 1];
      const inlineCapable = last && (last.type === "paragraph" || last.type === "heading");
      if (!inlineCapable) {
        nodes.push(
          React.createElement("div", { key: `${keyPrefix}-tail-caret` }, caretNode(ctx, `${keyPrefix}-tail-caret-s`))
        );
      }
    }
    return nodes;
  }
  function Markdown({
    sdk,
    text,
    caret = false,
    locale = "en"
  }) {
    const { React } = sdk;
    const { useMemo } = sdk.hooks;
    const t = messagesFor(locale);
    const blocks = useMemo(() => parseMarkdown(text), [text]);
    if (!blocks.length) return null;
    const ctx = {
      sdk,
      React,
      hooks: sdk.hooks,
      fallbackCopy,
      copyCodeLabel: t.copyCode,
      copiedLabel: t.copied,
      onOpenLink: (href) => {
        try {
          window.open(href, "_blank", "noopener,noreferrer");
        } catch {
        }
      }
    };
    return React.createElement("div", { className: "hb-md" }, renderBlocks(ctx, blocks, "b", caret));
  }

  // src/ui/Attachments.ts
  function kindIcon(kind) {
    if (kind === "image") return "image";
    if (kind === "video") return "video";
    return "file";
  }
  function kindLabel(item, t) {
    if (item.kind === "image") return t.imageAttachment;
    if (item.kind === "video") return t.videoAttachment;
    return t.attachmentsLabel;
  }
  function AttachmentTray(props) {
    const { sdk } = props;
    const { React } = sdk;
    const t = messagesFor(props.locale);
    if (!props.items.length) return null;
    return React.createElement(
      "div",
      { className: "hb-att-tray", "data-hb": "attachment-tray" },
      ...props.items.map((item) => {
        const percent = attachmentPercent(item);
        const staging = item.status === "staging";
        const phase = item.phase === "reading" ? t.attachReading : t.attachUploading;
        const previewable = isPreviewable(item.kind) && Boolean(item.previewUrl);
        return React.createElement(
          "span",
          {
            key: item.id,
            className: "hb-att-chip",
            "data-hb": "attachment-chip",
            "data-status": item.status,
            "data-kind": item.kind,
            title: item.error || `${item.name}${item.size ? ` \xB7 ${formatBytes(item.size)}` : ""}`
          },
          previewable ? React.createElement("img", { className: "hb-att-thumb", src: item.previewUrl, alt: "" }) : React.createElement(
            "span",
            { className: "hb-att-glyph" },
            Icon(sdk, { name: kindIcon(item.kind), size: 16 })
          ),
          React.createElement(
            "span",
            { className: "hb-att-meta" },
            React.createElement("span", { className: "hb-att-name hb-truncate" }, item.name),
            React.createElement(
              "span",
              { className: "hb-att-sub" },
              item.status === "error" ? React.createElement("span", { className: "hb-att-error" }, item.error || t.genericError) : staging ? React.createElement(
                "span",
                { className: "hb-att-phase" },
                percent === null ? phase : `${phase} ${percent}%`
              ) : formatBytes(item.size)
            )
          ),
          // The progress bar sits under the chip's content, full width.
          staging ? React.createElement(
            "span",
            {
              className: percent === null ? "hb-att-bar hb-att-bar-indeterminate" : "hb-att-bar",
              "data-hb": "attachment-progress",
              "data-percent": percent === null ? "" : String(percent),
              "aria-hidden": "true"
            },
            percent === null ? null : React.createElement("span", { className: "hb-att-bar-fill", style: { width: `${percent}%` } })
          ) : null,
          // Removing a file while its bytes are in flight would stage it anyway;
          // the control stays enabled so a stuck upload can still be cleared.
          React.createElement(
            "button",
            {
              type: "button",
              className: "hb-att-remove",
              "data-hb": "attachment-remove",
              title: t.delete,
              "aria-label": `${t.delete}: ${item.name}`,
              onClick: () => props.onRemove(item.id)
            },
            Icon(sdk, { name: "close", size: 13 })
          )
        );
      })
    );
  }
  function MessageAttachments(props) {
    const { sdk } = props;
    const { React } = sdk;
    const t = messagesFor(props.locale);
    if (!props.items.length) return null;
    return React.createElement(
      "div",
      {
        className: props.alignEnd ? "hb-msg-atts hb-msg-atts-end" : "hb-msg-atts",
        "data-hb": "message-attachments"
      },
      ...props.items.map((item, index) => {
        const tile = isPreviewable(item.kind);
        const label = item.name || kindLabel(item, t);
        return React.createElement(
          "div",
          {
            key: `${item.name}-${index}`,
            className: tile ? "hb-msg-att hb-msg-att-tile" : "hb-msg-att",
            "data-hb": "message-attachment",
            "data-kind": item.kind,
            title: item.size ? `${label} \xB7 ${formatBytes(item.size)}` : label
          },
          item.preview && item.kind === "image" ? React.createElement("img", { className: "hb-msg-att-image", src: item.preview, alt: label }) : item.preview && item.kind === "video" ? React.createElement(
            "span",
            { className: "hb-msg-att-video" },
            // `preload="metadata"` paints the first frame without pulling
            // the whole clip; no controls — this is a thumbnail, not a player.
            React.createElement("video", { src: item.preview, preload: "metadata", muted: true }),
            React.createElement("span", { className: "hb-msg-att-play" }, Icon(sdk, { name: "video", size: 14 }))
          ) : React.createElement(
            "span",
            { className: "hb-msg-att-glyph" },
            Icon(sdk, { name: kindIcon(item.kind), size: 15 })
          ),
          tile ? null : React.createElement(
            "span",
            { className: "hb-msg-att-name hb-truncate" },
            label
          )
        );
      })
    );
  }

  // src/ui/format.ts
  var TOOL_LABEL_KEYS = {
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
    text_to_speech: "toolTextToSpeech"
  };
  function toolLabel(name, t) {
    const key = TOOL_LABEL_KEYS[name];
    return key ? t[key] : name;
  }
  function rejectionLabel(rejection, t) {
    if (rejection.code === "empty") return t.attachmentEmpty;
    return t.attachmentTooLarge(rejection.limitMib ?? MAX_ATTACHMENT_MIB);
  }
  var TOOL_PREVIEW_CHARS = 400;
  function toolPreview(result, limit = TOOL_PREVIEW_CHARS) {
    const text = (result ?? "").replace(/\s+$/, "");
    if (text.length <= limit) return { text, truncated: false };
    const cut = text.slice(0, limit);
    const lastBreak = cut.lastIndexOf("\n");
    const body = lastBreak > limit * 0.5 ? cut.slice(0, lastBreak) : cut;
    return { text: body, truncated: true };
  }
  function formatDuration(seconds) {
    if (typeof seconds !== "number" || !Number.isFinite(seconds)) return "";
    if (seconds < 1) return `${Math.round(seconds * 1e3)}ms`;
    if (seconds < 60) return `${seconds.toFixed(1)}s`;
    const minutes = Math.floor(seconds / 60);
    const rest = Math.round(seconds % 60);
    return `${minutes}m${rest}s`;
  }
  function formatCount(value) {
    if (typeof value !== "number" || !Number.isFinite(value)) return "";
    if (value < 1e3) return String(value);
    if (value < 1e6) return `${(value / 1e3).toFixed(value < 1e4 ? 1 : 0)}k`;
    return `${(value / 1e6).toFixed(1)}M`;
  }
  function runningLabel(meta, t) {
    if (meta.statusKind === "reconnecting") return t.reconnecting;
    if (meta.status) return meta.status;
    return meta.running ? t.working : "";
  }
  function activitySummary(counts, t) {
    const parts = [];
    if (counts.thoughts) parts.push(t.activityThoughts(counts.thoughts));
    if (counts.tools) parts.push(t.activityTools(counts.tools));
    if (counts.subagents) parts.push(t.activitySubagents(counts.subagents));
    if (counts.notices && !parts.length) parts.push(t.activityNotices(counts.notices));
    return parts.join(" \xB7 ");
  }

  // src/ui/Bubble.ts
  var USER_RADIUS = "calc(var(--radius) * 1.6) calc(var(--radius) * 1.6) calc(var(--radius) * 0.5) calc(var(--radius) * 1.6)";
  var ASSISTANT_RADIUS = "calc(var(--radius) * 1.6) calc(var(--radius) * 1.6) calc(var(--radius) * 1.6) calc(var(--radius) * 0.5)";
  function UserBubble({
    sdk,
    item,
    locale,
    onEdit
  }) {
    const { React } = sdk;
    const t = messagesFor(locale);
    return React.createElement(
      "div",
      { className: "flex flex-col items-end" },
      // Attachments sit above the text and right-aligned with it, so a photo-only
      // turn reads as a picture, not as an empty bubble with a caption.
      React.createElement(MessageAttachments, {
        sdk,
        locale,
        items: item.attachments ?? [],
        alignEnd: true
      }),
      item.text.trim() ? React.createElement(
        "div",
        {
          className: "whitespace-pre-wrap break-words px-3 py-2 text-sm leading-relaxed hb-bubble-text",
          style: {
            maxWidth: "min(72ch, 82%)",
            background: "color-mix(in oklab, var(--color-primary) 16%, var(--color-card))",
            color: "var(--color-card-foreground)",
            borderRadius: USER_RADIUS,
            opacity: item.pending ? 0.75 : 1
          }
        },
        item.text
      ) : null,
      // Edit is offered on a settled user turn only: while it is still in flight
      // there is no stored row to cut, and the affordance would fail on click.
      onEdit && !item.pending ? React.createElement(
        "div",
        { className: "hb-actions flex items-center gap-1.5", "data-hb": "user-actions" },
        React.createElement(
          "div",
          { className: "hb-actions-tools ml-auto flex items-center gap-1" },
          React.createElement(
            "button",
            {
              type: "button",
              title: t.edit,
              "aria-label": t.edit,
              "data-hb": "edit-message",
              className: "hb-action-btn",
              onClick: (event) => {
                event.stopPropagation();
                onEdit(item.id, item.text);
              }
            },
            Icon(sdk, { name: "pencil", size: 15 })
          )
        )
      ) : null
    );
  }
  var WHALE_STILL_PATH = "M8.844 13.742C8.967 12.328 8.45 10.4 8.45 9.65C8.45 8.94 8.88 8.43 9.6 8.43C11.285 8.43 12.106 8.281 12.685 8.104C13.71 7.791 14.585 6.768 15.055 5.945C15.137 5.803 14.99 5.641 14.829 5.671C13.829 5.86 12.828 5.376 11.827 4.978C10.659 4.514 9.491 4.707 8.935 4.876C8.805 4.915 8.658 4.819 8.636 4.686C8.468 3.643 7.405 2.615 5.498 2.238C4.54 2.048 3.748 1.574 3.347 1.202C3.252 1.113 3.088 1.125 3.03 1.242C2.628 2.059 2.168 3.82 5.248 6.115C5.82 6.494 6.31 6.785 6.574 7.637C6.72 8.104 6.157 9.168 6.061 9.368C5.157 11.27 5.089 12.19 4.926 13.742";
  function WhaleTail({ sdk }) {
    const { React } = sdk;
    return React.createElement(
      "span",
      { className: "hb-whale", "aria-hidden": "true", "data-hb": "running-whale" },
      React.createElement("span", { className: "hb-whale-anim" }),
      React.createElement(
        "svg",
        { className: "hb-whale-still", viewBox: "0 0 16 16", fill: "none" },
        React.createElement("path", { d: WHALE_STILL_PATH, stroke: "currentColor", strokeWidth: 1 })
      )
    );
  }
  function ReasoningRow({
    sdk,
    item,
    locale
  }) {
    const { React } = sdk;
    const { useState, useMemo } = sdk.hooks;
    const [open, setOpen] = useState(false);
    const trimmed = item.text.trim();
    const t = messagesFor(locale);
    const tail = useMemo(() => {
      const lines = trimmed.split("\n").filter((line) => line.trim());
      return lines.at(-1) ?? trimmed;
    }, [trimmed]);
    if (!trimmed) return null;
    return React.createElement(
      "div",
      {
        className: "hb-think",
        "data-hb": "reasoning-row",
        "data-streaming": item.streaming ? "true" : "false"
      },
      React.createElement(
        "button",
        {
          type: "button",
          className: "hb-think-head",
          "data-hb": "reasoning-toggle",
          "data-open": open ? "true" : "false",
          "aria-expanded": open ? "true" : "false",
          onClick: () => setOpen((v) => !v)
        },
        React.createElement("span", { className: "hb-think-caret" }, Icon(sdk, { name: "chevron", size: 13 })),
        React.createElement("span", { className: "hb-think-label" }, t.thought),
        item.streaming ? React.createElement(
          "span",
          { className: "hb-think-live" },
          React.createElement(WhaleTail, { sdk })
        ) : null,
        React.createElement("span", { className: "hb-think-count" }, t.chars(trimmed.length)),
        // Collapsed, the segment is its own summary. The tail is the same string
        // that streams in, so the row stays one line as it updates.
        !open ? React.createElement("span", { className: "hb-think-tail" }, tail) : null
      ),
      open ? React.createElement("div", { className: "hb-think-body" }, trimmed) : null
    );
  }
  function MessageActions({
    sdk,
    item,
    locale,
    onBranch,
    onRegenerate,
    onCopy
  }) {
    const { React } = sdk;
    const { useState } = sdk.hooks;
    const [copied, setCopied] = useState(false);
    const t = messagesFor(locale);
    const stamp = messageStamp(item.completedAt ?? item.at, locale);
    const iconButton = (key, name, title, action) => React.createElement(
      "button",
      {
        key,
        type: "button",
        title,
        "aria-label": title,
        "data-hb": `msg-${key}`,
        className: "hb-action-btn",
        onClick: (event) => {
          event.stopPropagation();
          action();
        }
      },
      Icon(sdk, { name, size: 15 })
    );
    return React.createElement(
      "div",
      {
        className: "hb-actions flex items-center gap-1.5",
        "data-hb": "message-actions",
        style: { maxWidth: "min(72ch, 82%)" }
      },
      stamp ? React.createElement(
        "time",
        {
          className: "hb-text-micro tabular-nums",
          style: { color: "var(--color-muted-foreground)" },
          // The tooltip carries the turn's duration when the backend implied one.
          title: item.durationS ? t.turnDuration(formatElapsed(item.durationS)) : void 0
        },
        stamp
      ) : null,
      React.createElement(
        "div",
        { className: "hb-actions-tools ml-auto flex items-center gap-1" },
        onBranch ? iconButton("branch", "branch", t.branchNewChat, () => onBranch(item.id)) : null,
        onCopy ? iconButton("copy", copied ? "check" : "copy", copied ? t.copied : t.copy, () => {
          onCopy(item.text);
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1500);
        }) : null,
        onRegenerate ? iconButton("regen", "redo", t.refresh, () => onRegenerate(item.id)) : null
      )
    );
  }
  function AssistantBubble({
    sdk,
    item,
    locale,
    onBranch,
    onRegenerate,
    onCopy
  }) {
    const { React } = sdk;
    const errorColor = "var(--color-destructive)";
    const hasText = item.text.trim().length > 0;
    if (!hasText && !item.error) return null;
    const t = messagesFor(locale);
    return React.createElement(
      "div",
      { className: "flex flex-col items-start" },
      hasText ? React.createElement(
        "div",
        {
          className: "break-words px-3 py-2 text-sm leading-relaxed hb-bubble-text",
          style: {
            maxWidth: "min(72ch, 82%)",
            background: "var(--color-card)",
            color: "var(--color-card-foreground)",
            borderRadius: ASSISTANT_RADIUS,
            boxShadow: "inset 0 0 0 1px var(--color-border)"
          }
        },
        // The reply is Markdown. The caret rides inside the last block so a slow
        // first token reads as work rather than a hang, without pushing a line.
        React.createElement(Markdown, { sdk, text: item.text, caret: Boolean(item.streaming), locale })
      ) : null,
      item.error ? React.createElement(
        "div",
        {
          className: "mt-1 px-3 py-1.5 text-xs",
          style: { maxWidth: "min(72ch, 82%)", color: errorColor }
        },
        item.error
      ) : null,
      item.usage ? React.createElement(
        "div",
        {
          className: "hb-text-tiny hb-mt-sm tabular-nums",
          style: { color: "var(--color-muted-foreground)" }
        },
        [
          item.usage.total ? `${formatCount(item.usage.total)} tokens` : "",
          item.usage.context_percent ? t.contextPercent(item.usage.context_percent) : ""
        ].filter(Boolean).join(" \xB7 ")
      ) : null,
      // Actions only on a settled reply: mid-stream there is nothing to copy or
      // regenerate yet, and the desktop app's own bar is transient for the same reason.
      hasText && !item.streaming && (onBranch || onRegenerate || onCopy) ? React.createElement(MessageActions, { sdk, item, locale, onBranch, onRegenerate, onCopy }) : null
    );
  }
  function ToolRow({ sdk, item, locale }) {
    const { React } = sdk;
    const { useState } = sdk.hooks;
    const [open, setOpen] = useState(false);
    const t = messagesFor(locale);
    const preview = toolPreview(item.resultText);
    const argsText = item.argsText ?? (item.args ? JSON.stringify(item.args, null, 2) : "");
    const duration = formatDuration(item.durationS);
    return React.createElement(
      "div",
      {
        className: "hb-tool",
        "data-hb": "tool-row",
        "data-status": item.status,
        "data-name": item.name
      },
      React.createElement(
        "button",
        {
          type: "button",
          className: "hb-tool-head",
          "data-hb": "tool-toggle",
          "data-open": open ? "true" : "false",
          "aria-expanded": open ? "true" : "false",
          onClick: () => setOpen((v) => !v)
        },
        React.createElement("span", { className: "hb-tool-caret" }, Icon(sdk, { name: "chevron", size: 13 })),
        React.createElement("span", { className: "hb-tool-name" }, toolLabel(item.name, t)),
        item.status === "running" ? React.createElement(
          "span",
          { className: "hb-tool-live" },
          React.createElement(WhaleTail, { sdk })
        ) : null,
        item.summary ? React.createElement("span", { className: "hb-tool-summary" }, item.summary) : null,
        duration ? React.createElement("span", { className: "hb-tool-duration tabular-nums" }, duration) : null
      ),
      item.risk ? React.createElement(
        "div",
        { className: "hb-tool-risk" },
        t.outputRisk(item.risk)
      ) : null,
      open ? React.createElement(
        "div",
        { className: "hb-tool-body" },
        argsText ? React.createElement("pre", { className: "hb-output hb-tool-pre" }, argsText) : null,
        preview.text ? React.createElement(
          "pre",
          { className: "hb-output hb-tool-pre" },
          preview.text + (preview.truncated ? "\n\u2026" : "")
        ) : null
      ) : null
    );
  }
  function SubagentsCard({ sdk, item, locale }) {
    const { React } = sdk;
    const { useState } = sdk.hooks;
    const t = messagesFor(locale);
    const [open, setOpen] = useState(false);
    const [expanded, setExpanded] = useState({});
    const done = item.children.filter((child) => isSubagentTerminal(child.status)).length;
    const total = item.children.length;
    const running = item.children.some((child) => child.status === "running" || child.status === "queued");
    const failed = item.children.some(
      (child) => child.status === "failed" || child.status === "error" || child.status === "timeout"
    );
    const stripe = failed ? "var(--color-destructive)" : running ? "var(--color-ring)" : "var(--color-border)";
    const toneOf = (status) => {
      if (status === "running") return "var(--color-primary)";
      if (status === "failed" || status === "error" || status === "timeout" || status === "interrupted") {
        return "var(--color-destructive)";
      }
      return "var(--color-muted-foreground)";
    };
    const childRow = (child) => {
      const isOpen = Boolean(expanded[child.key]);
      const duration = formatDuration(child.durationS);
      const detail = [];
      if (child.lastTool) {
        detail.push(
          React.createElement(
            "div",
            { key: "tool", className: "hb-sub-detail" },
            `${toolLabel(child.lastTool, t)}${child.toolCount ? ` \xB7 ${t.subagentTools(child.toolCount)}` : ""}`
          )
        );
      }
      if (child.thinking && !child.summary) {
        detail.push(
          React.createElement("div", { key: "think", className: "hb-sub-detail hb-sub-think" }, child.thinking)
        );
      }
      if (child.progress.length) {
        detail.push(
          React.createElement(
            "div",
            { key: "progress", className: "hb-sub-progress" },
            child.progress.map(
              (line, index) => React.createElement("div", { key: `p${index}`, className: "hb-sub-line" }, line)
            )
          )
        );
      }
      if (child.summary) {
        detail.push(
          React.createElement("div", { key: "summary", className: "hb-sub-summary" }, child.summary)
        );
      }
      if (child.tokens && (child.tokens.input || child.tokens.output)) {
        detail.push(
          React.createElement(
            "div",
            { key: "tokens", className: "hb-sub-detail" },
            `${child.tokens.input ?? 0} \u2192 ${child.tokens.output ?? 0} tokens`
          )
        );
      }
      const files = [...child.filesWritten ?? [], ...child.filesRead ?? []];
      if (files.length) {
        detail.push(
          React.createElement(
            "div",
            { key: "files", className: "hb-sub-detail" },
            files.slice(0, 6).join(" \xB7 ") + (files.length > 6 ? " \u2026" : "")
          )
        );
      }
      return React.createElement(
        "div",
        { key: child.key, className: "hb-sub-child", "data-hb": "subagent-row", "data-status": child.status },
        React.createElement(
          "button",
          {
            type: "button",
            className: "hb-sub-row",
            "data-hb": "subagent-row-toggle",
            "data-open": isOpen ? "true" : "false",
            "aria-expanded": isOpen ? "true" : "false",
            onClick: () => setExpanded((prev) => ({ ...prev, [child.key]: !prev[child.key] }))
          },
          React.createElement("span", { className: "hb-sub-caret" }, Icon(sdk, { name: "chevron", size: 13 })),
          React.createElement("span", { className: "hb-sub-index" }, `${child.taskIndex + 1}`),
          React.createElement(
            "span",
            { className: "hb-sub-goal hb-truncate" },
            child.goal || t.subagents
          ),
          React.createElement(
            "span",
            { className: "hb-sub-status", style: { color: toneOf(child.status) } },
            t.subagentStatus(child.status)
          ),
          child.status === "running" ? React.createElement("span", { className: "hb-caret hb-sub-live", style: { color: "var(--color-primary)" } }, "\u25CF") : null,
          duration ? React.createElement("span", { className: "hb-sub-duration tabular-nums" }, duration) : null
        ),
        isOpen && detail.length ? React.createElement("div", { className: "hb-sub-body" }, detail) : null
      );
    };
    return React.createElement(
      "div",
      { className: "hb-sub-card", "data-hb": "subagent-card", style: { borderLeftColor: stripe } },
      React.createElement(
        "button",
        {
          type: "button",
          className: "hb-sub-head",
          "data-hb": "subagent-toggle",
          "data-open": open ? "true" : "false",
          "aria-expanded": open ? "true" : "false",
          onClick: () => setOpen((v) => !v)
        },
        React.createElement("span", { className: "hb-sub-caret" }, Icon(sdk, { name: "chevron", size: 13 })),
        React.createElement("span", { className: "hb-sub-title" }, t.subagents),
        running ? React.createElement("span", { className: "hb-caret hb-sub-live", style: { color: "var(--color-primary)" } }, "\u25CF") : null,
        React.createElement("span", { className: "hb-sub-count" }, t.subagentProgress(done, total))
      ),
      open ? React.createElement("div", { className: "hb-sub-list" }, item.children.map(childRow)) : null
    );
  }
  function NoticeRow({ sdk, item, locale }) {
    const { React } = sdk;
    const t = messagesFor(locale);
    const label = noticeText(item, locale);
    return React.createElement(
      "div",
      {
        // Machinery notices are a one-line marker, not a message: keep them on the
        // same left rhythm as tool rows so a long session does not read as a
        // sequence of walls of monospace log.
        className: "px-3 py-1.5 text-xs",
        "data-hb": item.noticeKind ? "machinery-notice" : "notice",
        "data-notice-kind": item.noticeKind,
        title: item.detail || void 0,
        style: {
          maxWidth: "min(72ch, 82%)",
          color: item.tone === "error" ? "var(--color-destructive)" : "var(--color-muted-foreground)"
        }
      },
      // An error frame can arrive with no message at all; an empty red row would
      // read as a rendering bug, so fall back to a sentence from the catalog.
      label || (item.tone === "error" ? t.genericError : "")
    );
  }
  function Bubble(props) {
    const { sdk, item, locale } = props;
    switch (item.kind) {
      case "user":
        return UserBubble({ sdk, item, locale, onEdit: props.onEdit });
      case "assistant":
        return AssistantBubble({
          sdk,
          item,
          locale,
          onBranch: props.onBranch,
          onRegenerate: props.onRegenerate,
          onCopy: props.onCopy
        });
      case "tool":
        return ToolRow({ sdk, item, locale });
      case "reasoning":
        return ReasoningRow({ sdk, item, locale });
      case "subagents":
        return SubagentsCard({ sdk, item, locale });
      case "notice":
        return NoticeRow({ sdk, item, locale });
    }
  }

  // src/ui/Activity.ts
  var ACTIVITY_MAX_PX = 190;
  function ActivityBlock({ sdk, items, locale }) {
    const { React } = sdk;
    const { useState, useMemo, useEffect, useRef } = sdk.hooks;
    const t = messagesFor(locale);
    const [open, setOpen] = useState(false);
    const bodyRef = useRef(null);
    const [now, setNow] = useState(() => Date.now());
    const live = runIsLive(items);
    const counts = useMemo(() => runCounts(items), [items]);
    const summary = activitySummary(counts, t);
    const elapsed = formatElapsed((runElapsedMs(items, now) ?? 0) / 1e3);
    useEffect(() => {
      if (!live) return void 0;
      setNow(Date.now());
      const handle = window.setInterval(() => setNow(Date.now()), 1e3);
      return () => window.clearInterval(handle);
    }, [live]);
    useEffect(() => {
      const el = bodyRef.current;
      if (!el || !open) return;
      el.scrollTop = 0;
    }, [open]);
    return React.createElement(
      "div",
      {
        className: "hb-act",
        "data-hb": "activity-block",
        "data-open": open ? "true" : "false",
        "data-live": live ? "true" : "false",
        // The ceiling is on the BLOCK, not on the body: a header line plus a
        // 190px body would measure 205 and quietly break the promise. One number,
        // and it is the height the reader actually sees.
        style: open ? void 0 : { maxHeight: `${ACTIVITY_MAX_PX}px` }
      },
      React.createElement(
        "button",
        {
          type: "button",
          className: "hb-act-head",
          "data-hb": "activity-toggle",
          "data-open": open ? "true" : "false",
          "aria-expanded": open ? "true" : "false",
          title: open ? t.activityCollapse : t.activityExpand,
          onClick: () => setOpen((value) => !value)
        },
        React.createElement("span", { className: "hb-act-caret" }, Icon(sdk, { name: "chevron", size: 13 })),
        live ? React.createElement(
          "span",
          { className: "hb-act-live" },
          React.createElement("span", { className: "hb-act-dot" })
        ) : null,
        React.createElement("span", { className: "hb-act-summary" }, summary),
        elapsed ? React.createElement("span", { className: "hb-act-elapsed tabular-nums" }, elapsed) : null
      ),
      React.createElement(
        "div",
        {
          className: "hb-act-body",
          ref: bodyRef,
          // Collapsed, the rows are decoration: visible, unable to take focus and
          // unable to be clicked. `inert` is the only attribute that does all
          // three, and it is what keeps a call's controls from being tabbed to
          // under a clip the user cannot see the whole of.
          inert: open ? void 0 : true,
          "aria-hidden": open ? void 0 : "true",
          "data-hb-locked": open ? void 0 : "true"
        },
        // No `data-hb-kind` on these wrappers: the block IS the transcript row
        // here, and a child claiming a kind would make `querySelectorAll(
        // '[data-hb-kind]')` report the run's insides as top-level items.
        items.map((item) => React.createElement(Bubble, { key: item.id, sdk, item, locale }))
      )
    );
  }

  // src/core/autosize.ts
  function fitComposerHeight(contentHeight, limits) {
    const ceiling = Math.max(limits.min, limits.max);
    const measured = Number.isFinite(contentHeight) && contentHeight > 0 ? Math.ceil(contentHeight) : limits.min;
    const height = Math.min(Math.max(measured, limits.min), ceiling);
    return { height, scrolls: measured > ceiling };
  }

  // src/core/metrics.ts
  function compactNumber(value) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return "";
    if (value < 1e3) return String(Math.round(value));
    if (value < 1e4) return `${(value / 1e3).toFixed(1)}k`;
    if (value < 1e6) return `${Math.round(value / 1e3)}k`;
    return `${(value / 1e6).toFixed(1)}M`;
  }
  function contextLabel(usage) {
    if (!usage) return "";
    if (usage.context_max) {
      const used = compactNumber(usage.context_used ?? 0);
      const max = compactNumber(usage.context_max);
      return `${usage.context_estimated ? "~" : ""}${used}/${max}`;
    }
    return usage.total && usage.total > 0 ? `${compactNumber(usage.total)} tok` : "";
  }
  function contextBar(percent, cells = 10) {
    if (typeof percent !== "number" || !Number.isFinite(percent)) return "";
    const clamped = Math.max(0, Math.min(100, percent));
    const filled = Math.round(clamped / 100 * cells);
    return "\u2593".repeat(filled) + "\u2591".repeat(Math.max(0, cells - filled));
  }
  function contextBarLabel(usage) {
    if (!usage?.context_max) return "";
    const pct = Math.max(0, Math.min(100, Math.round(usage.context_percent ?? 0)));
    return `[${contextBar(usage.context_percent)}] ${usage.context_estimated ? "~" : ""}${pct}%`;
  }
  function cacheHitLabel(usage) {
    const pct = usage?.cache_hit_pct;
    return typeof pct === "number" && Number.isFinite(pct) ? `${Math.round(pct)}%` : "";
  }
  function tokensPerSecondLabel(usage) {
    const tps = usage?.avg_tps;
    return typeof tps === "number" && Number.isFinite(tps) && tps > 0 ? `${Math.round(tps)} t/s` : "";
  }
  function costLabel(usage) {
    const cost = usage?.cost_usd;
    if (typeof cost !== "number" || !Number.isFinite(cost)) return "";
    if (cost === 0) return "$0";
    if (cost < 1) return `$${cost.toFixed(4)}`;
    return `$${cost.toFixed(2)}`;
  }
  function metricChips(usage, t) {
    if (!usage) return [];
    const chips = [];
    const ctx = contextBarLabel(usage);
    if (ctx) chips.push({ key: "context", label: ctx, title: t.metricContextTitle(contextLabel(usage)) });
    const cache = cacheHitLabel(usage);
    if (cache) chips.push({ key: "cache", label: `\u26A1${cache}`, title: t.metricCacheTitle });
    const tps = tokensPerSecondLabel(usage);
    if (tps) chips.push({ key: "tps", label: tps, title: t.metricTpsTitle });
    const cost = costLabel(usage);
    if (cost) chips.push({ key: "cost", label: cost, title: t.metricCostTitle });
    return chips;
  }
  function pressureTone(percent) {
    if (percent === null) return "calm";
    if (percent >= 90) return "critical";
    if (percent >= 70) return "warn";
    return "calm";
  }

  // src/ui/GitBadge.ts
  function GitBadge(props) {
    const { React } = props.sdk;
    const info = props.info;
    if (!info) return null;
    const t = messagesFor(props.locale);
    const changed = changedCount(info);
    const counts = [];
    if (info.staged) counts.push(t.gitStaged(info.staged));
    if (info.unstaged) counts.push(t.gitUnstaged(info.unstaged));
    if (info.untracked) counts.push(t.gitUntracked(info.untracked));
    if (info.conflicts) counts.push(t.gitConflicts(info.conflicts));
    const lines = [
      info.root,
      info.detached ? `${t.gitDetached} (${gitBranchLabel(info)})` : gitBranchLabel(info),
      counts.length ? counts.join(" \xB7 ") : t.gitClean
    ];
    if (info.ahead) lines.push(t.gitAhead(info.ahead));
    if (info.behind) lines.push(t.gitBehind(info.behind));
    if (info.truncated) lines.push(t.gitTruncated);
    lines.push(t.gitRefresh);
    const title = lines.filter(Boolean).join("\n");
    return React.createElement(
      "button",
      {
        type: "button",
        "data-hb": "git-badge",
        title,
        "aria-label": title,
        className: "hb-git-badge",
        style: { color: "var(--color-muted-foreground)" },
        onClick: props.onRefresh
      },
      React.createElement("span", { className: "hb-git-mark" }, "\u2387"),
      React.createElement("span", { className: "hb-git-branch" }, gitBranchLabel(info)),
      changed > 0 ? React.createElement(
        "span",
        {
          className: "hb-git-changed",
          // Dirty is the one thing worth colouring: a warning tone the host
          // actually defines (an undefined var here drops the declaration).
          style: { color: "var(--color-warning)" }
        },
        info.truncated ? `${changed}+` : String(changed)
      ) : null,
      info.ahead > 0 ? React.createElement("span", { className: "hb-git-track" }, `\u2191${info.ahead}`) : null,
      info.behind > 0 ? React.createElement("span", { className: "hb-git-track" }, `\u2193${info.behind}`) : null
    );
  }

  // src/ui/WorkspacePicker.tsx
  function WorkspacePicker(props) {
    const { sdk } = props;
    const { React } = sdk;
    const { useState } = sdk.hooks;
    const t = messagesFor(props.locale);
    const [open, setOpen] = useState(false);
    const [customOpen, setCustomOpen] = useState(false);
    const [draft, setDraft] = useState(props.value);
    const live = props.current.trim();
    const shown = live || props.value;
    const label = workspaceLabel(shown, props.options, props.home, t.workspaceDefault);
    const title = live ? `${t.workspaceSessionCwd}: ${live}` : props.value ? `${t.workspaceForNewChat}: ${props.value}` : `${t.workspaceForNewChat}: ${t.workspaceDefault}`;
    const choose = (cwd) => {
      props.onPick(cwd);
      setOpen(false);
      setCustomOpen(false);
    };
    const commitDraft = () => {
      const trimmed = draft.trim();
      if (trimmed) choose(trimmed);
    };
    const row = (key, text, hint, active, onSelect, hook = "workspace-option") => React.createElement(
      "button",
      {
        key,
        type: "button",
        "data-hb": hook,
        title: hint || text,
        className: "hb-workspace-row",
        style: {
          background: active ? "var(--color-accent, var(--color-muted))" : "transparent",
          color: "var(--color-card-foreground)"
        },
        onClick: onSelect
      },
      React.createElement("span", { className: "hb-workspace-name" }, text),
      hint ? React.createElement("span", { className: "hb-workspace-hint" }, hint) : null,
      active ? React.createElement(
        "span",
        { className: "hb-workspace-check" },
        Icon(props.sdk, { name: "check", size: 13 })
      ) : null
    );
    return React.createElement(
      "div",
      { className: "hb-workspace-wrap" },
      React.createElement(
        "button",
        {
          type: "button",
          "data-hb": "workspace-button",
          title,
          "aria-label": title,
          "aria-expanded": open,
          className: "hb-workspace-chip",
          "data-open": open ? "true" : "false",
          style: { color: "var(--color-muted-foreground)" },
          onClick: () => {
            setOpen((prev) => !prev);
            setCustomOpen(false);
            setDraft(props.value);
          }
        },
        React.createElement("span", { className: "hb-workspace-caret" }, Icon(sdk, { name: "chevron", size: 12 })),
        React.createElement("span", { className: "hb-workspace-chip-label" }, label)
      ),
      // Git state of that same directory, immediately to the right of the chip.
      // Renders nothing outside a repository — see GitBadge.
      React.createElement(GitBadge, {
        sdk,
        locale: props.locale,
        info: props.git,
        loading: props.gitLoading,
        onRefresh: props.onRefreshGit
      }),
      // Backdrop: clicking anywhere outside closes, without a document listener
      // that would have to be torn down on unmount.
      open ? React.createElement("div", {
        className: "hb-workspace-backdrop",
        onClick: () => {
          setOpen(false);
          setCustomOpen(false);
        }
      }) : null,
      open ? React.createElement(
        "div",
        { "data-hb": "workspace-panel", className: "hb-workspace-panel hb-scroll" },
        React.createElement(
          "div",
          { className: "hb-workspace-head" },
          React.createElement("span", null, t.workspace),
          React.createElement(
            "button",
            {
              type: "button",
              "data-hb": "workspace-rescan",
              className: "hb-workspace-rescan",
              title: t.workspaceRescan,
              onClick: props.onRescan
            },
            props.loading ? React.createElement("span", { className: "hb-workspace-rescan-busy" }, "\u2026") : Icon(sdk, { name: "refresh", size: 14 })
          )
        ),
        props.failed ? React.createElement("div", { className: "hb-workspace-note" }, t.workspaceLoadFailed) : null,
        row("ws-default", t.workspaceDefault, "", !props.value, () => choose("")),
        props.options.map(
          (option) => row(
            `ws-${option.value}`,
            option.label,
            option.hint,
            option.value === props.value,
            () => choose(option.value)
          )
        ),
        // A persisted path that is no longer in the list (repo deleted, scan
        // off) still has to render as the selection instead of vanishing.
        props.value && !props.options.some((option) => option.value === props.value) ? row("ws-stale", abbreviateHomePath(props.value, props.home), "", true, () => choose(props.value)) : null,
        customOpen ? React.createElement(
          "div",
          { className: "hb-workspace-custom" },
          React.createElement("input", {
            autoFocus: true,
            value: draft,
            "data-hb": "workspace-custom",
            placeholder: props.home ? `${props.home}/\u2026` : "/path/to/project",
            className: "hb-workspace-input",
            onChange: (event) => setDraft(event.target.value),
            onKeyDown: (event) => {
              if (event.key === "Enter") commitDraft();
              if (event.key === "Escape") setCustomOpen(false);
            }
          }),
          React.createElement(
            "button",
            {
              type: "button",
              "data-hb": "workspace-apply",
              className: "hb-workspace-apply",
              onClick: commitDraft
            },
            t.workspaceApply
          )
        ) : React.createElement(
          "button",
          {
            type: "button",
            "data-hb": "workspace-custom-open",
            className: "hb-workspace-row",
            style: { color: "var(--color-muted-foreground)" },
            onClick: () => {
              setDraft(props.value);
              setCustomOpen(true);
            }
          },
          React.createElement("span", { className: "hb-workspace-name" }, t.workspaceCustom)
        ),
        // The chip names where the OPEN chat lives and cannot be changed; the
        // rows above aim the NEXT one. Say so only while both exist, or the
        // panel reads as "move this chat" and nothing appears to happen.
        live ? React.createElement(
          "div",
          { className: "hb-workspace-note", "data-hb": "workspace-next-note" },
          `${t.workspaceForNewChat}: ${props.value ? abbreviateHomePath(props.value, props.home) : t.workspaceDefault}`
        ) : null
      ) : null
    );
  }

  // src/ui/ApprovalModeChip.ts
  var MODES = ["manual", "smart", "off"];
  function ApprovalModeChip(props) {
    const { React } = props.sdk;
    const { useState } = props.sdk.hooks;
    const t = messagesFor(props.locale);
    const [open, setOpen] = useState(false);
    const current = props.value || "smart";
    const label = approvalModeLabel(current, props.locale);
    const close = () => setOpen(false);
    return React.createElement(
      "div",
      { className: "hb-approval-wrap" },
      React.createElement(
        "button",
        {
          type: "button",
          "data-hb": "approval-mode",
          "data-mode": current,
          title: `${t.approvalModeTitle(label)} \xB7 ${t.approvalModeHint}`,
          "aria-haspopup": "listbox",
          "aria-expanded": open ? "true" : "false",
          className: "hb-approval-chip",
          style: { color: "var(--color-muted-foreground)" },
          onClick: () => setOpen((v) => !v)
        },
        React.createElement("span", { className: "hb-approval-caret" }, open ? "\u25BE" : "\u25B8"),
        React.createElement("span", null, t.approvalMode),
        React.createElement("span", { className: "hb-approval-sep" }, "\xB7"),
        React.createElement("span", { className: "hb-approval-val" }, label)
      ),
      // Click-anywhere-outside to dismiss, without a document listener to tear down.
      open ? React.createElement("div", { className: "hb-approval-backdrop", onClick: close }) : null,
      open ? React.createElement(
        "div",
        {
          className: "hb-approval-panel",
          "data-hb": "approval-panel",
          role: "listbox"
        },
        React.createElement("div", { className: "hb-approval-head" }, t.approvalModeHint),
        MODES.map(
          (mode) => React.createElement(
            "button",
            {
              key: mode,
              type: "button",
              "data-hb": "approval-option",
              "data-mode": mode,
              "data-active": mode === current ? "true" : "false",
              role: "option",
              "aria-selected": mode === current ? "true" : "false",
              className: "hb-approval-row",
              style: {
                background: mode === current ? "var(--color-accent, var(--color-muted))" : "transparent",
                color: "var(--color-card-foreground)"
              },
              onClick: () => {
                props.onChange(mode);
                setOpen(false);
              }
            },
            React.createElement("span", { className: "hb-approval-check" }, mode === current ? "\u2713" : ""),
            React.createElement("span", { className: "hb-approval-row-label" }, approvalModeLabel(mode, props.locale))
          )
        )
      ) : null
    );
  }

  // src/ui/Composer.ts
  var MENU_LIMIT = 200;
  var INPUT_MIN_PX = 32;
  var INPUT_MAX_PX = 192;
  function Composer(props) {
    const { sdk } = props;
    const { React } = sdk;
    const { useCallback, useEffect, useMemo, useRef, useState } = sdk.hooks;
    const t = messagesFor(props.locale);
    const [text, setText] = useState(props.editingText ?? "");
    const [caret, setCaret] = useState(0);
    const [menuIndex, setMenuIndex] = useState(0);
    const [menuDismissed, setMenuDismissed] = useState(false);
    const [toolsOpen, setToolsOpen] = useState(false);
    const inputRef = useRef(null);
    const fileRef = useRef(null);
    const appliedInsertion = useRef(0);
    const fitInput = useCallback(() => {
      const el = inputRef.current;
      if (!el) return;
      el.style.height = "auto";
      const fit = fitComposerHeight(el.scrollHeight, { min: INPUT_MIN_PX, max: INPUT_MAX_PX });
      el.style.height = `${fit.height}px`;
      el.style.overflowY = fit.scrolls ? "auto" : "hidden";
    }, []);
    React.useLayoutEffect(() => {
      fitInput();
    }, [text, fitInput]);
    useEffect(() => {
      window.addEventListener("resize", fitInput);
      return () => window.removeEventListener("resize", fitInput);
    }, [fitInput]);
    const slashToken = useMemo(() => findSlashToken(text, caret), [text, caret]);
    const items = useMemo(
      () => slashToken ? filterCommands(props.catalog, slashToken.query, MENU_LIMIT) : [],
      [slashToken, props.catalog]
    );
    const menuVisible = Boolean(slashToken && items.length && !menuDismissed);
    useEffect(() => {
      if (props.editingText == null) return;
      setText(props.editingText);
      setCaret(props.editingText.length);
      setMenuDismissed(true);
      requestAnimationFrame(() => {
        const el = inputRef.current;
        if (!el) return;
        el.focus();
        el.setSelectionRange(props.editingText.length, props.editingText.length);
      });
    }, [props.editingText]);
    useEffect(() => {
      const entry = props.insertion;
      if (!entry || entry.seq === appliedInsertion.current) return;
      appliedInsertion.current = entry.seq;
      const next = insertContext(text, entry.text);
      setText(next);
      setCaret(next.length);
      setMenuDismissed(true);
      requestAnimationFrame(() => {
        const el = inputRef.current;
        if (!el) return;
        el.focus();
        el.setSelectionRange(next.length, next.length);
      });
    }, [props.insertion, text]);
    useEffect(() => {
      setMenuIndex(0);
    }, [items.length, slashToken?.query]);
    const syncCaret = useCallback(() => {
      const el = inputRef.current;
      if (el) setCaret(el.selectionStart ?? el.value.length);
    }, []);
    const acceptCommand = useCallback(
      (entry) => {
        if (!slashToken) return;
        const next = applyCompletion(text, slashToken, entry.name);
        setText(next.text);
        setMenuDismissed(true);
        requestAnimationFrame(() => {
          const el = inputRef.current;
          if (el) {
            el.focus();
            el.setSelectionRange(next.caret, next.caret);
            setCaret(next.caret);
          }
        });
      },
      [slashToken, text]
    );
    const submit = useCallback(() => {
      const value = text.trim();
      const ready = messageAttachments(props.attachments);
      if (!value && !ready.length) return;
      setText("");
      setCaret(0);
      setMenuDismissed(false);
      props.onSend(value, ready);
    }, [text, props]);
    const onKeyDown = useCallback(
      (event) => {
        if (menuVisible) {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            setMenuIndex((i) => (i + 1) % items.length);
            return;
          }
          if (event.key === "ArrowUp") {
            event.preventDefault();
            setMenuIndex((i) => (i - 1 + items.length) % items.length);
            return;
          }
          if (event.key === "Tab" || event.key === "Enter") {
            event.preventDefault();
            const entry = items[menuIndex];
            if (entry) acceptCommand(entry);
            return;
          }
          if (event.key === "Escape") {
            event.preventDefault();
            setMenuDismissed(true);
            return;
          }
        }
        if (event.key === "Enter" && !event.shiftKey) {
          event.preventDefault();
          submit();
        }
      },
      [menuVisible, items, menuIndex, acceptCommand, submit]
    );
    const onPaste = useCallback(
      (event) => {
        const files = Array.from(event.clipboardData?.files ?? []);
        if (!files.length) return;
        event.preventDefault();
        props.onPickFiles(files);
      },
      [props]
    );
    const onDrop = useCallback(
      (event) => {
        const session = event.dataTransfer?.getData?.(SESSION_CONTEXT_MIME) ?? "";
        if (session) {
          event.preventDefault();
          props.onDropSession?.(session);
          return;
        }
        const files = Array.from(event.dataTransfer?.files ?? []);
        if (!files.length) return;
        event.preventDefault();
        props.onPickFiles(files);
      },
      [props]
    );
    const readyCount = props.attachments.filter((item) => item.status === "ready").length;
    const canSend = (Boolean(text.trim()) || readyCount > 0) && props.connected;
    const chips = metricChips(props.usage, t);
    const tone = pressureTone(null);
    const contextChip = chips.find((c) => c.key === "context");
    return React.createElement(
      "div",
      {
        // `hb-flex-none` (`flex: 0 0 auto`) is load-bearing: the composer is a
        // flex item in the page's column, and without it a tall transcript
        // squeezes this box below its own content — the metric line at the bottom
        // was the part that got cut off.
        className: "px-4 pb-3 hb-flex-none",
        onDrop,
        onDragOver: (event) => event.preventDefault()
      },
      React.createElement(
        "div",
        { className: "mx-auto", style: { maxWidth: "860px" } },
        // ── editing banner ───────────────────────────────────────────────────
        props.editingText != null ? React.createElement(
          "div",
          {
            className: "hb-edit-banner mb-1.5 flex items-center gap-2 px-2 py-1 hb-text-micro",
            "data-hb": "editing-banner",
            style: {
              background: "color-mix(in oklab, var(--color-primary) 12%, var(--color-card))",
              color: "var(--color-card-foreground)",
              borderRadius: "calc(var(--radius) * 0.6)"
            }
          },
          React.createElement("span", { className: "hb-flex-fill hb-truncate" }, t.editingHint),
          React.createElement(
            "button",
            {
              type: "button",
              className: "cursor-pointer px-1",
              style: { color: "var(--color-muted-foreground)" },
              onClick: () => {
                setText("");
                props.onCancelEdit?.();
              }
            },
            "\xD7"
          )
        ) : null,
        // ── attachment tray ──────────────────────────────────────────────────
        // Each entry reports where its staging is (reading off disk → uploading
        // over the socket), which is the part that used to be a silent "…" over a
        // remote dashboard.
        React.createElement(AttachmentTray, {
          sdk,
          locale: props.locale,
          items: props.attachments,
          onRemove: props.onRemoveAttachment
        }),
        // ── slash popover ────────────────────────────────────────────────────
        menuVisible ? React.createElement(
          "div",
          {
            className: "mb-1.5 max-h-64 overflow-y-auto py-1 hb-scroll",
            style: {
              background: "var(--color-popover, var(--color-card))",
              borderRadius: "var(--radius)",
              boxShadow: "inset 0 0 0 1px var(--color-border)"
            }
          },
          items.map(
            (entry, index) => React.createElement(
              "button",
              {
                key: `${entry.kind}:${entry.name}`,
                type: "button",
                className: "flex w-full cursor-pointer items-baseline gap-2 px-3 py-1.5 text-left text-xs",
                style: {
                  background: index === menuIndex ? "var(--color-accent, var(--color-muted))" : "transparent",
                  color: "var(--color-card-foreground)"
                },
                onMouseEnter: () => setMenuIndex(index),
                onClick: () => acceptCommand(entry)
              },
              React.createElement("span", { className: "hb-mono" }, `/${entry.name}`),
              entry.kind === "skill" ? React.createElement(
                "span",
                {
                  className: "hb-text-tiny px-1",
                  style: {
                    background: "var(--color-muted)",
                    borderRadius: "3px",
                    color: "var(--color-muted-foreground)"
                  }
                },
                "skill"
              ) : null,
              React.createElement(
                "span",
                { className: "hb-truncate hb-flex-fill", style: { color: "var(--color-muted-foreground)" } },
                entry.kind === "skill" ? entry.origin ? t.skillOrigin(entry.origin) : t.skill : entry.description
              )
            )
          )
        ) : null,
        // ── tool menu ────────────────────────────────────────────────────────
        // Model, reasoning strength and notifications. One row each, because
        // these are full sentences rather than pills (铁律 20), and because an
        // inline model chip is what used to squeeze the textarea to four
        // characters on a narrow screen. Same control on both layouts: a phone
        // and a desktop should not teach two different ways to switch models.
        toolsOpen ? React.createElement(
          "div",
          { className: "hb-tools-menu", "data-hb": "composer-menu" },
          React.createElement(
            "div",
            { className: "hb-tools-head" },
            React.createElement("span", null, t.composerMore),
            React.createElement(
              "button",
              {
                type: "button",
                className: "hb-tools-close",
                title: t.cancel,
                "aria-label": t.cancel,
                onClick: () => setToolsOpen(false)
              },
              Icon(sdk, { name: "close", size: 14 })
            )
          ),
          React.createElement(
            "button",
            {
              type: "button",
              "data-hb": "model-picker-open",
              className: "hb-tools-row",
              onClick: () => {
                setToolsOpen(false);
                props.onOpenModelPicker();
              }
            },
            React.createElement("span", { className: "hb-tools-icon" }, Icon(sdk, { name: "model", size: 16 })),
            React.createElement("span", { className: "hb-tools-label" }, t.pickModel),
            React.createElement(
              "span",
              { className: "hb-tools-value hb-truncate" },
              props.model || "default"
            ),
            Icon(sdk, { name: "chevron", size: 14, className: "hb-tools-chevron" })
          ),
          React.createElement(
            "button",
            {
              type: "button",
              "data-hb": "reasoning-cycle",
              "data-state": reasoningLabel(props.reasoning || "medium", props.locale),
              className: "hb-tools-row",
              onClick: () => {
                const current = props.reasoning || "medium";
                const index = REASONING_LEVELS.indexOf(current);
                const next = REASONING_LEVELS[(index + 1) % REASONING_LEVELS.length];
                if (next) props.onPickReasoning(next);
              }
            },
            React.createElement("span", { className: "hb-tools-icon" }, Icon(sdk, { name: "reasoning", size: 16 })),
            React.createElement("span", { className: "hb-tools-label" }, t.reasoning),
            React.createElement(
              "span",
              { className: "hb-tools-value" },
              reasoningLabel(props.reasoning || "medium", props.locale)
            ),
            Icon(sdk, { name: "chevron", size: 14, className: "hb-tools-chevron" })
          ),
          React.createElement(
            "button",
            {
              type: "button",
              "data-hb": "notify-toggle",
              "data-on": props.notifyState === "on" ? "true" : "false",
              "data-state": props.notifyState,
              className: "hb-tools-row",
              onClick: props.onToggleNotify
            },
            React.createElement(
              "span",
              { className: "hb-tools-icon" },
              Icon(sdk, { name: props.notifyState === "on" ? "bell" : "bellOff", size: 16 })
            ),
            React.createElement("span", { className: "hb-tools-label" }, t.notifications),
            React.createElement(
              "span",
              { className: "hb-tools-value" },
              props.notifyState === "on" || props.notifyState === "needs-permission" ? t.notifyOnTitle : t.notifyOffTitle
            )
          )
        ) : null,
        // ── input row ────────────────────────────────────────────────────────
        // `items-center`, not `items-end`: the row's controls are round buttons
        // now, and the textarea's own padding used to make a one-line draft sit
        // low against a bottom-aligned row. Centring puts the glyph's optical
        // middle on the text's, at one line and at eight.
        React.createElement(
          "div",
          {
            className: "hb-composer-row flex items-center gap-1.5 px-2 py-1.5",
            style: {
              background: "var(--color-card)",
              borderRadius: "var(--radius)",
              boxShadow: "inset 0 0 0 1px var(--color-border)"
            }
          },
          // ── left: the tool menu ─────────────────────────────────────────────
          React.createElement(
            "button",
            {
              type: "button",
              "data-hb": "composer-more",
              "data-open": toolsOpen ? "true" : "false",
              "aria-expanded": toolsOpen,
              "aria-label": t.composerMore,
              title: t.composerMore,
              className: "hb-composer-btn hb-composer-more",
              onClick: () => setToolsOpen((v) => !v)
            },
            Icon(sdk, { name: "dots", size: 18 })
          ),
          React.createElement("input", {
            ref: fileRef,
            type: "file",
            multiple: true,
            className: "hidden",
            onChange: (event) => {
              if (event.target.files?.length) props.onPickFiles(event.target.files);
              event.target.value = "";
            }
          }),
          // center: the textarea
          React.createElement("textarea", {
            ref: inputRef,
            value: text,
            rows: 1,
            disabled: !props.connected,
            placeholder: props.connected ? props.mobile ? t.composerPlaceholderShort : t.composerPlaceholder : "\u2026",
            "aria-label": t.composerPlaceholder,
            className: "hb-resize-none hb-min-h-input hb-composer-input flex-1 bg-transparent text-sm outline-none",
            // `--font-sans` is the host's display face ("Collapse", a narrow
            // serif) and is NOT what body text uses — `html`/`body` take
            // `--theme-font-sans`, the system UI stack. Pointing the textarea at
            // the display face made every Latin character thin and hard to read at
            // typing size, so the draft now matches the rest of the dashboard.
            style: {
              color: "var(--color-card-foreground)",
              fontFamily: "var(--theme-font-sans, system-ui, -apple-system, 'Segoe UI', sans-serif)"
            },
            onChange: (event) => {
              setText(event.target.value);
              setCaret(event.target.selectionStart ?? event.target.value.length);
              setMenuDismissed(false);
            },
            onKeyUp: syncCaret,
            onClick: syncCaret,
            onKeyDown,
            onPaste
          }),
          // right: stop / upload / send, as round icon buttons on BOTH layouts.
          // The model and reasoning chips that used to sit here moved into the
          // "···" menu above, on both sizes, so the row is identical everywhere.
          React.createElement(
            "div",
            { className: "hb-composer-tools flex shrink-0 items-center gap-1" },
            // While a turn runs the primary action becomes "insert": the message is
            // delivered mid-turn (queued / steered / redirected by the backend).
            // Stop is a separate control so correcting and cancelling do not
            // compete for the same button.
            props.running ? React.createElement(
              "button",
              {
                type: "button",
                title: t.stopReasoningTitle,
                "aria-label": t.stop,
                "data-hb": "stop-action",
                className: "hb-composer-btn hb-round-btn hb-round-stop",
                onClick: props.onStop
              },
              Icon(sdk, { name: "stop", size: 15 })
            ) : null,
            React.createElement(
              "button",
              {
                type: "button",
                title: t.attachFiles,
                "aria-label": t.attachFiles,
                "data-hb": "composer-upload",
                className: "hb-composer-btn hb-round-btn",
                onClick: () => fileRef.current?.click()
              },
              Icon(sdk, { name: "paperclip", size: 17 })
            ),
            React.createElement(
              "button",
              {
                type: "button",
                disabled: !canSend,
                title: props.running ? t.insert : t.send,
                "aria-label": props.running ? t.insert : t.send,
                "data-hb": "primary-action",
                className: "hb-composer-btn hb-round-btn hb-round-send",
                style: {
                  background: props.running ? "var(--color-muted)" : "var(--color-primary)",
                  color: props.running ? "var(--color-card-foreground)" : "var(--color-primary-foreground)",
                  borderRadius: "9999px",
                  // `disabled:opacity-40` is absent from the host bundle, so the
                  // dimming is done here rather than hoped for.
                  opacity: canSend ? 1 : 0.4,
                  cursor: canSend ? "pointer" : "default"
                },
                onClick: submit
              },
              Icon(sdk, { name: props.running ? "insert" : "send", size: 18 })
            )
          )
        ),
        // One control strip under the box. Both chips describe "how the next
        // message / command behaves", not transcript content: the workspace chip
        // names where a NEW chat starts, the approval chip how guarded commands
        // are handled. They share a line — workspace left, approval pinned to the
        // right edge of the composer column, so the strip reads as one row of
        // composer furniture instead of two stacked half-rows.
        React.createElement(
          "div",
          { className: "hb-composer-chips" },
          React.createElement(WorkspacePicker, {
            sdk,
            locale: props.locale,
            value: props.workspace,
            current: props.workspaceCurrent,
            options: props.workspaceOptions,
            home: props.workspaceHome,
            loading: props.workspaceLoading,
            failed: props.workspaceFailed,
            git: props.git,
            gitLoading: props.gitLoading,
            onRefreshGit: props.onRefreshGit,
            onPick: props.onPickWorkspace,
            onRescan: props.onRescanWorkspaces
          }),
          React.createElement(ApprovalModeChip, {
            sdk,
            locale: props.locale,
            value: props.approvalMode,
            onChange: props.onApprovalModeChange
          })
        ),
        // ── status + metrics ─────────────────────────────────────────────────
        React.createElement(
          "div",
          {
            className: "hb-text-micro mt-1 flex items-center gap-3 px-1 tabular-nums",
            style: { color: "var(--color-muted-foreground)" }
          },
          props.status ? React.createElement("span", { className: "hb-truncate", title: props.status }, props.status) : null,
          React.createElement(
            "div",
            { className: "ml-auto flex items-center gap-3" },
            chips.map(
              (chip) => React.createElement(
                "span",
                {
                  key: chip.key,
                  title: chip.title,
                  style: chip.key === "context" && contextChip ? {
                    color: tone === "calm" ? "var(--color-muted-foreground)" : "var(--color-muted-foreground)"
                  } : void 0
                },
                chip.label
              )
            )
          )
        )
      )
    );
  }
  function screenDroppedFiles(files) {
    const list = Array.from(files);
    const { accepted, rejected } = screenFiles(
      list.map((file) => ({ name: file.name, size: file.size, type: file.type }))
    );
    const acceptedNames = new Set(accepted.map((a) => a.name));
    return {
      accepted: list.filter((file) => acceptedNames.has(file.name)).map((file, index) => ({ file, id: `att-${Date.now()}-${index}` })),
      rejected
    };
  }

  // src/ui/ConfirmDialog.ts
  function ConfirmDialog(props) {
    const { sdk } = props;
    const { React } = sdk;
    return React.createElement(
      "div",
      {
        className: "hb-modal-scrim fixed inset-0 z-50 flex items-start justify-center p-8",
        style: { background: "rgba(0,0,0,0.45)" },
        onClick: props.onCancel
      },
      React.createElement(
        "div",
        {
          className: "hb-modal-card hb-max-h-70vh flex w-full flex-col overflow-hidden",
          "data-hb": "model-confirm",
          role: "dialog",
          "aria-modal": "true",
          "aria-label": props.title,
          style: {
            maxWidth: "32rem",
            background: "var(--color-card)",
            color: "var(--color-card-foreground)",
            borderRadius: "var(--radius)",
            boxShadow: "0 12px 40px rgba(0,0,0,0.4)"
          },
          onClick: (event) => event.stopPropagation()
        },
        React.createElement(
          "div",
          { className: "flex items-center gap-2 border-b p-3", style: { borderColor: "var(--color-border)" } },
          React.createElement("span", { className: "text-xs font-medium" }, props.title),
          React.createElement(
            "button",
            {
              type: "button",
              "data-hb": "model-confirm-close",
              className: "ml-auto cursor-pointer px-2 text-sm",
              style: { color: "var(--color-muted-foreground)" },
              onClick: props.onCancel
            },
            "\xD7"
          )
        ),
        // The backend's message is prose with blank lines between the guard's own
        // text and the switch's warning, so it is rendered as-is, preserving
        // newlines, instead of being flattened into one line.
        React.createElement(
          "div",
          {
            className: "min-h-0 flex-1 overflow-y-auto p-3 text-xs hb-scroll",
            style: { whiteSpace: "pre-wrap", lineHeight: 1.5, color: "var(--color-muted-foreground)" }
          },
          props.message
        ),
        React.createElement(
          "div",
          { className: "hb-choice-col p-3", style: { borderTop: "1px solid var(--color-border)" } },
          React.createElement(
            "button",
            {
              type: "button",
              "data-hb": "model-confirm-accept",
              className: "hb-action-btn-text hb-choice-row",
              style: {
                background: "var(--color-primary)",
                color: "var(--color-primary-foreground)",
                borderRadius: "calc(var(--radius) * 0.6)"
              },
              onClick: props.onAccept
            },
            props.acceptLabel
          ),
          React.createElement(
            "button",
            {
              type: "button",
              "data-hb": "model-confirm-cancel",
              className: "hb-action-btn-text hb-choice-row",
              style: {
                background: "var(--color-muted)",
                color: "var(--color-muted-foreground)",
                borderRadius: "calc(var(--radius) * 0.6)"
              },
              onClick: props.onCancel
            },
            props.cancelLabel
          )
        )
      )
    );
  }

  // src/ui/ProjectList.tsx
  function ProjectList(props) {
    const { sdk } = props;
    const { React } = sdk;
    const { useState } = sdk.hooks;
    const t = messagesFor(props.locale);
    const [expanded, setExpanded] = useState({});
    const [renamingId, setRenamingId] = useState(null);
    const [draft, setDraft] = useState("");
    const [menuId, setMenuId] = useState(null);
    const toggle = (row) => {
      const id = row.project.id;
      const next = !expanded[id];
      setExpanded((prev) => ({ ...prev, [id]: next }));
      if (next && !props.sessionCache[id]) props.onExpand(id);
    };
    const startRename = (project) => {
      setMenuId(null);
      setDraft(project.label);
      setRenamingId(project.id);
    };
    const commitRename = (project, value) => {
      const next = value.trim();
      setRenamingId(null);
      if (!next || next === project.label) return;
      props.onRename(project.id, next);
    };
    const sessionRow = (row) => {
      const isOpen = props.openStoredIds.includes(row.id);
      const isBusy = props.busyStoredIds.includes(row.id);
      const isActive = row.id === props.activeStoredId;
      const title = row.title || row.id.slice(0, 8);
      return React.createElement(
        "div",
        {
          key: row.id,
          "data-hb": "project-session",
          className: "hb-proj-session",
          title: row.preview || title,
          // Drag source, same payload as the Recent tab: drop on the composer to
          // pull this transcript in as context. No hover button here — this view
          // deliberately keeps its rows to open/expand.
          draggable: true,
          onDragStart: (event) => {
            event.stopPropagation();
            const payload = sessionDragPayload({ id: row.id, title: row.title || "" });
            if (event.dataTransfer) {
              event.dataTransfer.setData(SESSION_CONTEXT_MIME, payload);
              event.dataTransfer.setData("text/plain", payload);
              event.dataTransfer.effectAllowed = "copy";
            }
          },
          style: { background: isActive ? "var(--color-muted)" : "transparent" },
          onClick: () => props.onOpen(row.id)
        },
        React.createElement(
          "span",
          { className: "hb-proj-session-title" },
          row.title || t.untitled
        ),
        isOpen ? React.createElement("span", {
          className: isBusy ? "hb-dot hb-caret" : "hb-dot",
          "data-hb": "session-active",
          "data-state": isBusy ? "busy" : "open",
          title: isBusy ? t.sessionRunning : t.sessionOpen,
          style: {
            width: "0.4rem",
            height: "0.4rem",
            borderRadius: "9999px",
            background: "var(--color-primary)",
            opacity: isActive ? 1 : 0.45
          }
        }) : null,
        React.createElement(
          "span",
          { className: "hb-proj-session-time", style: { color: "var(--color-muted-foreground)" } },
          relativeTime(lastActiveOf(row), sdk, props.locale)
        )
      );
    };
    if (props.loading) {
      return React.createElement(
        "div",
        { className: "hb-text-micro px-2 py-1", style: { color: "var(--color-muted-foreground)" } },
        t.historyLoading
      );
    }
    if (props.failed) {
      return React.createElement(
        "div",
        { className: "hb-text-micro px-2 py-1", style: { color: "var(--color-muted-foreground)" } },
        t.projectsFailed
      );
    }
    if (props.rows.length === 0) {
      return React.createElement(
        "div",
        { className: "hb-text-micro px-2 py-1", style: { color: "var(--color-muted-foreground)" } },
        t.noProjects
      );
    }
    return React.createElement(
      "div",
      { "data-hb": "project-list", className: "hb-proj-list" },
      props.hiddenCount > 0 ? (
        // A hide has to be reversible from somewhere, or a mistaken click is
        // permanent for this page. The desktop app puts Undo on an 8s toast; a
        // toast in a plugin panel has no host surface (and no notification
        // area), so the restore lives on the list itself and stays.
        React.createElement(
          "button",
          {
            type: "button",
            "data-hb": "project-restore-hidden",
            className: "hb-proj-more",
            style: { marginLeft: 0 },
            onClick: props.onRestoreHidden
          },
          t.projectRestoreHidden(props.hiddenCount)
        )
      ) : null,
      props.rows.map((row) => {
        const id = row.project.id;
        const isOpen = Boolean(expanded[id]);
        const hydrated = props.sessionCache[id];
        const sessions = isOpen && hydrated ? hydrated : row.preview;
        const count = row.project.sessionCount ?? row.project.sessionIds?.length ?? sessions.length;
        const more = count > sessions.length;
        const label = row.project.isNoProject ? t.ungrouped : row.project.label;
        const removal = projectRemoval(row.project);
        const renamable = canRenameProject(row.project);
        const isRenaming = renamingId === id;
        return React.createElement(
          "div",
          { key: id, className: "hb-proj", "data-hb": "project-row" },
          React.createElement(
            "div",
            { className: "hb-proj-head" },
            isRenaming ? (
              // The name becomes an input in place: a dialog for a one-field edit
              // costs a second surface to keep in step with this panel.
              React.createElement("input", {
                autoFocus: true,
                value: draft,
                "data-hb": "project-rename-input",
                className: "hb-input hb-flex-fill",
                style: { fontSize: "0.75rem", padding: "0.1rem 0.3rem" },
                onChange: (event) => setDraft(event.target.value),
                // Read the value off the element: React commits state on its own
                // schedule, so a fast type-then-Enter would otherwise commit the
                // previous value (the same trap the session rename row hit).
                onKeyDown: (event) => {
                  event.stopPropagation();
                  if (event.key === "Enter") {
                    event.preventDefault();
                    commitRename(row.project, event.currentTarget.value);
                  } else if (event.key === "Escape") {
                    event.preventDefault();
                    setRenamingId(null);
                  }
                },
                onBlur: (event) => commitRename(row.project, event.currentTarget.value)
              })
            ) : React.createElement(
              "button",
              {
                type: "button",
                "data-hb": "project-toggle",
                "data-open": isOpen ? "true" : "false",
                className: "hb-proj-toggle",
                title: label,
                onClick: () => toggle(row)
              },
              React.createElement("span", { className: "hb-proj-caret" }, Icon(sdk, { name: "chevron", size: 12 })),
              React.createElement(
                "span",
                {
                  className: "hb-proj-name",
                  style: {
                    color: row.project.isNoProject ? "var(--color-muted-foreground)" : "var(--color-card-foreground)"
                  }
                },
                label
              ),
              React.createElement("span", { className: "hb-proj-count" }, String(count))
            ),
            // "New chat here" is the reason this view exists beyond being a list:
            // it aims the next session at the project's folder.
            row.workspace ? React.createElement(
              "button",
              {
                type: "button",
                "data-hb": "project-new-chat",
                "data-hb-path": row.workspace,
                className: "hb-proj-new",
                title: `${t.newChatInProject}: ${row.workspace}`,
                "aria-label": t.newChatInProject,
                onClick: () => props.onNewChat(row.workspace)
              },
              "\uFF0B"
            ) : null,
            removal === "none" ? null : React.createElement(
              "button",
              {
                type: "button",
                "data-hb": "project-menu",
                "data-hb-project": id,
                "data-open": menuId === id ? "true" : "false",
                className: "hb-proj-new",
                title: t.projectMenu,
                "aria-label": t.projectMenu,
                "aria-expanded": menuId === id,
                onClick: () => setMenuId((current) => current === id ? null : id)
              },
              "\u22EF"
            )
          ),
          // The panel is IN FLOW, not absolutely positioned: `.hb-proj-list` is a
          // scrolling column, and an absolute popover inside it is clipped by the
          // scroll box (and can land off-screen on a phone). Expanding the row
          // costs a little height and cannot go wrong.
          menuId === id ? React.createElement(
            "div",
            { className: "hb-proj-menu", "data-hb": "project-menu-panel", role: "menu" },
            renamable ? React.createElement(
              "button",
              {
                type: "button",
                "data-hb": "project-rename",
                className: "hb-proj-menu-item",
                role: "menuitem",
                onClick: () => startRename(row.project)
              },
              t.rename
            ) : null,
            React.createElement(
              "button",
              {
                type: "button",
                "data-hb": "project-remove",
                className: "hb-proj-menu-item",
                role: "menuitem",
                title: removal === "delete" ? t.projectDeleteHint : t.projectHideHint,
                onClick: () => {
                  setMenuId(null);
                  const message = removal === "delete" ? t.projectDeleteConfirm : t.projectHideConfirm;
                  if (window.confirm(message)) props.onRemove(row.project);
                }
              },
              removal === "delete" ? t.delete : t.projectHide
            )
          ) : null,
          props.loadingProjectId === id && isOpen && !hydrated ? React.createElement(
            "div",
            { className: "hb-text-micro hb-proj-note", style: { color: "var(--color-muted-foreground)" } },
            t.historyLoading
          ) : null,
          sessions.length ? React.createElement(
            "div",
            { className: "hb-proj-body" },
            sessions.map((session) => sessionRow(session))
          ) : null,
          isOpen && more && !hydrated ? React.createElement(
            "button",
            {
              type: "button",
              "data-hb": "project-expand",
              className: "hb-proj-more",
              onClick: () => props.onExpand(id)
            },
            `${t.showAllSessions} \xB7 ${t.projectSessionCount(count)}`
          ) : null
        );
      })
    );
  }

  // src/ui/HistoryPanel.ts
  function relativeTime(seconds, sdk, locale) {
    if (!seconds) return "";
    const ms = seconds * 1e3;
    try {
      const formatted = sdk.utils.timeAgo(ms);
      if (formatted) return formatted;
    } catch {
    }
    const t = messagesFor(locale);
    const minutes = Math.round((Date.now() - ms) / 6e4);
    if (minutes < 60) return t.minutesAgo(minutes);
    const hours = Math.round(minutes / 60);
    if (hours < 24) return t.hoursAgo(hours);
    return t.daysAgo(Math.round(hours / 24));
  }
  function HistoryPanel(props) {
    const { sdk } = props;
    const { React } = sdk;
    const { useState, useEffect } = sdk.hooks;
    const t = messagesFor(props.locale);
    const [renamingId, setRenamingId] = useState(null);
    const [draft, setDraft] = useState("");
    const [menuId, setMenuId] = useState(null);
    const drawer = props.variant === "drawer";
    const [closing, setClosing] = useState(false);
    const requestClose = () => {
      try {
        if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
          props.onClose();
          return;
        }
      } catch {
      }
      setClosing(true);
      props.onClose();
    };
    useEffect(() => {
      if (props.open && closing) setClosing(false);
    }, [props.open, closing]);
    if (!props.open && !closing) return null;
    const menuItem = (key, hook, label, run, danger = false) => React.createElement(
      "button",
      {
        key,
        type: "button",
        "data-hb": hook,
        role: "menuitem",
        className: danger ? "hb-menu-item hb-menu-item-danger" : "hb-menu-item",
        onClick: (event) => {
          event.stopPropagation();
          setMenuId(null);
          run();
        }
      },
      label
    );
    return React.createElement(
      React.Fragment,
      null,
      // Backdrop. The desktop class is `display:none` above the breakpoint (it
      // exists for the old phone bottom-sheet); the drawer always has one, because
      // it covers the chat it belongs to.
      React.createElement("div", {
        className: drawer ? "hb-drawer-backdrop" : "hb-hist-backdrop",
        "data-hb": "history-backdrop",
        onClick: requestClose
      }),
      React.createElement(
        "div",
        {
          // One class per presentation, so the stylesheet owns both entries and
          // both exits instead of the component swapping a Tailwind string for a
          // class (the panel's own keyframe has to run on the same element that
          // carries `data-state`).
          className: drawer ? "hb-drawer" : "hb-hist-panel",
          "data-hb": "history-panel",
          "data-variant": props.variant,
          "data-state": closing ? "closing" : "open",
          // The exit ends the animation; `closing` is what keeps the panel mounted
          // until then, so clearing it here is the unmount. The event does not
          // bubble from the panel's children by default — `stopPropagation` is
          // defensive, and `closing` is only cleared for the two exit animations
          // this panel actually plays.
          onAnimationEnd: (event) => {
            if (event.animationName !== "hb-slide-out-right" && event.animationName !== "hb-panel-out") {
              return;
            }
            event.stopPropagation?.();
            setClosing(false);
          }
        },
        React.createElement(
          "div",
          { className: drawer ? "hb-drawer-head" : "flex shrink-0 items-center gap-1 px-3 py-2" },
          React.createElement(
            "span",
            {
              className: "hb-text-micro uppercase tracking-[0.06em]",
              style: { color: "var(--color-muted-foreground)" }
            },
            t.history
          ),
          React.createElement(
            "div",
            { className: "ml-auto flex items-center gap-1" },
            React.createElement(
              "button",
              {
                type: "button",
                title: t.refreshTitle,
                "data-hb": "history-refresh",
                className: "hb-icon-btn",
                onClick: props.mode === "projects" ? props.onRefreshProjects : props.onRefresh
              },
              Icon(sdk, { name: "refresh", size: 15 })
            ),
            React.createElement(
              "button",
              {
                type: "button",
                title: t.collapse,
                "data-hb": "history-close",
                className: "hb-icon-btn",
                onClick: requestClose
              },
              Icon(sdk, { name: "close", size: 15 })
            )
          )
        ),
        // The drawer's first row: on a phone this is the only "new chat" there is.
        drawer ? React.createElement(
          "button",
          {
            type: "button",
            "data-hb": "drawer-new",
            className: "hb-drawer-new",
            onClick: () => {
              props.onClose();
              props.onNew();
            }
          },
          Icon(sdk, { name: "plus", size: 16 }),
          React.createElement("span", null, t.newChat)
        ) : null,
        // Recent vs Projects. Two words, not icons: the difference is a grouping
        // rule, and a glyph pair would need a legend.
        React.createElement(
          "div",
          { className: "hb-proj-tabs shrink-0" },
          React.createElement(
            "button",
            {
              type: "button",
              "data-hb": "history-mode-recent",
              "data-active": props.mode === "recent" ? "true" : "false",
              className: "hb-proj-tab",
              onClick: () => props.onModeChange("recent")
            },
            t.recent
          ),
          React.createElement(
            "button",
            {
              type: "button",
              "data-hb": "history-mode-projects",
              "data-active": props.mode === "projects" ? "true" : "false",
              className: "hb-proj-tab",
              onClick: () => props.onModeChange("projects")
            },
            t.projects
          )
        ),
        props.mode === "projects" ? React.createElement(ProjectList, {
          sdk: props.sdk,
          locale: props.locale,
          ...props.projectView
        }) : React.createElement(
          "div",
          { className: "hb-hist-list hb-scroll" },
          props.loading ? React.createElement(
            "div",
            { className: "hb-text-micro px-2 py-1", style: { color: "var(--color-muted-foreground)" } },
            t.historyLoading
          ) : props.sessions.length === 0 ? React.createElement(
            "div",
            { className: "hb-text-micro px-2 py-1", style: { color: "var(--color-muted-foreground)" } },
            t.historyEmpty
          ) : props.sessions.map((session) => {
            const isActive = session.id === props.activeStoredId;
            const menuOpen = menuId === session.id;
            return React.createElement(
              "div",
              {
                key: session.id,
                className: "hb-hist-row",
                "data-hb": "history-row",
                "data-active": isActive ? "true" : "false",
                // The row is also a drag source: dropping it on the composer
                // attaches its transcript as context (see `core/context.ts`).
                // Not in the drawer: a phone has no drag, and a long-press drag
                // would fight the scroll.
                draggable: !drawer,
                onDragStart: (event) => {
                  event.stopPropagation();
                  const payload = sessionDragPayload({ id: session.id, title: session.title });
                  if (event.dataTransfer) {
                    event.dataTransfer.setData(SESSION_CONTEXT_MIME, payload);
                    event.dataTransfer.setData("text/plain", payload);
                    event.dataTransfer.effectAllowed = "copy";
                  }
                },
                style: {
                  background: isActive ? "var(--color-muted)" : "transparent",
                  color: "var(--color-card-foreground)"
                },
                title: session.preview || session.title,
                onClick: () => props.onOpen(session.id, session.title || session.id.slice(0, 8)),
                onMouseEnter: (event) => {
                  if (!isActive) event.currentTarget.style.background = "var(--color-muted)";
                },
                onMouseLeave: (event) => {
                  if (!isActive) event.currentTarget.style.background = "transparent";
                }
              },
              React.createElement(
                "div",
                { className: "hb-hist-main" },
                renamingId === session.id ? React.createElement("input", {
                  autoFocus: true,
                  value: draft,
                  "data-hb": "rename-input",
                  className: "hb-input hb-flex-fill",
                  style: { fontSize: "0.75rem", padding: "0.1rem 0.3rem" },
                  onClick: (event) => event.stopPropagation(),
                  onChange: (event) => setDraft(event.target.value),
                  // Read the value off the ELEMENT rather than the `draft`
                  // state: React commits state on its own schedule, so a
                  // fast type-then-Enter (or a scripted one) would otherwise
                  // commit the previous value and rename to the old title.
                  onKeyDown: (event) => {
                    event.stopPropagation();
                    if (event.key === "Enter") {
                      event.preventDefault();
                      const next = event.currentTarget.value.trim();
                      if (next) props.onRename(session.id, next);
                      setRenamingId(null);
                    } else if (event.key === "Escape") {
                      event.preventDefault();
                      setRenamingId(null);
                    }
                  }
                }) : React.createElement(
                  "span",
                  { className: "hb-flex-fill hb-truncate" },
                  session.title || t.untitled
                ),
                // A small lamp, the same signal the tab strip uses: filled and
                // pulsing while that session is running, dim while merely open.
                props.openStoredIds.includes(session.id) ? React.createElement("span", {
                  className: props.busyStoredIds.includes(session.id) ? "hb-dot hb-caret" : "hb-dot",
                  "data-hb": "session-active",
                  "data-state": props.busyStoredIds.includes(session.id) ? "busy" : "open",
                  title: props.busyStoredIds.includes(session.id) ? t.sessionRunning : t.sessionOpen,
                  style: {
                    width: "0.4rem",
                    height: "0.4rem",
                    borderRadius: "9999px",
                    background: "var(--color-primary)",
                    opacity: session.id === props.activeStoredId ? 1 : 0.45
                  }
                }) : null,
                React.createElement(
                  "span",
                  {
                    className: "hb-text-tiny shrink-0",
                    style: { color: "var(--color-muted-foreground)" }
                  },
                  relativeTime(session.started_at, sdk, props.locale)
                ),
                // Desktop shows the three glyphs, revealed on hover; the
                // drawer shows one "···" that owns the same three actions.
                drawer ? React.createElement(
                  "button",
                  {
                    type: "button",
                    "data-hb": "session-menu",
                    "data-hb-id": session.id,
                    "data-open": menuOpen ? "true" : "false",
                    "aria-expanded": menuOpen,
                    className: "hb-icon-btn hb-row-more",
                    title: t.projectMenu,
                    "aria-label": t.projectMenu,
                    onClick: (event) => {
                      event.stopPropagation();
                      setMenuId((current) => current === session.id ? null : session.id);
                    }
                  },
                  Icon(sdk, { name: "dots", size: 16 })
                ) : React.createElement(
                  "span",
                  { className: "hb-row-tools shrink-0 flex items-center gap-0.5" },
                  React.createElement(
                    "button",
                    {
                      type: "button",
                      title: t.useAsContext,
                      "aria-label": t.useAsContext,
                      "data-hb": "session-to-context",
                      className: "hb-action-btn",
                      onClick: (event) => {
                        event.stopPropagation();
                        props.onUseAsContext(session.id, session.title);
                      }
                    },
                    Icon(sdk, { name: "download", size: 15 })
                  ),
                  React.createElement(
                    "button",
                    {
                      type: "button",
                      title: t.rename,
                      "aria-label": t.rename,
                      "data-hb": "rename-session",
                      className: "hb-action-btn",
                      onClick: (event) => {
                        event.stopPropagation();
                        setDraft(session.title || "");
                        setRenamingId(session.id);
                      }
                    },
                    Icon(sdk, { name: "pencil", size: 15 })
                  ),
                  React.createElement(
                    "button",
                    {
                      type: "button",
                      title: t.delete,
                      "aria-label": t.delete,
                      "data-hb": "delete-session",
                      className: "hb-action-btn",
                      onClick: (event) => {
                        event.stopPropagation();
                        if (window.confirm(t.deleteConfirm)) props.onDelete(session.id);
                      }
                    },
                    Icon(sdk, { name: "trash", size: 15 })
                  )
                )
              ),
              session.preview && !drawer ? React.createElement(
                "div",
                {
                  className: "hb-text-tiny hb-truncate",
                  style: { color: "var(--color-muted-foreground)" }
                },
                session.preview
              ) : null,
              // In flow, not absolutely positioned: this list is a scrolling
              // column and an absolute popover inside it is clipped by the
              // scroll box (and can land off-screen).
              menuOpen ? React.createElement(
                "div",
                { className: "hb-row-menu", "data-hb": "session-menu-panel", role: "menu" },
                menuItem(
                  "ctx",
                  "session-to-context",
                  t.useAsContext,
                  () => props.onUseAsContext(session.id, session.title)
                ),
                menuItem("ren", "rename-session", t.rename, () => {
                  setDraft(session.title || "");
                  setRenamingId(session.id);
                }),
                menuItem(
                  "del",
                  "delete-session",
                  t.delete,
                  () => {
                    if (window.confirm(t.deleteConfirm)) props.onDelete(session.id);
                  },
                  true
                )
              ) : null
            );
          })
        )
      )
    );
  }

  // src/core/rail.ts
  var LABEL_CHARS = 48;
  function railTicks(items, top = 0.02, bottom = 0.98) {
    const users = items.filter((item) => item.kind === "user");
    if (!users.length) return [];
    const span = Math.max(0, bottom - top);
    return users.map((item, index) => {
      const position = users.length === 1 ? top + span / 2 : top + span * index / (users.length - 1);
      return {
        itemId: item.id,
        position,
        label: summarise(item.text ?? "")
      };
    });
  }
  function summarise(text) {
    const flat = text.replace(/\s+/g, " ").trim();
    if (flat.length <= LABEL_CHARS) return flat;
    return `${flat.slice(0, LABEL_CHARS - 1)}\u2026`;
  }
  function nearestTick(ticks, ratio) {
    if (!ticks.length) return -1;
    let best = 0;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (let i = 0; i < ticks.length; i += 1) {
      const distance = Math.abs((ticks[i]?.position ?? 0) - ratio);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = i;
      }
    }
    return best;
  }
  var RAIL_MAX_TICKS = 120;
  function visibleTicks(ticks, max = RAIL_MAX_TICKS) {
    if (ticks.length <= max) return [...ticks];
    const out = [];
    const seen = /* @__PURE__ */ new Set();
    for (let i = 0; i < max; i += 1) {
      const index = Math.round(i * (ticks.length - 1) / (max - 1));
      if (seen.has(index)) continue;
      seen.add(index);
      const tick = ticks[index];
      if (tick) out.push(tick);
    }
    const last = ticks[ticks.length - 1];
    if (last && out[out.length - 1]?.itemId !== last.itemId) out.push(last);
    return out;
  }

  // src/ui/LocatorRail.ts
  function scrollToItem(scroller, itemId, behavior = "smooth") {
    if (!scroller) return false;
    const target = scroller.querySelector(`[data-hb-item="${CSS.escape(itemId)}"]`);
    if (!target) return false;
    const offset = target.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop - 12;
    scroller.scrollTo({ top: Math.max(0, offset), behavior });
    return true;
  }
  function LocatorRail({ sdk, locale, items, scrollerRef }) {
    const { React } = sdk;
    const { useState } = sdk.hooks;
    const t = messagesFor(locale);
    const [hovered, setHovered] = useState(-1);
    const all = railTicks(items);
    if (all.length < 2) {
      return null;
    }
    const ticks = visibleTicks(all);
    const active = hovered >= 0 ? ticks[hovered] : null;
    return React.createElement(
      "div",
      {
        className: "hb-rail",
        "data-hb": "locator-rail",
        // The clickable area is the whole column, but only ticks do anything; a
        // click between ticks snaps to the nearest one.
        onClick: (event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          const ratio = rect.height > 0 ? (event.clientY - rect.top) / rect.height : 0;
          const index = nearestTick(ticks, ratio);
          const tick = ticks[index];
          if (tick) scrollToItem(scrollerRef.current, tick.itemId);
        },
        onMouseMove: (event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          const ratio = rect.height > 0 ? (event.clientY - rect.top) / rect.height : 0;
          const index = nearestTick(ticks, ratio);
          if (index !== hovered) setHovered(index);
        },
        onMouseLeave: () => setHovered(-1),
        // Keyboard users get the newest handful rather than an unreachable rail.
        tabIndex: 0,
        role: "navigation",
        "aria-label": t.jumpToMessage
      },
      ticks.map(
        (tick, index) => React.createElement("span", {
          key: tick.itemId,
          className: "hb-rail-tick",
          "data-hb-tick": tick.itemId,
          "data-active": index === hovered ? "true" : "false",
          style: { top: `${(tick.position * 100).toFixed(3)}%` }
        })
      ),
      active ? React.createElement(
        "span",
        {
          className: "hb-rail-tip",
          "data-hb": "rail-tip",
          // Flip the tooltip inward near the top so it never leaves the column.
          style: { top: `${(active.position * 100).toFixed(3)}%` }
        },
        active.label || t.untitled
      ) : null
    );
  }

  // src/ui/ModelPicker.ts
  function ModelPicker(props) {
    const { sdk } = props;
    const { React } = sdk;
    const t = messagesFor(props.locale);
    const { useMemo, useState } = sdk.hooks;
    const [filter, setFilter] = useState("");
    const groups = useMemo(() => {
      const q = filter.trim().toLowerCase();
      return props.providers.map((provider) => ({
        provider,
        models: q ? provider.models.filter(
          (model) => model.toLowerCase().includes(q) || provider.name.toLowerCase().includes(q)
        ) : provider.models
      })).filter((group) => group.models.length > 0);
    }, [props.providers, filter]);
    if (!props.open) return null;
    return React.createElement(
      "div",
      {
        className: "hb-modal-scrim fixed inset-0 z-50 flex items-start justify-center p-8",
        style: { background: "rgba(0,0,0,0.45)" },
        onClick: props.onClose
      },
      React.createElement(
        "div",
        {
          className: "hb-modal-card hb-max-h-70vh flex w-full flex-col overflow-hidden",
          style: {
            maxWidth: "34rem",
            background: "var(--color-card)",
            color: "var(--color-card-foreground)",
            borderRadius: "var(--radius)",
            boxShadow: "0 12px 40px rgba(0,0,0,0.4)"
          },
          onClick: (event) => event.stopPropagation()
        },
        React.createElement(
          "div",
          { className: "flex items-center gap-2 border-b p-3", style: { borderColor: "var(--color-border)" } },
          React.createElement("span", { className: "text-xs font-medium" }, t.pickModel),
          React.createElement(
            "button",
            {
              type: "button",
              className: "ml-auto cursor-pointer px-2 text-sm",
              style: { color: "var(--color-muted-foreground)" },
              onClick: props.onClose
            },
            "\xD7"
          )
        ),
        // reasoning row
        React.createElement(
          "div",
          { className: "flex flex-wrap items-center gap-1.5 border-b p-3", style: { borderColor: "var(--color-border)" } },
          React.createElement(
            "span",
            { className: "mr-1 text-[0.6875rem]", style: { color: "var(--color-muted-foreground)" } },
            t.reasoning
          ),
          REASONING_LEVELS.map(
            (level) => React.createElement(
              "button",
              {
                key: level,
                type: "button",
                className: "cursor-pointer px-2 py-0.5 text-[0.6875rem]",
                style: {
                  background: level === props.reasoning ? "var(--color-primary)" : "var(--color-muted)",
                  color: level === props.reasoning ? "var(--color-primary-foreground)" : "var(--color-card-foreground)",
                  borderRadius: "calc(var(--radius) * 0.6)"
                },
                onClick: () => props.onPickReasoning(level)
              },
              reasoningLabel(level, props.locale)
            )
          )
        ),
        React.createElement("input", {
          value: filter,
          placeholder: t.filterModels,
          className: "mb-1 bg-transparent px-2 py-1.5 text-xs outline-none",
          style: {
            margin: "0.75rem 0.75rem 0.25rem",
            color: "var(--color-card-foreground)",
            borderRadius: "calc(var(--radius) * 0.6)",
            boxShadow: "inset 0 0 0 1px var(--color-border)"
          },
          onChange: (event) => setFilter(event.target.value)
        }),
        React.createElement(
          "div",
          { className: "min-h-0 flex-1 overflow-y-auto p-3 pt-1 hb-scroll" },
          props.loading ? React.createElement("div", { className: "py-4 text-center text-xs", style: { color: "var(--color-muted-foreground)" } }, t.loading) : groups.length === 0 ? React.createElement("div", { className: "py-4 text-center text-xs", style: { color: "var(--color-muted-foreground)" } }, t.noModels) : groups.map(
            (group) => React.createElement(
              "div",
              { key: group.provider.slug, className: "mb-2" },
              React.createElement(
                "div",
                {
                  className: "flex items-baseline gap-1.5 px-1 py-1 text-[0.6875rem] uppercase tracking-[0.06em]",
                  style: { color: "var(--color-muted-foreground)" }
                },
                group.provider.name || group.provider.slug,
                group.provider.is_current ? React.createElement("span", { style: { color: "var(--color-primary)" } }, t.current) : null,
                group.provider.authenticated === false ? React.createElement("span", { style: { color: "var(--color-destructive)" } }, t.noKey) : null
              ),
              group.models.map((model) => {
                const isCurrent = model === props.currentModel && group.provider.slug === props.currentProvider;
                return React.createElement(
                  "button",
                  {
                    key: `${group.provider.slug}:${model}`,
                    type: "button",
                    className: "flex w-full cursor-pointer items-baseline gap-2 px-2 py-1 text-left text-xs",
                    style: {
                      background: isCurrent ? "var(--color-accent, var(--color-muted))" : "transparent",
                      color: "var(--color-card-foreground)",
                      borderRadius: "calc(var(--radius) * 0.6)"
                    },
                    onClick: () => props.onPick(model, group.provider.slug)
                  },
                  React.createElement("span", { className: "hb-mono min-w-0 flex-1 truncate" }, model),
                  isCurrent ? React.createElement(
                    "span",
                    { className: "hb-picker-check" },
                    Icon(sdk, { name: "check", size: 14 })
                  ) : null
                );
              })
            )
          )
        )
      )
    );
  }

  // src/core/requests.ts
  var APPROVAL_CHOICES = ["once", "session", "always", "deny"];
  var APPROVAL_LABEL_KEY = {
    once: "approvalOnce",
    session: "approvalSession",
    always: "approvalAlways",
    deny: "approvalDeny"
  };
  function str3(value) {
    return typeof value === "string" ? value : "";
  }
  function toChoice(value) {
    return typeof value === "string" && APPROVAL_CHOICES.includes(value) ? value : null;
  }
  function parseApproval(params) {
    const raw = Array.isArray(params.choices) ? params.choices : [];
    const parsed = raw.map(toChoice).filter((c) => c !== null);
    return {
      requestId: str3(params.request_id),
      command: str3(params.command),
      description: str3(params.description),
      toolName: str3(params.tool_name),
      choices: parsed.length ? parsed : [...APPROVAL_CHOICES]
    };
  }
  function approvalLabel(choice, locale) {
    return messagesFor(locale)[APPROVAL_LABEL_KEY[choice]];
  }
  function approvalResult(choice) {
    return { choice };
  }
  function parseClarifyQuestions(params) {
    const raw = Array.isArray(params.questions) ? params.questions : [];
    const out = [];
    for (const entry of raw) {
      if (!entry || typeof entry !== "object") continue;
      const q = entry;
      const qid = str3(q.qid);
      if (!qid) continue;
      out.push({
        qid,
        question: str3(q.question),
        choices: Array.isArray(q.choices) ? q.choices.filter((c) => typeof c === "string") : [],
        multiSelect: q.multi_select === true
      });
    }
    return out;
  }
  function clarifyAnswer(values) {
    const picked = values.filter((v) => v.trim().length > 0);
    if (!picked.length) return null;
    return picked.join(", ");
  }
  function clarifyResult(answers) {
    const out = {};
    for (const [qid, values] of Object.entries(answers)) {
      const joined = clarifyAnswer(values);
      if (joined !== null) out[qid] = joined;
    }
    return { answers: Object.keys(out).length ? out : null };
  }
  function clarifyReady(questions, answers) {
    return questions.every((q) => clarifyAnswer(answers[q.qid] ?? []) !== null);
  }
  function stagedAnswerParts(question, values) {
    const offered = new Set(question.choices);
    const picked = values.filter((value) => offered.has(value));
    const text = values.find((value) => !offered.has(value)) ?? "";
    return { picked, text };
  }
  function stageChoice(question, values, choice) {
    const { picked, text } = stagedAnswerParts(question, values);
    if (question.multiSelect) {
      const next = picked.includes(choice) ? picked.filter((value) => value !== choice) : [...picked, choice];
      return text ? [...next, text] : next;
    }
    return picked[0] === choice ? [] : [choice];
  }
  function stageFreeText(question, values, text) {
    const { picked } = stagedAnswerParts(question, values);
    if (!text.trim()) return question.multiSelect ? picked : [];
    return question.multiSelect ? [...picked, text] : [text];
  }

  // src/ui/RequestCards.ts
  function cardShell(sdk, accent, children) {
    const { React } = sdk;
    return React.createElement(
      "div",
      {
        className: "px-3 py-2 text-xs hb-bubble-gap",
        "data-hb": "request-card",
        style: {
          maxWidth: "min(72ch, 82%)",
          background: `color-mix(in oklab, ${accent} 10%, var(--color-card))`,
          borderRadius: "var(--radius)",
          borderLeft: `2px solid ${accent}`
        }
      },
      children
    );
  }
  var CODE_STYLE = {
    padding: "0.5rem",
    fontFamily: "var(--hb-font-mono)",
    fontSize: "0.8125rem",
    background: "color-mix(in oklab, var(--color-muted) 70%, transparent)",
    borderRadius: "calc(var(--radius) * 0.6)"
  };
  function ApprovalCard({
    sdk,
    card,
    locale,
    onAnswer
  }) {
    const { React } = sdk;
    const t = messagesFor(locale);
    const view = parseApproval(card.params);
    return cardShell(
      sdk,
      "var(--color-destructive)",
      React.createElement(
        "div",
        null,
        React.createElement(
          "div",
          { className: "flex items-center gap-2" },
          React.createElement("span", { className: "font-medium" }, t.approvalTitle),
          view.toolName ? React.createElement(
            "span",
            { className: "hb-text-micro", style: { color: "var(--color-muted-foreground)" } },
            view.toolName
          ) : null
        ),
        view.description ? React.createElement(
          "div",
          { className: "hb-mt-sm", style: { color: "var(--color-muted-foreground)" } },
          view.description
        ) : null,
        view.command ? React.createElement("pre", { className: "hb-output hb-mt-sm", style: CODE_STYLE }, view.command) : null,
        React.createElement(
          "div",
          { className: "hb-stack-gap hb-choice-col" },
          view.choices.map(
            (choice) => React.createElement(
              "button",
              {
                key: choice,
                type: "button",
                "data-hb-choice": choice,
                className: "hb-action-btn-text hb-choice-row",
                style: {
                  background: choice === "deny" ? "var(--color-muted)" : "var(--color-primary)",
                  color: choice === "deny" ? "var(--color-muted-foreground)" : "var(--color-primary-foreground)",
                  borderRadius: "calc(var(--radius) * 0.6)"
                },
                onClick: () => onAnswer(choice)
              },
              approvalLabel(choice, locale)
            )
          )
        )
      )
    );
  }
  function ClarifyCard({
    sdk,
    card,
    locale,
    onSubmit
  }) {
    const { React } = sdk;
    const { useState } = sdk.hooks;
    const t = messagesFor(locale);
    const questions = parseClarifyQuestions(card.params);
    const [picked, setPicked] = useState({});
    const stage = (qid, values) => {
      setPicked((prev) => ({ ...prev, [qid]: values }));
    };
    const ready = clarifyReady(questions, picked);
    return cardShell(
      sdk,
      "var(--color-ring)",
      React.createElement(
        "div",
        { className: "space-y-2" },
        React.createElement("div", { className: "font-medium" }, t.clarifyTitle),
        questions.map((q) => {
          const on = picked[q.qid] ?? [];
          const { text } = stagedAnswerParts(q, on);
          const freeText = React.createElement(
            "input",
            {
              key: `${q.qid}-free`,
              type: "text",
              className: q.choices.length ? "hb-choice-row hb-input hb-choice-input" : "hb-mt-sm hb-input",
              "data-hb-input": q.qid,
              "data-hb": "clarify-other",
              "aria-label": q.choices.length ? t.clarifyOther : q.question,
              placeholder: q.choices.length ? t.clarifyOther : void 0,
              value: text,
              onChange: (event) => stage(q.qid, stageFreeText(q, on, event.target.value))
            }
          );
          if (!q.choices.length) {
            return React.createElement("div", { key: q.qid }, React.createElement("div", null, q.question), freeText);
          }
          return React.createElement(
            "div",
            { key: q.qid },
            React.createElement("div", null, q.question),
            React.createElement(
              "div",
              { className: "hb-mt-sm hb-choice-col" },
              q.choices.map(
                (choice) => React.createElement(
                  "button",
                  {
                    key: choice,
                    type: "button",
                    "data-hb-choice": choice,
                    "data-hb-selected": on.includes(choice) ? "true" : "false",
                    className: "hb-action-btn-text hb-choice-row",
                    style: {
                      background: on.includes(choice) ? "var(--color-primary)" : "var(--color-muted)",
                      color: on.includes(choice) ? "var(--color-primary-foreground)" : "var(--color-card-foreground)",
                      borderRadius: "calc(var(--radius) * 0.6)"
                    },
                    onClick: () => stage(q.qid, stageChoice(q, on, choice))
                  },
                  choice
                )
              ),
              // Last row, styled as a member of the same list rather than as a
              // form field: the point is "these are the options; this one is
              // yours", so it must not read as a separate thing below the list.
              freeText
            )
          );
        }),
        React.createElement(
          "div",
          { className: "hb-stack-gap" },
          React.createElement(
            "button",
            {
              type: "button",
              "data-hb": "clarify-submit",
              disabled: !ready,
              className: "hb-action-btn-text",
              style: {
                background: "var(--color-primary)",
                color: "var(--color-primary-foreground)",
                borderRadius: "calc(var(--radius) * 0.6)",
                opacity: ready ? 1 : 0.4,
                cursor: ready ? "pointer" : "default"
              },
              onClick: () => onSubmit(clarifyResult(picked))
            },
            t.submit
          )
        )
      )
    );
  }

  // src/ui/TabStrip.ts
  function TabStrip(props) {
    const { sdk } = props;
    const { React } = sdk;
    const t = messagesFor(props.locale);
    return React.createElement(
      "div",
      {
        className: "flex shrink-0 items-stretch gap-1 px-2 py-1.5",
        style: { borderBottom: "1px solid var(--color-border)", minHeight: "2.5rem" }
      },
      // Scrolling tab list: many tabs must not push the buttons off screen.
      React.createElement(
        "div",
        { className: "hb-flex-fill flex items-center gap-1 overflow-x-auto hb-scroll" },
        props.tabs.length === 0 ? React.createElement(
          "span",
          { className: "hb-text-micro px-2", style: { color: "var(--color-muted-foreground)" } },
          t.emptyTabs
        ) : props.tabs.map(
          (tab) => React.createElement(
            "button",
            {
              key: tab.key,
              type: "button",
              // Stable hook for the end-to-end script: tests must not depend on
              // the visible label, which is localized.
              "data-hb": "tab",
              "data-hb-key": tab.key,
              title: tabLabel(tab, t),
              className: "hb-tab group flex hb-max-w-22ch shrink-0 items-center gap-1.5 px-2.5 py-1 text-xs",
              style: {
                background: tab.key === props.activeKey ? "var(--color-muted)" : "transparent",
                color: tab.key === props.activeKey ? "var(--color-card-foreground)" : "var(--color-muted-foreground)",
                borderRadius: "calc(var(--radius) * 0.6)",
                boxShadow: tab.key === props.activeKey ? "inset 0 0 0 1px var(--color-border)" : "none"
              },
              onClick: () => props.onFocus(tab.key)
            },
            props.runningKeys.includes(tab.key) ? React.createElement("span", { className: "hb-caret shrink-0", style: { color: "var(--color-primary)" } }, "\u25CF") : null,
            // "Needs an answer": a card is waiting in this tab. Static, not
            // animated — the running caret already owns motion, and a second
            // blinking dot would read as the same thing.
            props.waitingKeys.includes(tab.key) ? React.createElement(
              "span",
              {
                className: "hb-wait-dot shrink-0",
                title: t.waitingForAnswer,
                "data-hb": "tab-waiting",
                "aria-label": t.waitingForAnswer
              },
              "?"
            ) : null,
            React.createElement("span", { className: "hb-truncate" }, tabLabel(tab, t)),
            React.createElement(
              "span",
              {
                role: "button",
                title: t.closeTab,
                "data-hb": "tab-close",
                className: "hb-tab-close shrink-0 cursor-pointer px-0.5",
                style: { color: "var(--color-muted-foreground)" },
                onClick: (event) => {
                  event.stopPropagation();
                  props.onClose(tab.key);
                }
              },
              "\xD7"
            )
          )
        )
      ),
      // Actions, pinned right so they never scroll away. Same round buttons as the
      // phone's floating pair, with the same press motion — one visual language for
      // "refresh the chat" and "open the chat list" on both sizes. The word
      // "History" became the "···" here, and the notification switch moved into the
      // composer's "···" menu, where it is a labelled row instead of a glyph whose
      // meaning needed a tooltip.
      React.createElement(
        "div",
        { className: "flex shrink-0 items-center gap-1" },
        React.createElement(
          "button",
          {
            type: "button",
            title: t.refreshChat,
            "aria-label": t.refreshChat,
            "data-hb": "refresh-chat",
            className: "hb-strip-btn",
            onClick: () => void props.onRefreshChat()
          },
          Icon(sdk, { name: "refresh", size: 16 })
        ),
        React.createElement(
          "button",
          {
            type: "button",
            title: t.newChat,
            "aria-label": t.newChat,
            "data-hb": "tab-new",
            className: "hb-strip-btn",
            onClick: props.onNew
          },
          Icon(sdk, { name: "plus", size: 17 })
        ),
        React.createElement(
          "button",
          {
            type: "button",
            title: props.historyOpen ? t.collapse : t.history,
            "aria-label": props.historyOpen ? t.collapse : t.history,
            "data-hb": "history-toggle",
            "data-open": props.historyOpen ? "true" : "false",
            "aria-expanded": props.historyOpen,
            className: "hb-strip-btn",
            style: {
              color: props.historyOpen ? "var(--color-card-foreground)" : "var(--color-muted-foreground)",
              background: props.historyOpen ? "var(--color-muted)" : "transparent"
            },
            onClick: props.onToggleHistory
          },
          Icon(sdk, { name: "dots", size: 18 })
        )
      )
    );
  }

  // src/ui/TodoPanel.ts
  var OPEN_STORAGE_KEY = "hb-todo-open";
  function glyphFor(status) {
    if (status === "completed") return "check";
    if (status === "cancelled") return "close";
    if (status === "in_progress") return "circleDot";
    return "circle";
  }
  function countDone(todos) {
    return todos.filter((todo) => todo.status === "completed").length;
  }
  function tree(todos) {
    const ids = new Set(todos.map((todo) => todo.id));
    const children = /* @__PURE__ */ new Map();
    const roots = [];
    for (const todo of todos) {
      if (todo.parent && ids.has(todo.parent)) {
        const bucket = children.get(todo.parent) ?? [];
        bucket.push(todo);
        children.set(todo.parent, bucket);
      } else {
        roots.push(todo);
      }
    }
    return { roots, children };
  }
  function TodoPanel({ sdk, locale, todo }) {
    const { React } = sdk;
    const { useState } = sdk.hooks;
    const t = messagesFor(locale);
    const [open, setOpen] = useState(() => {
      try {
        return window.localStorage.getItem(OPEN_STORAGE_KEY) !== "off";
      } catch {
        return true;
      }
    });
    if (!todo || !todo.todos.length) return null;
    const done = countDone(todo.todos);
    const total = todo.todos.length;
    const { roots, children } = tree(todo.todos);
    const toggle = () => {
      const next = !open;
      setOpen(next);
      try {
        window.localStorage.setItem(OPEN_STORAGE_KEY, next ? "on" : "off");
      } catch {
      }
    };
    const row = (entry, depth) => {
      const status = entry.status || "pending";
      return React.createElement(
        "div",
        {
          key: entry.id,
          className: depth ? "hb-todo-row hb-todo-child" : "hb-todo-row",
          "data-hb": "todo-row",
          "data-status": status
        },
        React.createElement(
          "span",
          {
            className: status === "in_progress" ? "hb-todo-glyph hb-todo-active shrink-0" : "hb-todo-glyph shrink-0",
            "aria-hidden": "true"
          },
          Icon(sdk, { name: glyphFor(status), size: 13 })
        ),
        React.createElement("span", { className: "hb-todo-text" }, entry.content)
      );
    };
    const body = () => {
      const rows = [];
      for (const rootEntry of roots) {
        rows.push(row(rootEntry, 0));
        for (const child of children.get(rootEntry.id) ?? []) rows.push(row(child, 1));
      }
      return rows;
    };
    return React.createElement(
      "div",
      { className: "hb-todo-panel", "data-hb": "todo-panel" },
      React.createElement(
        "button",
        {
          type: "button",
          className: "hb-todo-head",
          "data-hb": "todo-toggle",
          "data-open": open ? "true" : "false",
          "aria-expanded": open ? "true" : "false",
          onClick: toggle
        },
        React.createElement("span", { className: "hb-todo-caret" }, Icon(sdk, { name: "chevron", size: 13 })),
        React.createElement("span", { className: "hb-todo-title" }, t.todos),
        React.createElement("span", { className: "hb-todo-count" }, t.todoProgress(done, total))
      ),
      open ? React.createElement("div", { className: "hb-todo-list", role: "list" }, body()) : null
    );
  }

  // src/ui/useMobile.ts
  var MOBILE_MAX_PX = 768;
  function useMobile(sdk) {
    const { useState, useEffect } = sdk.hooks;
    const query = `(max-width: ${MOBILE_MAX_PX}px)`;
    const [mobile, setMobile] = useState(() => {
      try {
        return window.matchMedia(query).matches;
      } catch {
        return false;
      }
    });
    useEffect(() => {
      let media;
      try {
        media = window.matchMedia(query);
      } catch {
        return;
      }
      const sync = () => setMobile(media.matches);
      sync();
      media.addEventListener("change", sync);
      return () => media.removeEventListener("change", sync);
    }, [query]);
    return mobile;
  }

  // src/core/notify.ts
  function shouldNotify(gate) {
    return gate.enabled && gate.permission === "granted" && gate.background;
  }
  var NOTIFY_STORAGE_KEY = "hb-notify";
  function notifySwitch(enabled, permission) {
    if (!enabled) return "off";
    if (permission === "granted") return "on";
    return permission === "denied" ? "blocked" : "needs-permission";
  }
  function storedEnabled(raw) {
    return raw !== "off";
  }
  function flatten2(text, limit = 120) {
    const plain = text.replace(/```[\s\S]*?```/g, " ").replace(/`([^`]*)`/g, "$1").replace(/!\[[^\]]*\]\([^)]*\)/g, " ").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/^#{1,6}\s*/gm, "").replace(/[*_~>|]+/g, "").replace(/\s+/g, " ").trim();
    if (plain.length <= limit) return plain;
    return `${plain.slice(0, limit - 1)}\u2026`;
  }
  function firstString(value) {
    return typeof value === "string" ? value.trim() : "";
  }
  function requestNotice(method, params, t, tag, sessionTitle = "") {
    const name = sessionTitle.trim();
    if (method === "approval") {
      const detail = firstString(params.description) || firstString(params.command) || firstString(params.tool_name);
      return {
        kind: "approval",
        title: name ? `${t.notifyApprovalTitle} \xB7 ${name}` : t.notifyApprovalTitle,
        body: flatten2(detail, 160) || firstString(params.tool_name) || t.approvalTitle,
        tag,
        sticky: true
      };
    }
    const questions = Array.isArray(params.questions) ? params.questions : [];
    const first = questions[0];
    const question = firstString(first?.question) || firstString(params.question);
    const extra = questions.length > 1 ? ` (+${questions.length - 1})` : "";
    return {
      kind: "clarify",
      title: name ? `${t.notifyClarifyTitle} \xB7 ${name}` : t.notifyClarifyTitle,
      body: question ? `${flatten2(question, 140)}${extra}` : t.clarifyTitle,
      tag,
      sticky: true
    };
  }
  function completionNotice(result, t, tag) {
    const error = (result.error ?? "").trim();
    if (error) {
      return {
        kind: "failed",
        title: t.notifyFailedTitle,
        body: flatten2(error, 160) || t.notifyFailedTitle,
        tag,
        sticky: false
      };
    }
    const body = flatten2(result.text ?? "", 160);
    const name = (result.title ?? "").trim();
    return {
      kind: "done",
      title: name ? `${t.notifyDoneTitle} \xB7 ${name}` : t.notifyDoneTitle,
      body: body || t.notifyDoneTitle,
      tag,
      sticky: false
    };
  }
  function testNotice(t) {
    return {
      kind: "done",
      title: t.notifyTestTitle,
      body: t.notifyTestBody,
      tag: "hb-test",
      sticky: false
    };
  }

  // src/ui/notifier.ts
  function notificationSupported() {
    return typeof window !== "undefined" && "Notification" in window;
  }
  function notificationPermission() {
    if (!notificationSupported()) return "denied";
    return window.Notification.permission;
  }
  async function requestNotificationPermission() {
    if (!notificationSupported()) return "denied";
    const current = notificationPermission();
    if (current !== "default") return current;
    try {
      return await window.Notification.requestPermission();
    } catch {
      return "denied";
    }
  }
  function notifyEnabled() {
    try {
      return storedEnabled(window.localStorage.getItem(NOTIFY_STORAGE_KEY));
    } catch {
      return true;
    }
  }
  function setNotifyEnabled(enabled) {
    try {
      window.localStorage.setItem(NOTIFY_STORAGE_KEY, enabled ? "on" : "off");
    } catch {
    }
  }
  function windowBackgrounded() {
    if (typeof document === "undefined") return false;
    if (document.visibilityState === "hidden") return true;
    return !document.hasFocus();
  }
  function specFor(notice, locale) {
    const t = messagesFor(locale);
    if (notice.kind === "request") {
      const method = notice.method === "clarify" ? "clarify" : "approval";
      const tag = `hb-request-${notice.requestId ?? notice.sessionKey}`;
      return requestNotice(method, notice.params ?? {}, t, tag, notice.title);
    }
    return completionNotice(
      { title: notice.title, text: notice.text, error: notice.error },
      t,
      `hb-turn-${notice.sessionKey}`
    );
  }
  function raiseNotification(spec, onOpen) {
    if (!notificationSupported()) return;
    try {
      const notification = new window.Notification(spec.title, {
        body: spec.body,
        tag: spec.tag,
        // A request the agent is blocked on stays put; a finished turn does not
        // need to be dismissed by hand.
        requireInteraction: spec.sticky
      });
      notification.onclick = () => {
        try {
          window.focus();
          onOpen?.();
        } finally {
          notification.close();
        }
      };
    } catch {
    }
  }
  function raiseTestNotification(locale) {
    raiseNotification(testNotice(messagesFor(locale)));
  }
  function maybeNotify(notice, locale, onOpen) {
    const gate = {
      enabled: notifyEnabled(),
      permission: notificationPermission(),
      background: windowBackgrounded()
    };
    if (!shouldNotify(gate)) return;
    raiseNotification(specFor(notice, locale), onOpen);
  }

  // src/ui/useLocale.ts
  function readLocale() {
    try {
      const stored = window.localStorage.getItem(LOCALE_STORAGE_KEY);
      if (stored) return normalizeLocale(stored);
    } catch {
    }
    return normalizeLocale(document.documentElement.lang);
  }
  function currentLocale() {
    try {
      return readLocale();
    } catch {
      return normalizeLocale(null);
    }
  }
  function useLocale(sdk) {
    const { useState, useEffect } = sdk.hooks;
    const [locale, setLocale] = useState(() => {
      try {
        return readLocale();
      } catch {
        return normalizeLocale(null);
      }
    });
    useEffect(() => {
      let alive = true;
      const sync = () => {
        if (!alive) return;
        const next = readLocale();
        setLocale((current) => current === next ? current : next);
      };
      window.addEventListener("storage", sync);
      const observer = new MutationObserver(sync);
      observer.observe(document.documentElement, { attributes: true, attributeFilter: ["lang"] });
      sync();
      return () => {
        alive = false;
        window.removeEventListener("storage", sync);
        observer.disconnect();
      };
    }, []);
    return locale;
  }

  // src/ui/ChatPage.ts
  var boundSdk = null;
  function storageOrNull() {
    try {
      return window.localStorage;
    } catch {
      return null;
    }
  }
  function currentProfile() {
    const match = /^\/p\/([^/]+)\//.exec(window.location.pathname);
    if (!match?.[1]) return "";
    try {
      return decodeURIComponent(match[1]);
    } catch {
      return match[1];
    }
  }
  var chatController = createControllerHolder(() => {
    if (!boundSdk) throw new Error("hermes-bubbles: controller acquired before the page mounted");
    const profile = currentProfile();
    return new ChatController({
      urlProvider: () => boundSdk.buildWsUrl("/api/ws"),
      // The workspace is a preference, not session state: restore it here so the
      // very first `session.create` of this document already lands in the right
      // directory instead of needing a second chat to take effect.
      initialWorkspace: readStoredWorkspace(storageOrNull(), profile),
      persistWorkspace: (cwd) => writeStoredWorkspace(storageOrNull(), profile, cwd)
    });
  });
  function acquireController(sdk) {
    boundSdk = sdk;
    return chatController.acquire();
  }
  function ChatPage({ sdk }) {
    const { React } = sdk;
    const { useCallback, useEffect, useMemo, useRef, useState } = sdk.hooks;
    const useSyncExternalStore = React.useSyncExternalStore;
    const locale = useLocale(sdk);
    const t = messagesFor(locale);
    const mobile = useMobile(sdk);
    const controller = useMemo(() => acquireController(sdk), [sdk]);
    const [cards, setCards] = useState([]);
    const [error, setError] = useState(null);
    const [attachments, setAttachments] = useState([]);
    const [catalog, setCatalog] = useState([]);
    const [stored, setStored] = useState([]);
    const [loadingStored, setLoadingStored] = useState(false);
    const [historyOpen, setHistoryOpen] = useState(false);
    const [pickerOpen, setPickerOpen] = useState(false);
    const [pickerLoading, setPickerLoading] = useState(false);
    const [providers, setProviders] = useState([]);
    const [modelChoice, setModelChoice] = useState({ model: "", provider: "" });
    const [pendingSwitch, setPendingSwitch] = useState(null);
    const [reasoning, setReasoning] = useState("medium");
    const [workspaces, setWorkspaces] = useState(null);
    const [workspaceLoading, setWorkspaceLoading] = useState(false);
    const [workspaceFailed, setWorkspaceFailed] = useState(false);
    const [git, setGit] = useState(null);
    const [gitLoading, setGitLoading] = useState(false);
    const [gitTick, setGitTick] = useState(0);
    const [approvalMode, setApprovalModeValue] = useState("");
    const [historyMode, setHistoryMode] = useState("recent");
    const [projectTree, setProjectTree] = useState(null);
    const [hiddenProjects, setHiddenProjects] = useState(
      () => readHiddenProjects(storageOrNull(), currentProfile())
    );
    const [projectsLoading, setProjectsLoading] = useState(false);
    const [projectsFailed, setProjectsFailed] = useState(false);
    const [projectSessionCache, setProjectSessionCache] = useState({});
    const [loadingProjectId, setLoadingProjectId] = useState(null);
    const [editing, setEditing] = useState(null);
    const [insertion, setInsertion] = useState(null);
    const insertionSeq = useRef(0);
    const [notifyOn, setNotifyOn] = useState(() => notifyEnabled());
    const [notifyPermission, setNotifyPermission] = useState(
      () => notificationPermission()
    );
    const notifyState = notifySwitch(notifyOn, notifyPermission);
    const scrollerRef = useRef(null);
    const pinRef = useRef(pinnedState);
    const localeRef = useRef(locale);
    const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
    const timeline = activeTimeline(state);
    const running = runningKeys(state);
    const visibleCards = cardsForTab(state, cards, state.activeKey);
    const segments = useMemo(() => groupTranscript(timeline.items), [timeline.items]);
    const waiting = waitingKeys(state, cards);
    useEffect(() => {
      controller.setLocale(locale);
      localeRef.current = locale;
    }, [controller, locale]);
    useEffect(() => {
      controller.setHttpFetcher((path, init) => sdk.fetchJSON(path, init));
      return () => controller.setHttpFetcher(null);
    }, [controller, sdk]);
    useEffect(() => {
      controller.setServerRequestSink((card) => {
        setCards((prev) => prev.some((c) => c.id === card.id) ? prev : [...prev, card]);
      });
      controller.setWithdrawalSink((withdrawal) => {
        setCards((prev) => withoutWithdrawn(prev, [withdrawal]));
      });
      controller.setNoticeSink(
        (notice) => maybeNotify(notice, localeRef.current, () => {
          if (notice.kind === "request" && notice.sessionKey) controller.focusSessionId(notice.sessionKey);
        })
      );
      const parked = controller.takeParkedCards();
      if (parked.length) {
        setCards((prev) => {
          const seen = new Set(prev.map((c) => c.id));
          return [...prev, ...parked.filter((c) => !seen.has(c.id))];
        });
      }
      const withdrawn = controller.takeParkedWithdrawals();
      if (withdrawn.length) setCards((prev) => withoutWithdrawn(prev, withdrawn));
      controller.start().then(() => refreshStored()).catch((err) => setError(err instanceof Error ? err.message : String(err)));
      controller.commandsCatalog().then((raw) => setCatalog(entriesFromCatalog(raw))).catch(() => setCatalog([]));
      return () => {
        controller.setServerRequestSink(null);
        controller.setWithdrawalSink(null);
        chatController.release();
      };
    }, [controller]);
    useEffect(() => {
      const sync = () => setNotifyPermission(notificationPermission());
      window.addEventListener("focus", sync);
      document.addEventListener("visibilitychange", sync);
      return () => {
        window.removeEventListener("focus", sync);
        document.removeEventListener("visibilitychange", sync);
      };
    }, []);
    useEffect(() => {
      const meta = timeline.meta;
      if (meta.model) setModelChoice({ model: meta.model, provider: meta.provider });
      if (meta.reasoningEffort) setReasoning(meta.reasoningEffort);
    }, [timeline.meta.model, timeline.meta.provider, timeline.meta.reasoningEffort]);
    const refreshStored = useCallback(() => {
      setLoadingStored(true);
      controller.listSessions().then((rows) => setStored(rows)).catch(() => setStored([])).finally(() => setLoadingStored(false));
    }, [controller]);
    const loadWorkspaces = useCallback(
      (scan) => {
        setWorkspaceLoading(true);
        return controller.listWorkspaces(scan).then((payload) => {
          setWorkspaces(payload);
          setWorkspaceFailed(false);
        }).catch(() => setWorkspaceFailed(true)).finally(() => setWorkspaceLoading(false));
      },
      [controller]
    );
    useEffect(() => {
      void loadWorkspaces(false);
    }, [loadWorkspaces]);
    useEffect(() => {
      let live = true;
      controller.getApprovalMode().then((mode) => {
        if (live && mode) setApprovalModeValue(mode);
      }).catch(() => void 0);
      return () => {
        live = false;
      };
    }, [controller]);
    const onApprovalModeChange = useCallback(
      (mode) => {
        const previous = approvalMode;
        setApprovalModeValue(mode);
        controller.setApprovalMode(mode).catch((err) => {
          setApprovalModeValue(previous);
          setError(err instanceof Error ? err.message : String(err));
        });
      },
      [controller, approvalMode]
    );
    const wsOptions = useMemo(() => workspaceOptions(workspaces), [workspaces]);
    const onPickWorkspace = useCallback(
      (cwd) => {
        controller.pickWorkspace(cwd).catch((err) => setError(err instanceof Error ? err.message : String(err)));
      },
      [controller]
    );
    const onRescanWorkspaces = useCallback(() => {
      void loadWorkspaces(true);
    }, [loadWorkspaces]);
    const gitDir = useMemo(
      () => gitTargetDir(timeline.meta.cwd, state.workspace, workspaces?.home ?? ""),
      [timeline.meta.cwd, state.workspace, workspaces?.home]
    );
    useEffect(() => {
      let live = true;
      if (!gitDir) {
        setGit(null);
        return () => {
          live = false;
        };
      }
      setGitLoading(true);
      controller.gitInfo(gitDir).catch(() => null).then((info) => {
        if (live) setGit(info);
      }).finally(() => {
        if (live) setGitLoading(false);
      });
      return () => {
        live = false;
      };
    }, [controller, gitDir, gitTick]);
    const refreshGit = useCallback(() => setGitTick((tick) => tick + 1), []);
    const wasRunning = useRef(false);
    useEffect(() => {
      const running2 = timeline.meta.running;
      if (wasRunning.current && !running2) setGitTick((tick) => tick + 1);
      wasRunning.current = running2;
    }, [timeline.meta.running]);
    const loadProjects = useCallback(() => {
      setProjectsLoading(true);
      return controller.projectsTree().then((tree2) => {
        setProjectTree(tree2);
        setProjectsFailed(false);
      }).catch(() => setProjectsFailed(true)).finally(() => setProjectsLoading(false));
    }, [controller]);
    useEffect(() => {
      if (historyMode !== "projects" || projectTree !== null) return;
      void loadProjects();
    }, [historyMode, projectTree, loadProjects]);
    useEffect(() => {
      if (!historyOpen) return;
      void refreshStored();
    }, [historyOpen, refreshStored]);
    const loadProjectSessions = useCallback(
      (projectId) => {
        setLoadingProjectId(projectId);
        controller.projectSessions(projectId).then((project) => {
          setProjectSessionCache((prev) => ({ ...prev, [projectId]: sessionsOfProject(project) }));
        }).catch(() => setProjectSessionCache((prev) => ({ ...prev, [projectId]: [] }))).finally(() => setLoadingProjectId((current) => current === projectId ? null : current));
      },
      [controller]
    );
    const projectRowsAll = useMemo(() => projectRows(projectTree), [projectTree]);
    const projectViewRows = useMemo(
      () => visibleProjectRows(projectRowsAll, hiddenProjects),
      [projectRowsAll, hiddenProjects]
    );
    const hiddenProjectTotal = useMemo(
      () => hiddenProjectCount(projectRowsAll, hiddenProjects),
      [projectRowsAll, hiddenProjects]
    );
    const updateHiddenProjects = useCallback(
      (next) => {
        setHiddenProjects(next);
        writeHiddenProjects(storageOrNull(), currentProfile(), next);
      },
      []
    );
    const onRenameProject = useCallback(
      (projectId, name) => {
        controller.renameProject(projectId, name).then(() => loadProjects()).catch((err) => {
          setError(`${t.projectRenameFailed}: ${err instanceof Error ? err.message : String(err)}`);
          void loadProjects();
        });
      },
      [controller, loadProjects, t]
    );
    const onRemoveProject = useCallback(
      (project) => {
        const kind = projectRemoval(project);
        if (kind === "none") return;
        if (kind === "hide") {
          updateHiddenProjects([...hiddenProjects, project.id]);
          return;
        }
        controller.deleteProject(project.id).then(() => loadProjects()).catch(
          (err) => setError(`${t.projectRemoveFailed}: ${err instanceof Error ? err.message : String(err)}`)
        );
      },
      [controller, hiddenProjects, loadProjects, t, updateHiddenProjects]
    );
    const onRestoreHiddenProjects = useCallback(() => updateHiddenProjects([]), [updateHiddenProjects]);
    const onNewChatInProject = useCallback(
      (workspace) => {
        controller.setWorkspace(workspace);
        controller.newSession().catch((err) => setError(err instanceof Error ? err.message : String(err)));
      },
      [controller]
    );
    const stickToBottom = useCallback(() => {
      const el = scrollerRef.current;
      if (el) el.scrollTop = el.scrollHeight;
      pinRef.current = { lastTop: el?.scrollTop ?? 0, released: false };
    }, []);
    React.useLayoutEffect(() => {
      stickToBottom();
    }, [state.activeKey, stickToBottom]);
    React.useLayoutEffect(() => {
      const el = scrollerRef.current;
      if (!el) return;
      const next = followAfterChange(
        { scrollTop: el.scrollTop, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight },
        pinRef.current
      );
      pinRef.current = next.state;
      if (next.decision === "follow") el.scrollTop = el.scrollHeight;
    }, [timeline.items.length, timeline.items.at(-1), visibleCards.length]);
    const retire = useCallback((id) => {
      setCards((prev) => prev.filter((card) => card.id !== id));
    }, []);
    const onSend = useCallback(
      (text, attachments2 = []) => {
        setError(null);
        if (notifyState === "needs-permission") {
          void requestNotificationPermission().then((permission) => {
            setNotifyPermission(permission);
            if (permission === "granted") raiseTestNotification(localeRef.current);
          });
        }
        const target = editing;
        setEditing(null);
        stickToBottom();
        const run = target ? controller.editAndResend(target.itemId, text) : controller.send(text, attachments2);
        run.then(() => {
          setAttachments([]);
        }).catch((err) => setError(err instanceof Error ? err.message : String(err)));
      },
      [controller, editing, notifyState, stickToBottom]
    );
    const onToggleNotify = useCallback(() => {
      if (notifyState === "on" || notifyState === "blocked") {
        setNotifyEnabled(false);
        setNotifyOn(false);
        return;
      }
      setNotifyEnabled(true);
      setNotifyOn(true);
      void requestNotificationPermission().then((permission) => {
        setNotifyPermission(permission);
        if (permission === "granted") raiseTestNotification(localeRef.current);
      });
    }, [notifyState]);
    const onEdit = useCallback((itemId, text) => {
      setError(null);
      setEditing({ itemId, text });
    }, []);
    const onStop = useCallback(() => {
      controller.interrupt().catch(() => void 0);
    }, [controller]);
    const refreshChat = useCallback(
      () => controller.resync().then(() => {
        refreshStored();
        refreshGit();
      }).catch((err) => setError(err instanceof Error ? err.message : String(err))),
      [controller, refreshStored, refreshGit]
    );
    const onPickFiles = useCallback(
      (files) => {
        const { accepted, rejected } = screenDroppedFiles(files);
        for (const item of rejected) controller.notice(`${item.name}: ${rejectionLabel(item, t)}`, "error");
        for (const { file, id } of accepted) {
          const previewUrl = file.type.startsWith("image/") || file.type.startsWith("video/") ? URL.createObjectURL(file) : void 0;
          const pending = {
            id,
            kind: classifyFile(file.name, file.type),
            name: file.name,
            size: file.size,
            status: "staging",
            phase: "reading",
            readProgress: 0,
            previewUrl
          };
          setAttachments((prev) => addAttachment(prev, pending));
          controller.attachFile(
            {
              name: file.name,
              type: file.type,
              size: file.size,
              // `readAsDataURL` reports no progress, so the read is chunked into
              // the same base64 shape by hand — over a remote dashboard this is
              // where the seconds go for a large file, and a spinner with no
              // number reads as "stuck".
              dataUrl: (onRead) => readAsDataUrl(file, onRead)
            },
            id,
            (patch) => setAttachments((prev) => updateAttachment(prev, id, patch))
          ).then((done) => setAttachments((prev) => updateAttachment(prev, id, done))).catch(
            (err) => setAttachments(
              (prev) => updateAttachment(prev, id, {
                status: "error",
                error: err instanceof Error ? err.message : String(err)
              })
            )
          );
        }
      },
      [controller, t]
    );
    const onRemoveAttachment = useCallback((id) => {
      setAttachments((prev) => removeAttachment(prev, id));
    }, []);
    const openModelPicker = useCallback(() => {
      setPickerOpen(true);
      setPickerLoading(true);
      controller.listModels().then((result) => {
        setProviders(result.providers);
        setModelChoice({ model: result.model, provider: result.provider });
      }).catch((err) => setError(err instanceof Error ? err.message : String(err))).finally(() => setPickerLoading(false));
    }, [controller]);
    const applyModel = useCallback(
      (model, provider, confirmed) => {
        controller.setModel(model, provider, { sessionOnly: true, confirmExpensive: confirmed }).then((result) => {
          if (result.confirmRequired) {
            setPendingSwitch({
              model,
              provider,
              message: result.confirmMessage || t.modelConfirmFallback
            });
            return;
          }
          setPendingSwitch(null);
          setModelChoice({ model, provider });
          if (result.deferred) controller.notice(t.modelQueued);
        }).catch((err) => {
          setPendingSwitch(null);
          setError(err instanceof Error ? err.message : String(err));
        });
      },
      [controller, t]
    );
    const onPickModel = useCallback(
      (model, provider) => {
        setPickerOpen(false);
        applyModel(model, provider, false);
      },
      [applyModel]
    );
    const onPickReasoning = useCallback(
      (level) => {
        setReasoning(level);
        controller.setReasoning(level).catch((err) => setError(err instanceof Error ? err.message : String(err)));
      },
      [controller]
    );
    const onOpenStored = useCallback(
      (id, title) => {
        controller.openStoredSession(id, title).catch((err) => setError(err instanceof Error ? err.message : String(err)));
      },
      [controller]
    );
    const onNew = useCallback(() => {
      controller.newSession().catch((err) => setError(err instanceof Error ? err.message : String(err)));
    }, [controller]);
    const onRename = useCallback(
      (id, title) => {
        controller.renameStoredSession(id, title).then(() => refreshStored()).catch((err) => setError(err instanceof Error ? err.message : String(err)));
      },
      [controller, refreshStored]
    );
    const onDelete = useCallback(
      (id) => {
        controller.deleteStoredSession(id).then(() => refreshStored()).catch((err) => setError(err instanceof Error ? err.message : String(err)));
      },
      [controller, refreshStored]
    );
    const onUseAsContext = useCallback(
      (id, title) => {
        controller.contextForStoredSession(id, title).then((block) => {
          if (!block.text) {
            setError(t.contextEmpty);
            return;
          }
          insertionSeq.current += 1;
          setInsertion({ seq: insertionSeq.current, text: block.text });
        }).catch(
          (err) => setError(t.contextFailed(err instanceof Error ? err.message : String(err)))
        );
      },
      [controller, t]
    );
    const onDropSession = useCallback(
      (payload) => {
        const ref = parseSessionDrop(payload);
        if (ref) onUseAsContext(ref.id, ref.title);
      },
      [onUseAsContext]
    );
    const onCopy = useCallback((text) => {
      const write = navigator.clipboard?.writeText(text);
      if (write) write.catch(() => fallbackCopy2(text));
      else fallbackCopy2(text);
    }, []);
    const onRegenerate = useCallback(
      (itemId) => {
        controller.regenerateAssistant(itemId).catch((err) => setError(err instanceof Error ? err.message : String(err)));
      },
      [controller]
    );
    const onBranch = useCallback(
      (itemId) => {
        controller.branchSession(itemId).then(() => refreshStored()).catch((err) => setError(err instanceof Error ? err.message : String(err)));
      },
      [controller, refreshStored]
    );
    const tabs = state.tabs;
    const activeStoredId = tabs.find((t2) => t2.key === state.activeKey)?.storedId ?? null;
    const socketOpen = controller.getConnection().state === "open";
    const composerConnected = tabs.length === 0 ? socketOpen : timeline.meta.connected;
    const status = runningLabel(timeline.meta, t);
    return React.createElement(
      "div",
      { className: "flex h-full min-h-0 flex-col", "data-layout": mobile ? "mobile" : "desktop" },
      // ── tabs, or the phone's two floating buttons ───────────────────────
      // The strip is not restyled on a phone, it is REPLACED: one horizontal bar
      // of tabs plus a history toggle costs ~40px of a 640px viewport and has no
      // room for the two actions that matter there. Instead two 40px round
      // buttons float over the transcript — refresh on the left (the chat's data,
      // not the browser page), the drawer handle on the right.
      mobile ? React.createElement(
        "div",
        { className: "hb-fab-row", "data-hb": "fab-row" },
        React.createElement(
          "button",
          {
            type: "button",
            "data-hb": "refresh-chat",
            className: "hb-fab",
            title: t.refreshChat,
            "aria-label": t.refreshChat,
            onClick: () => void refreshChat()
          },
          Icon(sdk, { name: "refresh", size: 17 })
        ),
        React.createElement(
          "button",
          {
            type: "button",
            "data-hb": "drawer-toggle",
            "data-open": historyOpen ? "true" : "false",
            className: "hb-fab",
            title: t.chatMenu,
            "aria-label": t.chatMenu,
            "aria-expanded": historyOpen,
            onClick: () => setHistoryOpen((v) => !v)
          },
          Icon(sdk, { name: "dots", size: 18 }),
          // A waiting request on a background session must still be visible
          // with no tab strip to mark it.
          waiting.length ? React.createElement("span", {
            className: "hb-fab-badge",
            "data-hb": "tab-waiting",
            title: t.waitingForAnswer,
            "aria-label": t.waitingForAnswer
          }) : null,
          running.length ? React.createElement("span", { className: "hb-fab-dot", "aria-hidden": "true" }) : null
        )
      ) : React.createElement(TabStrip, {
        sdk,
        locale,
        tabs,
        activeKey: state.activeKey,
        runningKeys: running,
        waitingKeys: waiting,
        historyOpen,
        onFocus: (key) => controller.focusSession(key),
        onClose: (key) => controller.closeSession(key),
        onNew,
        onRefreshChat: refreshChat,
        onToggleHistory: () => setHistoryOpen((v) => !v)
      }),
      // ── transcript + history ────────────────────────────────────────────
      // `min-w-0` on every flex item in this chain: a flex item defaults to
      // `min-width:auto`, i.e. it refuses to shrink below its content's
      // min-content width. One long code line or unbreakable token then blows the
      // whole chat column out to ~900px on a 390px phone — the transcript renders
      // past both edges and the host's `overflow:hidden` clips it with no way to
      // scroll. `min-w-0` lets the column shrink to the viewport and pushes the
      // overflow down into the code block's own scroller.
      React.createElement(
        "div",
        { className: "flex min-h-0 min-w-0 flex-1" },
        React.createElement(
          "div",
          { className: "flex min-h-0 min-w-0 flex-1 flex-col" },
          React.createElement(
            "div",
            { className: "relative flex min-h-0 min-w-0 flex-1" },
            React.createElement(
              "div",
              {
                className: "min-h-0 flex-1 overflow-y-auto px-4 py-4 hb-scroll",
                ref: scrollerRef,
                // The reader's own scrolling is the only signal for "stop following
                // the stream" — see `core/pin.ts` for why position alone is not.
                onScroll: (event) => {
                  const el = event.currentTarget;
                  pinRef.current = pinAfterScroll(
                    { scrollTop: el.scrollTop, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight },
                    pinRef.current
                  );
                },
                "data-hb": "transcript"
              },
              React.createElement(
                "div",
                { className: "mx-auto flex flex-col", style: { maxWidth: "860px" } },
                timeline.items.length === 0 ? React.createElement(
                  "div",
                  { className: "py-16 text-center text-sm", style: { color: "var(--color-muted-foreground)" } },
                  t.empty
                ) : segments.map(
                  (segment) => segment.type === "run" ? React.createElement(
                    "div",
                    {
                      key: segment.key,
                      className: "hb-bubble-gap",
                      // Machinery between two messages, capped (see
                      // `ui/Activity.ts`). This is the wrapper the block owns,
                      // so its own rhythm class differs from a single row.
                      "data-hb-kind": "run"
                    },
                    React.createElement(ActivityBlock, { sdk, items: segment.items, locale })
                  ) : React.createElement(
                    "div",
                    {
                      key: segment.key,
                      className: "hb-bubble-gap",
                      // Per-kind vertical rhythm: messages breathe, tool rows and
                      // thinking blocks pack (see style.css).
                      "data-hb-kind": segment.item.kind,
                      // Anchor for the locator rail's scroll-to.
                      "data-hb-item": segment.item.id
                    },
                    React.createElement(Bubble, {
                      sdk,
                      item: segment.item,
                      locale,
                      onEdit,
                      onBranch,
                      onRegenerate,
                      onCopy
                    })
                  )
                ),
                visibleCards.map(
                  (card) => React.createElement(
                    "div",
                    { key: card.id, className: "hb-bubble-gap" },
                    card.method === "approval" ? React.createElement(ApprovalCard, {
                      sdk,
                      card,
                      locale,
                      onAnswer: (choice) => {
                        card.respond(approvalResult(choice));
                        retire(card.id);
                      }
                    }) : React.createElement(ClarifyCard, {
                      sdk,
                      card,
                      locale,
                      onSubmit: (result) => {
                        card.respond(result);
                        retire(card.id);
                      }
                    })
                  )
                ),
                error ? React.createElement(
                  "div",
                  { className: "text-xs", style: { color: "var(--color-destructive)" } },
                  error
                ) : null
              )
            ),
            React.createElement(LocatorRail, {
              sdk,
              locale,
              items: timeline.items,
              scrollerRef
            })
          ),
          // The task list sits directly above the composer: it describes what the
          // running turn is doing, and that is where the eye already is.
          timeline.meta.todo ? React.createElement(
            "div",
            { className: "px-4", style: { paddingBottom: "0.375rem" } },
            React.createElement(
              "div",
              { className: "mx-auto", style: { maxWidth: "860px" } },
              React.createElement(TodoPanel, { sdk, locale, todo: timeline.meta.todo })
            )
          ) : null,
          React.createElement(Composer, {
            sdk,
            locale,
            mobile,
            editingText: editing?.text ?? null,
            onCancelEdit: () => setEditing(null),
            running: timeline.meta.running,
            status,
            connected: composerConnected,
            usage: timeline.meta.usage,
            model: modelChoice.model || timeline.meta.model,
            provider: modelChoice.provider || timeline.meta.provider,
            reasoning,
            attachments,
            catalog,
            notifyState,
            onToggleNotify,
            onSend,
            onStop,
            onPickFiles,
            onRemoveAttachment,
            onOpenModelPicker: openModelPicker,
            onPickReasoning,
            onError: setError,
            insertion,
            onDropSession,
            workspace: state.workspace,
            workspaceCurrent: timeline.meta.cwd,
            workspaceOptions: wsOptions,
            workspaceHome: workspaces?.home ?? "",
            workspaceLoading,
            workspaceFailed,
            git,
            gitLoading,
            onRefreshGit: refreshGit,
            onPickWorkspace,
            onRescanWorkspaces,
            approvalMode,
            onApprovalModeChange
          })
        ),
        React.createElement(HistoryPanel, {
          sdk,
          locale,
          open: historyOpen,
          variant: mobile ? "drawer" : "panel",
          mode: historyMode,
          onModeChange: setHistoryMode,
          onRefreshProjects: () => {
            void loadProjects();
          },
          projectView: {
            rows: projectViewRows,
            loading: projectsLoading,
            failed: projectsFailed,
            activeStoredId,
            openStoredIds: tabs.map((tab) => tab.storedId).filter((id) => Boolean(id)),
            busyStoredIds: tabs.filter((tab) => running.includes(tab.key)).map((tab) => tab.storedId).filter((id) => Boolean(id)),
            sessionCache: projectSessionCache,
            loadingProjectId,
            hiddenCount: hiddenProjectTotal,
            onExpand: loadProjectSessions,
            onOpen: (id) => onOpenStored(id, ""),
            onNewChat: onNewChatInProject,
            onRename: onRenameProject,
            onRemove: onRemoveProject,
            onRestoreHidden: onRestoreHiddenProjects
          },
          sessions: stored,
          loading: loadingStored,
          activeStoredId,
          // Every open tab's stored id feeds the lamp; `running` decides pulse.
          openStoredIds: tabs.map((tab) => tab.storedId).filter((id) => Boolean(id)),
          busyStoredIds: tabs.filter((tab) => running.includes(tab.key)).map((tab) => tab.storedId).filter((id) => Boolean(id)),
          onOpen: onOpenStored,
          onRefresh: refreshStored,
          onRename,
          onDelete,
          onUseAsContext,
          onClose: () => setHistoryOpen(false),
          onNew
        })
      ),
      React.createElement(ModelPicker, {
        sdk,
        locale,
        open: pickerOpen,
        loading: pickerLoading,
        providers,
        currentModel: modelChoice.model || timeline.meta.model,
        currentProvider: modelChoice.provider || timeline.meta.provider,
        reasoning,
        onPick: onPickModel,
        onPickReasoning,
        onClose: () => setPickerOpen(false)
      }),
      pendingSwitch ? React.createElement(ConfirmDialog, {
        sdk,
        title: t.modelConfirmTitle,
        message: pendingSwitch.message,
        acceptLabel: t.modelConfirmAccept,
        cancelLabel: t.cancel,
        onAccept: () => applyModel(pendingSwitch.model, pendingSwitch.provider, true),
        onCancel: () => setPendingSwitch(null)
      }) : null
    );
  }
  function readAsDataUrl(file, onProgress) {
    const CHUNK = 512 * 1024;
    const total = file.size || 1;
    if (file.size <= CHUNK) {
      return file.arrayBuffer().then((buffer) => {
        onProgress?.(1);
        return dataUrlOf(buffer, file.type);
      });
    }
    const chunks = [];
    let offset = 0;
    const next = () => {
      const end = Math.min(offset + CHUNK, file.size);
      return file.slice(offset, end).arrayBuffer().then((buffer) => {
        chunks.push(new Uint8Array(buffer));
        offset = end;
        onProgress?.(Math.min(1, offset / total));
        if (offset < file.size) return next();
        const joined = new Uint8Array(file.size);
        let at = 0;
        for (const chunk of chunks) {
          joined.set(chunk, at);
          at += chunk.byteLength;
        }
        return dataUrlOf(joined.buffer, file.type);
      });
    };
    return next();
  }
  function dataUrlOf(buffer, type) {
    const bytes = new Uint8Array(buffer);
    let binary = "";
    const STEP = 32768;
    for (let i = 0; i < bytes.length; i += STEP) {
      binary += String.fromCharCode(...bytes.subarray(i, i + STEP));
    }
    return `data:${type || "application/octet-stream"};base64,${btoa(binary)}`;
  }
  function fallbackCopy2(text) {
    try {
      const area = document.createElement("textarea");
      area.value = text;
      area.setAttribute("readonly", "");
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      document.execCommand("copy");
      area.remove();
    } catch {
    }
  }

  // src/index.ts
  (function main() {
    const sdk = requireSdk();
    const registry = window.__HERMES_PLUGINS__;
    if (!registry) {
      console.error("hermes-bubbles: window.__HERMES_PLUGINS__ is missing \u2014 the dashboard is too old for plugins.");
      return;
    }
    const { React } = sdk;
    function Root() {
      try {
        return React.createElement(ChatPage, { sdk });
      } catch (error) {
        console.error("hermes-bubbles: render failed", error);
        return React.createElement(
          "div",
          { style: { padding: "1rem", color: "var(--color-destructive)" } },
          messagesFor(currentLocale()).renderFailed(
            error instanceof Error ? error.message : String(error)
          )
        );
      }
    }
    registry.register("hermes-bubbles", Root);
  })();
})();
