/**
 * The history panel on the right: stored sessions you can open.
 *
 * Collapsible, because it competes with the transcript for horizontal space and
 * most of a session is spent not looking at it.
 */

import { messagesFor, type Locale } from "../core/i18n";
import type { HermesPluginSdk } from "./sdk";
import { ProjectList, type ProjectListProps } from "./ProjectList";

export interface StoredSession {
  id: string;
  title: string;
  preview: string;
  started_at: number;
  message_count: number;
}

/** Which body the panel shows: the flat recent list, or projects. */
export type HistoryMode = "recent" | "projects";

export interface HistoryPanelProps {
  sdk: HermesPluginSdk;
  locale: Locale;
  open: boolean;
  mode: HistoryMode;
  onModeChange: (mode: HistoryMode) => void;
  /** Everything the project view needs, minus sdk/locale (this component adds those). */
  projectView: Omit<ProjectListProps, "sdk" | "locale">;
  onRefreshProjects: () => void;
  sessions: readonly StoredSession[];
  loading: boolean;
  activeStoredId: string | null;
  /**
   * Stored ids that are OPEN in a tab right now.
   *
   * Distinct from `activeStoredId` (the tab currently focused): the point of the
   * dot is to answer "have I already got this one open?", so every open session
   * gets one, and the focused one is brighter.
   */
  openStoredIds: readonly string[];
  /** Stored ids whose session is mid-turn, for the pulsing dot. */
  busyStoredIds: readonly string[];
  onOpen: (id: string, title: string) => void;
  onRename: (id: string, title: string) => void;
  onDelete: (id: string) => void;
  onRefresh: () => void;
  onClose: () => void;
}

export function relativeTime(seconds: number, sdk: HermesPluginSdk, locale: Locale): string {
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
  const { useState } = sdk.hooks;
  const t = messagesFor(props.locale);
  // Which row is being renamed, and the draft. Null means no row is editing.
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

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
            onClick: props.mode === "projects" ? props.onRefreshProjects : props.onRefresh,
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
          onClick: () => props.onModeChange("recent"),
        },
        t.recent,
      ),
      React.createElement(
        "button",
        {
          type: "button",
          "data-hb": "history-mode-projects",
          "data-active": props.mode === "projects" ? "true" : "false",
          className: "hb-proj-tab",
          onClick: () => props.onModeChange("projects"),
        },
        t.projects,
      ),
    ),

    props.mode === "projects"
      ? React.createElement(ProjectList, {
          sdk: props.sdk,
          locale: props.locale,
          ...props.projectView,
        })
      : React.createElement(
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
                  renamingId === session.id
                    ? React.createElement("input", {
                        autoFocus: true,
                        value: draft,
                        "data-hb": "rename-input",
                        className: "hb-input hb-flex-fill",
                        style: { fontSize: "0.75rem", padding: "0.1rem 0.3rem" },
                        onClick: (event: { stopPropagation: () => void }) => event.stopPropagation(),
                        onChange: (event: { target: { value: string } }) => setDraft(event.target.value),
                        // Read the value off the ELEMENT rather than the `draft`
                        // state: React commits state on its own schedule, so a
                        // fast type-then-Enter (or a scripted one) would otherwise
                        // commit the previous value and rename to the old title.
                        onKeyDown: (event: {
                          key: string;
                          currentTarget: { value: string };
                          preventDefault: () => void;
                          stopPropagation: () => void;
                        }) => {
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
                        },
                      })
                    : React.createElement(
                        "span",
                        { className: "hb-flex-fill hb-truncate" },
                        session.title || t.untitled,
                      ),
                  // A small lamp, the same signal the tab strip uses: filled and
                  // pulsing while that session is running, dim while merely open.
                  props.openStoredIds.includes(session.id)
                    ? React.createElement("span", {
                        className: props.busyStoredIds.includes(session.id) ? "hb-dot hb-caret" : "hb-dot",
                        "data-hb": "session-active",
                        "data-state": props.busyStoredIds.includes(session.id) ? "busy" : "open",
                        title: props.busyStoredIds.includes(session.id) ? t.sessionRunning : t.sessionOpen,
                        style: {
                          width: "0.4rem",
                          height: "0.4rem",
                          borderRadius: "9999px",
                          background: "var(--color-primary)",
                          opacity: session.id === props.activeStoredId ? 1 : 0.45,
                        },
                      })
                    : null,
                  React.createElement(
                    "span",
                    {
                      className: "hb-text-tiny shrink-0",
                      style: { color: "var(--color-muted-foreground)" },
                    },
                    relativeTime(session.started_at, sdk, props.locale),
                  ),
                  // Hidden until the row is hovered, so the list stays quiet.
                  React.createElement(
                    "span",
                    { className: "hb-row-tools shrink-0 flex items-center gap-0.5" },
                    React.createElement(
                      "button",
                      {
                        type: "button",
                        title: t.rename,
                        "aria-label": t.rename,
                        "data-hb": "rename-session",
                        className: "hb-action-btn",
                        onClick: (event: { stopPropagation: () => void }) => {
                          event.stopPropagation();
                          setDraft(session.title || "");
                          setRenamingId(session.id);
                        },
                      },
                      "✎",
                    ),
                    React.createElement(
                      "button",
                      {
                        type: "button",
                        title: t.delete,
                        "aria-label": t.delete,
                        "data-hb": "delete-session",
                        className: "hb-action-btn",
                        onClick: (event: { stopPropagation: () => void }) => {
                          event.stopPropagation();
                          // Destructive and irreversible: confirm in the host's
                          // own dialog rather than acting on a stray click.
                          if (window.confirm(t.deleteConfirm)) props.onDelete(session.id);
                        },
                      },
                      "🗑",
                    ),
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
