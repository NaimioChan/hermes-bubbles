/**
 * The history panel: stored sessions you can open.
 *
 * Two presentations, one component:
 *
 *   - `panel` — the desktop's right-hand column: collapsible, in flow, sized for
 *     a mouse.
 *   - `drawer` — the phone's left sheet, opened from the floating "···" button
 *     in the top-right corner. The tab strip (which owns "new chat" and
 *     "history" on a desktop) does not exist on a phone, so both actions live
 *     here: a "new chat" row at the top, then the same recent / projects lists.
 *
 * In the drawer each row's three tools collapse into one "···" menu. A 390px
 * row has no width for three 28px glyphs beside a title and a timestamp, and
 * Delete sitting a thumb-width from Rename is how conversations get lost.
 */

import { messagesFor, type Locale } from "../core/i18n";
import { SESSION_CONTEXT_MIME, sessionDragPayload } from "../core/context";
import type { HermesPluginSdk } from "./sdk";
import { ProjectList, type ProjectListProps } from "./ProjectList";
import { Icon } from "./icons";

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
  /** How the panel is presented. See the file header. */
  variant: "panel" | "drawer";
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
  /** Put this session's transcript into the composer draft. */
  onUseAsContext: (id: string, title: string) => void;
  onRefresh: () => void;
  onClose: () => void;
  /** Start a fresh chat. The drawer's top row; the desktop gets it from the tab strip. */
  onNew: () => void;
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
  const { useState, useEffect } = sdk.hooks;
  const t = messagesFor(props.locale);
  // Which row is being renamed, and the draft. Null means no row is editing.
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  // Which row's "···" menu is open (drawer only). Opening another row closes the
  // previous one: two open menus in a scrolling sheet is a state nobody means.
  const [menuId, setMenuId] = useState<string | null>(null);

  const drawer = props.variant === "drawer";
  /**
   * Closing is a two-step state, because the panel has to stay mounted while it
   * animates out.
   *
   * `requestClose` tells the parent immediately (its `open` flag is the truth:
   * "closed") and keeps this panel mounted for the length of the exit animation.
   * `animationend` clears the local flag, which is what unmounts it — driven by
   * the animation itself rather than a timer, so a slow frame stretches the exit
   * instead of cutting it, and a fast one cannot leave a ghost panel behind.
   * Reduced motion skips the whole thing.
   *
   * Both presentations animate: the phone's drawer slides, the desktop's column
   * unclips. A desktop panel that appeared and vanished by cutting was the last
   * surface in this page with no motion vocabulary.
   */
  const [closing, setClosing] = useState(false);
  const requestClose = () => {
    try {
      if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
        props.onClose();
        return;
      }
    } catch {
      // No matchMedia: fall through and animate.
    }
    setClosing(true);
    props.onClose();
  };

  useEffect(() => {
    // Reopened mid-exit (the parent flips `open` back on): the old panel is back
    // in service, so drop the exit state and let the entry animation replay.
    if (props.open && closing) setClosing(false);
  }, [props.open, closing]);

  if (!props.open && !closing) return null;

  const menuItem = (key: string, hook: string, label: string, run: () => void, danger = false) =>
    React.createElement(
      "button",
      {
        key,
        type: "button",
        "data-hb": hook,
        role: "menuitem",
        className: danger ? "hb-menu-item hb-menu-item-danger" : "hb-menu-item",
        onClick: (event: { stopPropagation: () => void }) => {
          event.stopPropagation();
          setMenuId(null);
          run();
        },
      },
      label,
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
      onClick: requestClose,
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
        onAnimationEnd: (event: { animationName?: string; stopPropagation?: () => void }) => {
          if (event.animationName !== "hb-slide-out-right" && event.animationName !== "hb-panel-out") {
            return;
          }
          event.stopPropagation?.();
          setClosing(false);
        },
      },

    React.createElement(
      "div",
      { className: drawer ? "hb-drawer-head" : "flex shrink-0 items-center gap-1 px-3 py-2" },
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
            "data-hb": "history-refresh",
            className: "hb-icon-btn",
            onClick: props.mode === "projects" ? props.onRefreshProjects : props.onRefresh,
          },
          Icon(sdk, { name: "refresh", size: 15 }),
        ),
        React.createElement(
          "button",
          {
            type: "button",
            title: t.collapse,
            "data-hb": "history-close",
            className: "hb-icon-btn",
            onClick: requestClose,
          },
          Icon(sdk, { name: "close", size: 15 }),
        ),
      ),
    ),

    // The drawer's first row: on a phone this is the only "new chat" there is.
    drawer
      ? React.createElement(
          "button",
          {
            type: "button",
            "data-hb": "drawer-new",
            className: "hb-drawer-new",
            onClick: () => {
              props.onClose();
              props.onNew();
            },
          },
          Icon(sdk, { name: "plus", size: 16 }),
          React.createElement("span", null, t.newChat),
        )
      : null,

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
      { className: "hb-hist-list hb-scroll" },
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
                  onDragStart: (event: {
                    dataTransfer?: DataTransfer;
                    stopPropagation: () => void;
                  }) => {
                    event.stopPropagation();
                    const payload = sessionDragPayload({ id: session.id, title: session.title });
                    if (event.dataTransfer) {
                      event.dataTransfer.setData(SESSION_CONTEXT_MIME, payload);
                      // A plain-text target (or the OS) still gets something usable.
                      event.dataTransfer.setData("text/plain", payload);
                      event.dataTransfer.effectAllowed = "copy";
                    }
                  },
                  style: {
                    background: isActive ? "var(--color-muted)" : "transparent",
                    color: "var(--color-card-foreground)",
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
                  { className: "hb-hist-main" },
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
                  // Desktop shows the three glyphs, revealed on hover; the
                  // drawer shows one "···" that owns the same three actions.
                  drawer
                    ? React.createElement(
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
                          onClick: (event: { stopPropagation: () => void }) => {
                            event.stopPropagation();
                            setMenuId((current: string | null) => (current === session.id ? null : session.id));
                          },
                        },
                        Icon(sdk, { name: "dots", size: 16 }),
                      )
                    : React.createElement(
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
                            onClick: (event: { stopPropagation: () => void }) => {
                              event.stopPropagation();
                              props.onUseAsContext(session.id, session.title);
                            },
                          },
                          Icon(sdk, { name: "download", size: 15 }),
                        ),
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
                          Icon(sdk, { name: "pencil", size: 15 }),
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
                          Icon(sdk, { name: "trash", size: 15 }),
                        ),
                      ),
                ),
                session.preview && !drawer
                  ? React.createElement(
                      "div",
                      {
                        className: "hb-text-tiny hb-truncate",
                        style: { color: "var(--color-muted-foreground)" },
                      },
                      session.preview,
                    )
                  : null,
                // In flow, not absolutely positioned: this list is a scrolling
                // column and an absolute popover inside it is clipped by the
                // scroll box (and can land off-screen).
                menuOpen
                  ? React.createElement(
                      "div",
                      { className: "hb-row-menu", "data-hb": "session-menu-panel", role: "menu" },
                      menuItem("ctx", "session-to-context", t.useAsContext, () =>
                        props.onUseAsContext(session.id, session.title),
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
                        true,
                      ),
                    )
                  : null,
              );
            }),
    ),
  ),
  );
}
