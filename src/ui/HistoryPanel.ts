/**
 * The history panel on the right: stored sessions you can open.
 *
 * Collapsible, because it competes with the transcript for horizontal space and
 * most of a session is spent not looking at it.
 */

import type { HermesPluginSdk } from "./sdk";

export interface StoredSession {
  id: string;
  title: string;
  preview: string;
  started_at: number;
  message_count: number;
}

export interface HistoryPanelProps {
  sdk: HermesPluginSdk;
  open: boolean;
  sessions: readonly StoredSession[];
  loading: boolean;
  activeStoredId: string | null;
  onOpen: (id: string, title: string) => void;
  onRefresh: () => void;
  onClose: () => void;
}

function relativeTime(seconds: number, sdk: HermesPluginSdk): string {
  if (!seconds) return "";
  const ms = seconds * 1000;
  try {
    const formatted = sdk.utils.timeAgo(ms);
    if (formatted) return formatted;
  } catch {
    // fall through to the coarse bucket
  }
  const minutes = Math.round((Date.now() - ms) / 60000);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.round(hours / 24)} 天前`;
}

export function HistoryPanel(props: HistoryPanelProps) {
  const { sdk } = props;
  const { React } = sdk;

  if (!props.open) return null;

  return React.createElement(
    "div",
    {
      className: "flex h-full min-h-0 flex-col",
      style: { width: "17rem", borderLeft: "1px solid var(--color-border)" },
    },

    React.createElement(
      "div",
      { className: "flex shrink-0 items-center gap-1 px-3 py-2" },
      React.createElement(
        "span",
        {
          className: "hb-text-micro uppercase tracking-[0.06em]",
          style: { color: "var(--color-muted-foreground)" },
        },
        "历史会话",
      ),
      React.createElement(
        "div",
        { className: "ml-auto flex items-center gap-1" },
        React.createElement(
          "button",
          {
            type: "button",
            title: "刷新",
            className: "cursor-pointer px-1.5 text-xs",
            style: { color: "var(--color-muted-foreground)" },
            onClick: props.onRefresh,
          },
          "⟳",
        ),
        React.createElement(
          "button",
          {
            type: "button",
            title: "收起",
            className: "cursor-pointer px-1.5 text-xs",
            style: { color: "var(--color-muted-foreground)" },
            onClick: props.onClose,
          },
          "»",
        ),
      ),
    ),

    React.createElement(
      "div",
      { className: "min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2 pb-2 hb-scroll" },
      props.loading
        ? React.createElement(
            "div",
            { className: "hb-text-micro px-2 py-1", style: { color: "var(--color-muted-foreground)" } },
            "载入中…",
          )
        : props.sessions.length === 0
          ? React.createElement(
              "div",
              { className: "hb-text-micro px-2 py-1", style: { color: "var(--color-muted-foreground)" } },
              "没有历史会话",
            )
          : props.sessions.map((session) => {
              const isActive = session.id === props.activeStoredId;
              return React.createElement(
                "div",
                {
                  key: session.id,
                  className: "cursor-pointer px-2 py-1.5 text-xs",
                  style: {
                    borderRadius: "calc(var(--radius) * 0.6)",
                    color: "var(--color-foreground)",
                    background: isActive ? "var(--color-muted)" : "transparent",
                  },
                  title: session.preview || session.title,
                  onClick: () => props.onOpen(session.id, session.title || session.id.slice(0, 8)),
                  onMouseEnter: (event: { currentTarget: { style: { background: string } } }) => {
                    if (!isActive) event.currentTarget.style.background = "var(--color-muted)";
                  },
                  onMouseLeave: (event: { currentTarget: { style: { background: string } } }) => {
                    if (!isActive) event.currentTarget.style.background = "transparent";
                  },
                },
                React.createElement(
                  "div",
                  { className: "flex items-baseline gap-1.5" },
                  React.createElement("span", { className: "hb-flex-fill hb-truncate" }, session.title || "未命名"),
                  React.createElement(
                    "span",
                    {
                      className: "hb-text-tiny shrink-0",
                      style: { color: "var(--color-muted-foreground)" },
                    },
                    relativeTime(session.started_at, sdk),
                  ),
                ),
                session.preview
                  ? React.createElement(
                      "div",
                      {
                        className: "hb-text-tiny hb-truncate",
                        style: { color: "var(--color-muted-foreground)" },
                      },
                      session.preview,
                    )
                  : null,
              );
            }),
    ),
  );
}
