/**
 * The session sidebar: open tabs on top, stored sessions below.
 *
 * Two lists on purpose — "what I have open" and "what exists" are different
 * questions, and merging them makes it impossible to tell whether closing a row
 * discards work.
 */

import type { SessionTab } from "../core/sessions";
import { tabLabel } from "../core/sessions";
import type { HermesPluginSdk } from "./sdk";

export interface StoredSession {
  id: string;
  title: string;
  preview: string;
  started_at: number;
  message_count: number;
}

export interface SidebarProps {
  sdk: HermesPluginSdk;
  tabs: readonly SessionTab[];
  activeKey: string | null;
  runningKeys: readonly string[];
  stored: readonly StoredSession[];
  loadingStored: boolean;
  onFocus: (key: string) => void;
  onClose: (key: string) => void;
  onNew: () => void;
  onOpenStored: (id: string, title: string) => void;
  onRefresh: () => void;
}

function relativeTime(seconds: number, sdk: HermesPluginSdk): string {
  if (!seconds) return "";
  const ms = seconds * 1000;
  // The host's formatter is available and already localized; fall back to a
  // coarse bucket rather than inventing a second time format.
  try {
    const formatted = sdk.utils.timeAgo(ms);
    if (formatted) return formatted;
  } catch {
    // fall through
  }
  const minutes = Math.round((Date.now() - ms) / 60000);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.round(hours / 24)} 天前`;
}

export function SessionSidebar(props: SidebarProps) {
  const { sdk } = props;
  const { React } = sdk;
  const { useState } = sdk.hooks;

  const [collapsed, setCollapsed] = useState(false);

  const rowStyle = (active: boolean) => ({
    background: active ? "var(--color-accent, var(--color-muted))" : "transparent",
    borderRadius: "calc(var(--radius) * 0.6)",
    color: "var(--color-foreground)",
  });

  if (collapsed) {
    return React.createElement(
      "div",
      { className: "flex h-full flex-col items-center py-2", style: { width: "2.25rem" } },
      React.createElement(
        "button",
        {
          type: "button",
          title: "展开会话列表",
          className: "cursor-pointer px-2 py-1",
          style: { color: "var(--color-muted-foreground)" },
          onClick: () => setCollapsed(false),
        },
        "»",
      ),
      React.createElement(
        "button",
        {
          type: "button",
          title: "新对话",
          className: "mt-2 cursor-pointer px-2 py-1 text-base leading-none",
          style: { color: "var(--color-muted-foreground)" },
          onClick: props.onNew,
        },
        "+",
      ),
    );
  }

  return React.createElement(
    "div",
    {
      className: "flex h-full min-h-0 flex-col gap-2 p-2",
      style: { width: "15rem", borderRight: "1px solid var(--color-border)" },
    },

    // header
    React.createElement(
      "div",
      { className: "flex items-center gap-1" },
      React.createElement(
        "span",
        { className: "text-[0.6875rem] uppercase tracking-[0.06em]", style: { color: "var(--color-muted-foreground)" } },
        "会话",
      ),
      React.createElement(
        "div",
        { className: "ml-auto flex items-center gap-1" },
        React.createElement(
          "button",
          {
            type: "button",
            title: "新对话",
            className: "cursor-pointer px-1.5 py-0.5 text-sm leading-none",
            style: { color: "var(--color-muted-foreground)" },
            onClick: props.onNew,
          },
          "+",
        ),
        React.createElement(
          "button",
          {
            type: "button",
            title: "收起",
            className: "cursor-pointer px-1.5 py-0.5 text-xs leading-none",
            style: { color: "var(--color-muted-foreground)" },
            onClick: () => setCollapsed(true),
          },
          "«",
        ),
      ),
    ),

    // open tabs
    React.createElement(
      "div",
      { className: "min-h-0 flex-[0_0_auto] space-y-0.5 overflow-y-auto hb-scroll" },
      props.tabs.length === 0
        ? React.createElement(
            "div",
            { className: "px-2 py-1 text-xs", style: { color: "var(--color-muted-foreground)" } },
            "没有打开的会话",
          )
        : props.tabs.map((tab) =>
            React.createElement(
              "div",
              {
                key: tab.key,
                className: "group flex cursor-pointer items-center gap-1.5 px-2 py-1.5 text-xs",
                style: rowStyle(tab.key === props.activeKey),
                onClick: () => props.onFocus(tab.key),
                title: tabLabel(tab),
              },
              props.runningKeys.includes(tab.key)
                ? React.createElement("span", { className: "hb-caret", style: { color: "var(--color-primary)" } }, "●")
                : React.createElement("span", { style: { color: "var(--color-muted-foreground)" } }, tab.draft ? "○" : "•"),
              React.createElement("span", { className: "min-w-0 flex-1 truncate" }, tabLabel(tab)),
              React.createElement(
                "button",
                {
                  type: "button",
                  title: "关闭",
                  className: "cursor-pointer px-1 opacity-0 group-hover:opacity-100",
                  style: { color: "var(--color-muted-foreground)" },
                  onClick: (event: { stopPropagation: () => void }) => {
                    event.stopPropagation();
                    props.onClose(tab.key);
                  },
                },
                "×",
              ),
            ),
          ),
    ),

    // stored sessions
    React.createElement(
      "div",
      { className: "mt-1 flex items-center gap-1" },
      React.createElement(
        "span",
        { className: "text-[0.6875rem] uppercase tracking-[0.06em]", style: { color: "var(--color-muted-foreground)" } },
        "历史",
      ),
      React.createElement(
        "button",
        {
          type: "button",
          title: "刷新",
          className: "ml-auto cursor-pointer px-1.5 text-xs",
          style: { color: "var(--color-muted-foreground)" },
          onClick: props.onRefresh,
        },
        "⟳",
      ),
    ),
    React.createElement(
      "div",
      { className: "min-h-0 flex-1 space-y-0.5 overflow-y-auto hb-scroll" },
      props.loadingStored
        ? React.createElement(
            "div",
            { className: "px-2 py-1 text-xs", style: { color: "var(--color-muted-foreground)" } },
            "载入中…",
          )
        : props.stored.length === 0
          ? React.createElement(
              "div",
              { className: "px-2 py-1 text-xs", style: { color: "var(--color-muted-foreground)" } },
              "没有历史会话",
            )
          : props.stored.map((session) =>
              React.createElement(
                "div",
                {
                  key: session.id,
                  className: "cursor-pointer px-2 py-1.5 text-xs",
                  style: { borderRadius: "calc(var(--radius) * 0.6)", color: "var(--color-foreground)" },
                  title: session.preview || session.title,
                  onClick: () => props.onOpenStored(session.id, session.title || session.id.slice(0, 8)),
                  onMouseEnter: (event: { currentTarget: { style: { background: string } } }) => {
                    event.currentTarget.style.background = "var(--color-muted)";
                  },
                  onMouseLeave: (event: { currentTarget: { style: { background: string } } }) => {
                    event.currentTarget.style.background = "transparent";
                  },
                },
                React.createElement(
                  "div",
                  { className: "flex items-baseline gap-1.5" },
                  React.createElement("span", { className: "min-w-0 flex-1 truncate" }, session.title || "未命名"),
                  React.createElement(
                    "span",
                    { className: "shrink-0 text-[0.625rem]", style: { color: "var(--color-muted-foreground)" } },
                    relativeTime(session.started_at, sdk),
                  ),
                ),
                session.preview
                  ? React.createElement(
                      "div",
                      { className: "truncate text-[0.625rem]", style: { color: "var(--color-muted-foreground)" } },
                      session.preview,
                    )
                  : null,
              ),
            ),
    ),
  );
}
