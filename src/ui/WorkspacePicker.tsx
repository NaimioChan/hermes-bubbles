/**
 * Workspace picker — the small chip under the composer.
 *
 * Picks the host directory the NEXT new chat starts in. The value is a
 * controller-level preference (persisted per profile by the page), not a
 * property of the open tab: `session.create` stamps `cwd` on the session row
 * once, and a resumed session keeps the directory it was born in.
 *
 * The chip itself is live: while a chat is open it names that chat's own
 * directory (`meta.cwd`), because that is the answer to "where am I right now".
 * The panel keeps aiming the next new chat, and says so when a chat is open.
 *
 * Styling: host classes for layout, `hb-` classes for anything the host bundle
 * does not ship (AGENTS.md 铁律 11 — an unknown class fails silently).
 */

import { abbreviateHomePath, workspaceLabel, type WorkspaceOption } from "../core/workspaces";
import type { GitInfo } from "../core/gitinfo";
import { messagesFor, type Locale } from "../core/i18n";
import { GitBadge } from "./GitBadge";
import { Icon } from "./icons";
import type { HermesPluginSdk } from "./sdk";

export interface WorkspacePickerProps {
  sdk: HermesPluginSdk;
  locale: Locale;
  /** Workspace for the next new chat; "" = the gateway's default directory. */
  value: string;
  /** The open session's own cwd, "" when the backend did not report one. */
  current: string;
  options: readonly WorkspaceOption[];
  home: string;
  loading: boolean;
  failed: boolean;
  /** Git state of the chip's directory; `null` renders no badge (not a repo). */
  git: GitInfo | null;
  gitLoading: boolean;
  onRefreshGit: () => void;
  onPick: (cwd: string) => void;
  onRescan: () => void;
}

export function WorkspacePicker(props: WorkspacePickerProps) {
  const { sdk } = props;
  const { React } = sdk;
  const { useState } = sdk.hooks;
  const t = messagesFor(props.locale);

  const [open, setOpen] = useState(false);
  const [customOpen, setCustomOpen] = useState(false);
  const [draft, setDraft] = useState(props.value);

  const live = props.current.trim();
  // The chip is LIVE: with a chat open it names that chat's own directory, not
  // the pick for the next one. The pick only shows when there is nothing to be
  // live about (a fresh draft), which is also the only time it can take effect.
  const shown = live || props.value;
  const label = workspaceLabel(shown, props.options, props.home, t.workspaceDefault);
  const title = live
    ? `${t.workspaceSessionCwd}: ${live}`
    : props.value
      ? `${t.workspaceForNewChat}: ${props.value}`
      : `${t.workspaceForNewChat}: ${t.workspaceDefault}`;

  const choose = (cwd: string) => {
    props.onPick(cwd);
    setOpen(false);
    setCustomOpen(false);
  };

  const commitDraft = () => {
    const trimmed = draft.trim();
    if (trimmed) choose(trimmed);
  };

  const row = (
    key: string,
    text: string,
    hint: string,
    active: boolean,
    onSelect: () => void,
    hook = "workspace-option",
  ) =>
    React.createElement(
      "button",
      {
        key,
        type: "button",
        "data-hb": hook,
        title: hint || text,
        className: "hb-workspace-row",
        style: {
          background: active ? "var(--color-accent, var(--color-muted))" : "transparent",
          color: "var(--color-card-foreground)",
        },
        onClick: onSelect,
      },
      React.createElement("span", { className: "hb-workspace-name" }, text),
      hint ? React.createElement("span", { className: "hb-workspace-hint" }, hint) : null,
      active
        ? React.createElement(
            "span",
            { className: "hb-workspace-check" },
            Icon(props.sdk, { name: "check", size: 13 }),
          )
        : null,
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
        },
      },
      React.createElement("span", { className: "hb-workspace-caret" }, Icon(sdk, { name: "chevron", size: 12 })),
      React.createElement("span", { className: "hb-workspace-chip-label" }, label),
    ),

    // Git state of that same directory, immediately to the right of the chip.
    // Renders nothing outside a repository — see GitBadge.
    React.createElement(GitBadge, {
      sdk,
      locale: props.locale,
      info: props.git,
      loading: props.gitLoading,
      onRefresh: props.onRefreshGit,
    }),

    // Backdrop: clicking anywhere outside closes, without a document listener
    // that would have to be torn down on unmount.
    open
      ? React.createElement("div", {
          className: "hb-workspace-backdrop",
          onClick: () => {
            setOpen(false);
            setCustomOpen(false);
          },
        })
      : null,

    open
      ? React.createElement(
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
                onClick: props.onRescan,
              },
              props.loading
                ? React.createElement("span", { className: "hb-workspace-rescan-busy" }, "…")
                : Icon(sdk, { name: "refresh", size: 14 }),
            ),
          ),

          props.failed
            ? React.createElement("div", { className: "hb-workspace-note" }, t.workspaceLoadFailed)
            : null,

          row("ws-default", t.workspaceDefault, "", !props.value, () => choose("")),

          props.options.map((option) =>
            row(
              `ws-${option.value}`,
              option.label,
              option.hint,
              option.value === props.value,
              () => choose(option.value),
            ),
          ),

          // A persisted path that is no longer in the list (repo deleted, scan
          // off) still has to render as the selection instead of vanishing.
          props.value && !props.options.some((option) => option.value === props.value)
            ? row("ws-stale", abbreviateHomePath(props.value, props.home), "", true, () => choose(props.value))
            : null,

          customOpen
            ? React.createElement(
                "div",
                { className: "hb-workspace-custom" },
                React.createElement("input", {
                  autoFocus: true,
                  value: draft,
                  "data-hb": "workspace-custom",
                  placeholder: props.home ? `${props.home}/…` : "/path/to/project",
                  className: "hb-workspace-input",
                  onChange: (event: { target: { value: string } }) => setDraft(event.target.value),
                  onKeyDown: (event: { key: string }) => {
                    if (event.key === "Enter") commitDraft();
                    if (event.key === "Escape") setCustomOpen(false);
                  },
                }),
                React.createElement(
                  "button",
                  {
                    type: "button",
                    "data-hb": "workspace-apply",
                    className: "hb-workspace-apply",
                    onClick: commitDraft,
                  },
                  t.workspaceApply,
                ),
              )
            : React.createElement(
                "button",
                {
                  type: "button",
                  "data-hb": "workspace-custom-open",
                  className: "hb-workspace-row",
                  style: { color: "var(--color-muted-foreground)" },
                  onClick: () => {
                    setDraft(props.value);
                    setCustomOpen(true);
                  },
                },
                React.createElement("span", { className: "hb-workspace-name" }, t.workspaceCustom),
              ),

          // The chip names where the OPEN chat lives and cannot be changed; the
          // rows above aim the NEXT one. Say so only while both exist, or the
          // panel reads as "move this chat" and nothing appears to happen.
          live
            ? React.createElement(
                "div",
                { className: "hb-workspace-note", "data-hb": "workspace-next-note" },
                `${t.workspaceForNewChat}: ${props.value ? abbreviateHomePath(props.value, props.home) : t.workspaceDefault}`,
              )
            : null,
        )
      : null,
  );
}
