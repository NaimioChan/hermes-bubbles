/**
 * The history panel on the right: stored sessions you can open.
 *
 * Collapsible, because it competes with the transcript for horizontal space and
 * most of a session is spent not looking at it.
 */

import { messagesFor, type Locale } from "../core/i18n";
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
  locale: Locale;
  open: boolean;
  sessions: readonly StoredSession[];
  loading: boolean;
  activeStoredId: string | null;
  onOpen: (id: string, title: string) => void;
  onRefresh: () => void;
  onClose: () => void;
}

function relativeTime(seconds: number, sdk: HermesPluginSdk, locale: Locale): string {
  if (!seconds) return "";
  const ms = seconds * 1000;
  try {
    // The host's own formatter is already in the dashboard's language.
    const formatted = sdk.utils.timeAgo(ms);
    if (formatted) return formatted;
  } catch {
    // fall through to the localized bucket
  }
  const t = messagesFor(locale);
  const minutes = Math.round((Date.now() - ms) / 60000);
  if (minutes < 60) return t.minutesAgo(minutes);
  const hours = Math.round(minutes / 60);
  if (hours < 24) return t.hoursAgo(hours);
  return t.daysAgo(Math.round(hours / 24));
}

export function HistoryPanel(props: HistoryPanelProps) {
  const { sdk } = props;
  const { React } = sdk;
  const t = messagesFor(props.locale);

  if (!props.open) return null;

  return React.createElement(
    "div",
    {
      className: "flex h-full min-h-0 flex-col",
      "data-hb": "history-panel",
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
        t.history,
      ),
      React.createElement(
        "div",
        { className: "ml-auto flex items-center gap-1" },
        React.createElement(
          "button",
          {
            type: "button",
            title: t.refreshTitle,
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
            title: t.collapse,
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
            t.historyLoading,
          )
        : props.sessions.length === 0
          ? React.createElement(
              "div",
              { className: "hb-text-micro px-2 py-1", style: { color: "var(--color-muted-foreground)" } },
              t.historyEmpty,
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
                    color: "var(--color-card-foreground)",
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
                  React.createElement("span", { className: "hb-flex-fill hb-truncate" }, session.title || t.untitled),
                  React.createElement(
                    "span",
                    {
                      className: "hb-text-tiny shrink-0",
                      style: { color: "var(--color-muted-foreground)" },
                    },
                    relativeTime(session.started_at, sdk, props.locale),
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
