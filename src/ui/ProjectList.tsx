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
import { SESSION_CONTEXT_MIME, sessionDragPayload } from "../core/context";
import {
  canRenameProject,
  lastActiveOf,
  projectRemoval,
  type ProjectNode,
  type ProjectRow,
  type ProjectSessionRow,
} from "../core/projects";
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
  /** Auto projects hidden client-side that still match a row ("restore" count). */
  hiddenCount: number;
  onExpand: (projectId: string) => void;
  onOpen: (id: string) => void;
  onNewChat: (workspace: string) => void;
  /** Rename a project: writes the `projects.db` row, so explicit projects only. */
  onRename: (projectId: string, name: string) => void;
  /**
   * Remove a row: the caller decides between a real `projects.delete` and a
   * client-side hide, from the same `projectRemoval` this component reads.
   */
  onRemove: (project: ProjectNode) => void;
  onRestoreHidden: () => void;
}

export function ProjectList(props: ProjectListProps) {
  const { sdk } = props;
  const { React } = sdk;
  const { useState } = sdk.hooks;
  const t = messagesFor(props.locale);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  // Which project is being renamed, and the draft. Project rows carry two more
  // actions than session rows, so they get a kebab menu instead of a third and
  // fourth icon in the header; the menu holds nothing but those actions.
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [menuId, setMenuId] = useState<string | null>(null);

  const toggle = (row: ProjectRow) => {
    const id = row.project.id;
    const next = !expanded[id];
    setExpanded((prev) => ({ ...prev, [id]: next }));
    // Fetch once per project; the cache is keyed by id and survives collapse.
    if (next && !props.sessionCache[id]) props.onExpand(id);
  };

  const startRename = (project: ProjectNode) => {
    setMenuId(null);
    setDraft(project.label);
    setRenamingId(project.id);
  };

  const commitRename = (project: ProjectNode, value: string) => {
    const next = value.trim();
    setRenamingId(null);
    // An unchanged or empty name is a cancel, not a write: `projects.update`
    // with an empty string would rename the project to nothing.
    if (!next || next === project.label) return;
    props.onRename(project.id, next);
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
        // Drag source, same payload as the Recent tab: drop on the composer to
        // pull this transcript in as context. No hover button here — this view
        // deliberately keeps its rows to open/expand.
        draggable: true,
        onDragStart: (event: { dataTransfer?: DataTransfer; stopPropagation: () => void }) => {
          event.stopPropagation();
          const payload = sessionDragPayload({ id: row.id, title: row.title || "" });
          if (event.dataTransfer) {
            event.dataTransfer.setData(SESSION_CONTEXT_MIME, payload);
            event.dataTransfer.setData("text/plain", payload);
            event.dataTransfer.effectAllowed = "copy";
          }
        },
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

    props.hiddenCount > 0
      ? // A hide has to be reversible from somewhere, or a mistaken click is
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
            onClick: props.onRestoreHidden,
          },
          t.projectRestoreHidden(props.hiddenCount),
        )
      : null,

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
          isRenaming
            ? // The name becomes an input in place: a dialog for a one-field edit
              // costs a second surface to keep in step with this panel.
              React.createElement("input", {
                autoFocus: true,
                value: draft,
                "data-hb": "project-rename-input",
                className: "hb-input hb-flex-fill",
                style: { fontSize: "0.75rem", padding: "0.1rem 0.3rem" },
                onChange: (event: { target: { value: string } }) => setDraft(event.target.value),
                // Read the value off the element: React commits state on its own
                // schedule, so a fast type-then-Enter would otherwise commit the
                // previous value (the same trap the session rename row hit).
                onKeyDown: (event: {
                  key: string;
                  currentTarget: { value: string };
                  preventDefault: () => void;
                  stopPropagation: () => void;
                }) => {
                  event.stopPropagation();
                  if (event.key === "Enter") {
                    event.preventDefault();
                    commitRename(row.project, event.currentTarget.value);
                  } else if (event.key === "Escape") {
                    event.preventDefault();
                    setRenamingId(null);
                  }
                },
                onBlur: (event: { currentTarget: { value: string } }) =>
                  commitRename(row.project, event.currentTarget.value),
              })
            : React.createElement(
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

          removal === "none"
            ? null
            : React.createElement(
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
                  onClick: () => setMenuId((current) => (current === id ? null : id)),
                },
                "⋯",
              ),
        ),

        // The panel is IN FLOW, not absolutely positioned: `.hb-proj-list` is a
        // scrolling column, and an absolute popover inside it is clipped by the
        // scroll box (and can land off-screen on a phone). Expanding the row
        // costs a little height and cannot go wrong.
        menuId === id
          ? React.createElement(
              "div",
              { className: "hb-proj-menu", "data-hb": "project-menu-panel", role: "menu" },
              renamable
                ? React.createElement(
                    "button",
                    {
                      type: "button",
                      "data-hb": "project-rename",
                      className: "hb-proj-menu-item",
                      role: "menuitem",
                      onClick: () => startRename(row.project),
                    },
                    t.rename,
                  )
                : null,
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
                    // Destructive either way, and the user cannot undo a delete
                    // from this panel, so confirm first — the same rule the
                    // history rows follow.
                    const message = removal === "delete" ? t.projectDeleteConfirm : t.projectHideConfirm;
                    if (window.confirm(message)) props.onRemove(row.project);
                  },
                },
                removal === "delete" ? t.delete : t.projectHide,
              ),
            )
          : null,

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
