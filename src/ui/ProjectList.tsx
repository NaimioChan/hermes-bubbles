/**
 * The history panel's project view: projects on top, their sessions underneath.
 *
 * Two layers (project → session). The backend tree carries a third (branch /
 * worktree / kanban lane); that one is collapsed away here — see
 * `core/projects.ts` for why.
 *
 * Rows are for finding and opening a chat. Rename and delete stay on the Recent
 * tab, which owns that interaction: duplicating the inline editor here would
 * double the states this panel has to keep right for no new capability.
 */

import { messagesFor, type Locale } from "../core/i18n";
import { lastActiveOf, type ProjectRow, type ProjectSessionRow } from "../core/projects";
import type { HermesPluginSdk } from "./sdk";
import { relativeTime } from "./HistoryPanel";

export interface ProjectListProps {
  sdk: HermesPluginSdk;
  locale: Locale;
  rows: readonly ProjectRow[];
  loading: boolean;
  failed: boolean;
  activeStoredId: string | null;
  openStoredIds: readonly string[];
  busyStoredIds: readonly string[];
  /** Hydrated sessions per project id; absent until that project is expanded. */
  sessionCache: Record<string, ProjectSessionRow[] | undefined>;
  /** Project whose drill-in is in flight, for the per-row spinner. */
  loadingProjectId: string | null;
  onExpand: (projectId: string) => void;
  onOpen: (id: string) => void;
  onNewChat: (workspace: string) => void;
}

export function ProjectList(props: ProjectListProps) {
  const { sdk } = props;
  const { React } = sdk;
  const { useState } = sdk.hooks;
  const t = messagesFor(props.locale);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const toggle = (row: ProjectRow) => {
    const id = row.project.id;
    const next = !expanded[id];
    setExpanded((prev) => ({ ...prev, [id]: next }));
    // Fetch once per project; the cache is keyed by id and survives collapse.
    if (next && !props.sessionCache[id]) props.onExpand(id);
  };

  const sessionRow = (row: ProjectSessionRow) => {
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
        style: { background: isActive ? "var(--color-muted)" : "transparent" },
        onClick: () => props.onOpen(row.id),
      },
      React.createElement(
        "span",
        { className: "hb-proj-session-title" },
        row.title || t.untitled,
      ),
      isOpen
        ? React.createElement("span", {
            className: isBusy ? "hb-dot hb-caret" : "hb-dot",
            "data-hb": "session-active",
            "data-state": isBusy ? "busy" : "open",
            title: isBusy ? t.sessionRunning : t.sessionOpen,
            style: {
              width: "0.4rem",
              height: "0.4rem",
              borderRadius: "9999px",
              background: "var(--color-primary)",
              opacity: isActive ? 1 : 0.45,
            },
          })
        : null,
      React.createElement(
        "span",
        { className: "hb-proj-session-time", style: { color: "var(--color-muted-foreground)" } },
        relativeTime(lastActiveOf(row), sdk, props.locale),
      ),
    );
  };

  if (props.loading) {
    return React.createElement(
      "div",
      { className: "hb-text-micro px-2 py-1", style: { color: "var(--color-muted-foreground)" } },
      t.historyLoading,
    );
  }

  if (props.failed) {
    return React.createElement(
      "div",
      { className: "hb-text-micro px-2 py-1", style: { color: "var(--color-muted-foreground)" } },
      t.projectsFailed,
    );
  }

  if (props.rows.length === 0) {
    return React.createElement(
      "div",
      { className: "hb-text-micro px-2 py-1", style: { color: "var(--color-muted-foreground)" } },
      t.noProjects,
    );
  }

  return React.createElement(
    "div",
    { "data-hb": "project-list", className: "hb-proj-list" },

    props.rows.map((row) => {
      const id = row.project.id;
      const isOpen = Boolean(expanded[id]);
      const hydrated = props.sessionCache[id];
      const sessions = isOpen && hydrated ? hydrated : row.preview;
      const count = row.project.sessionCount ?? row.project.sessionIds?.length ?? sessions.length;
      const more = count > sessions.length;
      const label = row.project.isNoProject ? t.ungrouped : row.project.label;

      return React.createElement(
        "div",
        { key: id, className: "hb-proj" },

        React.createElement(
          "div",
          { className: "hb-proj-head" },
          React.createElement(
            "button",
            {
              type: "button",
              "data-hb": "project-toggle",
              "data-open": isOpen ? "true" : "false",
              className: "hb-proj-toggle",
              title: label,
              onClick: () => toggle(row),
            },
            React.createElement("span", { className: "hb-proj-caret" }, isOpen ? "▾" : "▸"),
            React.createElement(
              "span",
              {
                className: "hb-proj-name",
                style: {
                  color: row.project.isNoProject ? "var(--color-muted-foreground)" : "var(--color-card-foreground)",
                },
              },
              label,
            ),
            React.createElement("span", { className: "hb-proj-count" }, String(count)),
          ),

          // "New chat here" is the reason this view exists beyond being a list:
          // it aims the next session at the project's folder.
          row.workspace
            ? React.createElement(
                "button",
                {
                  type: "button",
                  "data-hb": "project-new-chat",
                  "data-hb-path": row.workspace,
                  className: "hb-proj-new",
                  title: `${t.newChatInProject}: ${row.workspace}`,
                  "aria-label": t.newChatInProject,
                  onClick: () => props.onNewChat(row.workspace),
                },
                "＋",
              )
            : null,
        ),

        props.loadingProjectId === id && isOpen && !hydrated
          ? React.createElement(
              "div",
              { className: "hb-text-micro hb-proj-note", style: { color: "var(--color-muted-foreground)" } },
              t.historyLoading,
            )
          : null,

        sessions.length
          ? React.createElement(
              "div",
              { className: "hb-proj-body" },
              sessions.map((session) => sessionRow(session)),
            )
          : null,

        isOpen && more && !hydrated
          ? React.createElement(
              "button",
              {
                type: "button",
                "data-hb": "project-expand",
                className: "hb-proj-more",
                onClick: () => props.onExpand(id),
              },
              `${t.showAllSessions} · ${t.projectSessionCount(count)}`,
            )
          : null,
      );
    }),
  );
}
