/**
 * The composer: text input, slash menu, attachment tray, model/reasoning
 * pickers, and the live metrics strip.
 *
 * All behavior that can be decided without a DOM lives in `core/slash.ts`,
 * `core/attachments.ts`, `core/metrics.ts` and `core/i18n.ts`; this file wires
 * it to elements.
 *
 * There is deliberately NO `@` path completion. The backend's `complete.path`
 * takes the whole word INCLUDING the leading `@` (`is_context = word.startswith("@")`),
 * and this client used to send the bare query, so the backend saw a plain word
 * and every request missed. Rather than carrying a second completion channel for
 * file references, `@` is not special here at all — the `+` button attaches files
 * through `file.attach`, the same path the desktop app uses.
 */

import type { Attachment, MessageAttachment, Rejection } from "../core/attachments";
import { messageAttachments, screenFiles } from "../core/attachments";
import { fitComposerHeight } from "../core/autosize";
import { SESSION_CONTEXT_MIME, insertContext } from "../core/context";
import { metricChips, pressureTone } from "../core/metrics";
import { messagesFor, reasoningLabel, type Locale } from "../core/i18n";
import type { NotifySwitch } from "../core/notify";
import type { GitInfo } from "../core/gitinfo";
import type { WorkspaceOption } from "../core/workspaces";
import {
  applyCompletion,
  filterCommands,
  findSlashToken,
  REASONING_LEVELS,
  type CommandEntry,
} from "../core/slash";
import type { Usage } from "../core/types";
import type { HermesPluginSdk } from "./sdk";
import { WorkspacePicker } from "./WorkspacePicker";
import { ApprovalModeChip } from "./ApprovalModeChip";
import { AttachmentTray } from "./Attachments";
import { Icon } from "./icons";

export interface ModelChoice {
  model: string;
  provider: string;
}

export interface ComposerProps {
  sdk: HermesPluginSdk;
  locale: Locale;
  /**
   * Phone-shaped layout: the two model/reasoning chips and the text actions are
   * replaced by one "···" menu and three round icon buttons.
   *
   * It is a layout switch rather than a style, because the controls are not the
   * same elements (see `useMobile`). Every difference it makes lives here and in
   * one `@media` block, so the desktop path is untouched.
   */
  mobile: boolean;
  running: boolean;
  status: string;
  connected: boolean;
  usage: Usage | null;
  model: string;
  provider: string;
  reasoning: string;
  attachments: readonly Attachment[];
  catalog: readonly CommandEntry[];
  /**
   * Send the draft. `attachments` is the snapshot the bubble will show (the
   * composer clears its tray right after), so a message keeps its files even
   * though the staging queue is gone.
   */
  onSend: (text: string, attachments: readonly MessageAttachment[]) => void;
  onStop: () => void;
  onPickFiles: (files: FileList | File[]) => void;
  onRemoveAttachment: (id: string) => void;
  onOpenModelPicker: () => void;
  onPickReasoning: (level: string) => void;
  onError: (message: string) => void;
  /** Desktop notifications: the switch and the permission state behind it. */
  notifyState: NotifySwitch;
  onToggleNotify: () => void;
  /** Workspace the NEXT new chat starts in, plus the open session's own cwd. */
  workspace: string;
  workspaceCurrent: string;
  workspaceOptions: readonly WorkspaceOption[];
  workspaceHome: string;
  workspaceLoading: boolean;
  workspaceFailed: boolean;
  /** Git state of the workspace chip's directory; `null` = no badge. */
  git: GitInfo | null;
  gitLoading: boolean;
  onRefreshGit: () => void;
  onPickWorkspace: (cwd: string) => void;
  onRescanWorkspaces: () => void;
  /** Dangerous-command approval mode (profile-wide) and its setter. */
  approvalMode: string;
  onApprovalModeChange: (mode: string) => void;
  /** Text of the message being rewritten, or null when composing normally. */
  editingText?: string | null;
  onCancelEdit?: () => void;
  /**
   * One-shot request to put text in the draft (a session pulled in as context).
   * `seq` is what makes it one-shot: the page bumps it for every insert, and the
   * composer applies an entry exactly once.
   */
  insertion?: { seq: number; text: string } | null;
  /** A stored session row was dropped on the composer; raw drag payload. */
  onDropSession?: (payload: string) => void;
}

/**
 * Cap on rows rendered in the popover.
 *
 * The list scrolls, so this is a rendering ceiling rather than a result limit:
 * a fresh `/` on this install matches 100+ commands, and cutting the list at 12
 * made most of them unreachable by typing more (the filter ran on the truncated
 * set). Rendering 200 rows is cheap; the user scrolls or types to narrow.
 */
const MENU_LIMIT = 200;

/**
 * The text box's height range, in px.
 *
 * The floor matches `.hb-min-h-input` (32px); the ceiling is eight-ish lines of
 * `text-sm`, past which a long draft scrolls inside the box instead of pushing
 * the transcript and the send button off screen. `.hb-composer-input` carries
 * the same cap in CSS, so a frame with JS still starting up cannot open a
 * screen-tall textarea.
 */
const INPUT_MIN_PX = 32;
const INPUT_MAX_PX = 192;

export function Composer(props: ComposerProps) {
  const { sdk } = props;
  const { React } = sdk;
  const { useCallback, useEffect, useMemo, useRef, useState } = sdk.hooks;
  const t = messagesFor(props.locale);

  const [text, setText] = useState(props.editingText ?? "");
  const [caret, setCaret] = useState(0);
  const [menuIndex, setMenuIndex] = useState(0);
  const [menuDismissed, setMenuDismissed] = useState(false);
  /**
   * The phone's "···" menu above the box (model / reasoning / notifications).
   *
   * It replaces the two chips the desktop shows inline: on a 390px row there is
   * no width for a model name, and the chips were what squeezed the textarea to
   * four characters. The reasoning row is a CYCLE here rather than a list — one
   * tap moves to the next tier, the same thing the desktop chip does.
   */
  const [toolsOpen, setToolsOpen] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  /** Highest `props.insertion.seq` already written into the draft. */
  const appliedInsertion = useRef(0);

  /**
   * Size the box to its content.
   *
   * `rows={1}` alone leaves a textarea one row tall forever: it scrolls its own
   * text instead of growing, and the native resize grip that used to paper over
   * that is gone (`resize: none`). Collapsing to `auto` first is what makes
   * `scrollHeight` report the text's real height rather than the height we set
   * last time.
   */
  const fitInput = useCallback(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    const fit = fitComposerHeight(el.scrollHeight, { min: INPUT_MIN_PX, max: INPUT_MAX_PX });
    el.style.height = `${fit.height}px`;
    el.style.overflowY = fit.scrolls ? "auto" : "hidden";
  }, []);

  // Follow the text: typing, pasting, clearing after send, and being filled by
  // "edit this message" all change it. Layout effect, so the box never paints at
  // one row and then jump.
  React.useLayoutEffect(() => {
    fitInput();
  }, [text, fitInput]);

  // Same text, narrower box, more lines: a window resize rewraps it.
  useEffect(() => {
    window.addEventListener("resize", fitInput);
    return () => window.removeEventListener("resize", fitInput);
  }, [fitInput]);

  // The slash token under the caret drives the popover.
  const slashToken = useMemo(() => findSlashToken(text, caret), [text, caret]);

  const items = useMemo(
    () => (slashToken ? filterCommands(props.catalog, slashToken.query, MENU_LIMIT) : []),
    [slashToken, props.catalog],
  );

  const menuVisible = Boolean(slashToken && items.length && !menuDismissed);

  // Follow the edit target: entering an edit fills the box with that message,
  // leaving it clears back to a normal draft.
  useEffect(() => {
    if (props.editingText == null) return;
    setText(props.editingText);
    setCaret(props.editingText.length);
    setMenuDismissed(true);
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(props.editingText!.length, props.editingText!.length);
    });
  }, [props.editingText]);

  // A session pulled in from the history panel lands here. The block goes above
  // whatever was already typed (see `insertContext`), and the seq guard makes
  // re-renders harmless: the same entry never appends twice.
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

  // Reset the highlight whenever the candidate list changes shape.
  useEffect(() => {
    setMenuIndex(0);
  }, [items.length, slashToken?.query]);

  const syncCaret = useCallback(() => {
    const el = inputRef.current;
    if (el) setCaret(el.selectionStart ?? el.value.length);
  }, []);

  const acceptCommand = useCallback(
    (entry: CommandEntry) => {
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
    [slashToken, text],
  );

  const submit = useCallback(() => {
    const value = text.trim();
    // A photo with no caption is a legitimate turn; only refuse when there is
    // nothing to say AND nothing to show.
    const ready = messageAttachments(props.attachments);
    if (!value && !ready.length) return;
    setText("");
    setCaret(0);
    setMenuDismissed(false);
    props.onSend(value, ready);
  }, [text, props]);

  const onKeyDown = useCallback(
    (event: KeyboardEvent) => {
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
    [menuVisible, items, menuIndex, acceptCommand, submit],
  );

  const onPaste = useCallback(
    (event: { clipboardData?: DataTransfer; preventDefault: () => void }) => {
      const files = Array.from(event.clipboardData?.files ?? []);
      if (!files.length) return;
      event.preventDefault();
      props.onPickFiles(files);
    },
    [props],
  );

  const onDrop = useCallback(
    (event: { dataTransfer?: DataTransfer; preventDefault: () => void }) => {
      // A history row dropped here (see `core/context.ts`). Checked before files:
      // a session drag carries no file list, but a file drag must never be read
      // as a session id.
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
    [props],
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
      onDragOver: (event: { preventDefault: () => void }) => event.preventDefault(),
    },
    React.createElement(
      "div",
      { className: "mx-auto", style: { maxWidth: "860px" } },

      // ── editing banner ───────────────────────────────────────────────────
      props.editingText != null
        ? React.createElement(
            "div",
            {
              className: "hb-edit-banner mb-1.5 flex items-center gap-2 px-2 py-1 hb-text-micro",
              "data-hb": "editing-banner",
              style: {
                background: "color-mix(in oklab, var(--color-primary) 12%, var(--color-card))",
                color: "var(--color-card-foreground)",
                borderRadius: "calc(var(--radius) * 0.6)",
              },
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
                },
              },
              "×",
            ),
          )
        : null,

      // ── attachment tray ──────────────────────────────────────────────────
      // Each entry reports where its staging is (reading off disk → uploading
      // over the socket), which is the part that used to be a silent "…" over a
      // remote dashboard.
      React.createElement(AttachmentTray, {
        sdk,
        locale: props.locale,
        items: props.attachments,
        onRemove: props.onRemoveAttachment,
      }),

      // ── slash popover ────────────────────────────────────────────────────
      menuVisible
        ? React.createElement(
            "div",
            {
              className: "mb-1.5 max-h-64 overflow-y-auto py-1 hb-scroll",
              style: {
                background: "var(--color-popover, var(--color-card))",
                borderRadius: "var(--radius)",
                boxShadow: "inset 0 0 0 1px var(--color-border)",
              },
            },
            items.map((entry, index) =>
              React.createElement(
                "button",
                {
                  key: `${entry.kind}:${entry.name}`,
                  type: "button",
                  className: "flex w-full cursor-pointer items-baseline gap-2 px-3 py-1.5 text-left text-xs",
                  style: {
                    background: index === menuIndex ? "var(--color-accent, var(--color-muted))" : "transparent",
                    color: "var(--color-card-foreground)",
                  },
                  onMouseEnter: () => setMenuIndex(index),
                  onClick: () => acceptCommand(entry),
                },
                React.createElement("span", { className: "hb-mono" }, `/${entry.name}`),
                entry.kind === "skill"
                  ? React.createElement(
                      "span",
                      {
                        className: "hb-text-tiny px-1",
                        style: {
                          background: "var(--color-muted)",
                          borderRadius: "3px",
                          color: "var(--color-muted-foreground)",
                        },
                      },
                      "skill",
                    )
                  : null,
                React.createElement(
                  "span",
                  { className: "hb-truncate hb-flex-fill", style: { color: "var(--color-muted-foreground)" } },
                  entry.kind === "skill"
                    ? entry.origin
                      ? t.skillOrigin(entry.origin)
                      : t.skill
                    : entry.description,
                ),
              ),
            ),
          )
        : null,

      // ── tool menu ────────────────────────────────────────────────────────
      // Model, reasoning strength and notifications. One row each, because
      // these are full sentences rather than pills (铁律 20), and because an
      // inline model chip is what used to squeeze the textarea to four
      // characters on a narrow screen. Same control on both layouts: a phone
      // and a desktop should not teach two different ways to switch models.
      toolsOpen
        ? React.createElement(
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
                  onClick: () => setToolsOpen(false),
                },
                Icon(sdk, { name: "close", size: 14 }),
              ),
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
                },
              },
              React.createElement("span", { className: "hb-tools-icon" }, Icon(sdk, { name: "model", size: 16 })),
              React.createElement("span", { className: "hb-tools-label" }, t.pickModel),
              React.createElement(
                "span",
                { className: "hb-tools-value hb-truncate" },
                props.model || "default",
              ),
              Icon(sdk, { name: "chevron", size: 14, className: "hb-tools-chevron" }),
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
                  const index = REASONING_LEVELS.indexOf(current as (typeof REASONING_LEVELS)[number]);
                  const next = REASONING_LEVELS[(index + 1) % REASONING_LEVELS.length];
                  if (next) props.onPickReasoning(next);
                },
              },
              React.createElement("span", { className: "hb-tools-icon" }, Icon(sdk, { name: "reasoning", size: 16 })),
              React.createElement("span", { className: "hb-tools-label" }, t.reasoning),
              React.createElement(
                "span",
                { className: "hb-tools-value" },
                reasoningLabel(props.reasoning || "medium", props.locale),
              ),
              Icon(sdk, { name: "chevron", size: 14, className: "hb-tools-chevron" }),
            ),
            React.createElement(
              "button",
              {
                type: "button",
                "data-hb": "notify-toggle",
                "data-on": props.notifyState === "on" ? "true" : "false",
                "data-state": props.notifyState,
                className: "hb-tools-row",
                onClick: props.onToggleNotify,
              },
              React.createElement(
                "span",
                { className: "hb-tools-icon" },
                Icon(sdk, { name: props.notifyState === "on" ? "bell" : "bellOff", size: 16 }),
              ),
              React.createElement("span", { className: "hb-tools-label" }, t.notifications),
              React.createElement(
                "span",
                { className: "hb-tools-value" },
                props.notifyState === "on" || props.notifyState === "needs-permission"
                  ? t.notifyOnTitle
                  : t.notifyOffTitle,
              ),
            ),
          )
        : null,

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
            boxShadow: "inset 0 0 0 1px var(--color-border)",
          },
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
            onClick: () => setToolsOpen((v: boolean) => !v),
          },
          Icon(sdk, { name: "dots", size: 18 }),
        ),
        React.createElement("input", {
          ref: fileRef,
          type: "file",
          multiple: true,
          className: "hidden",
          onChange: (event: { target: { files: FileList | null; value: string } }) => {
            if (event.target.files?.length) props.onPickFiles(event.target.files);
            event.target.value = "";
          },
        }),

        // center: the textarea
        React.createElement("textarea", {
          ref: inputRef,
          value: text,
          rows: 1,
          disabled: !props.connected,
          placeholder: props.connected
            ? props.mobile
              ? t.composerPlaceholderShort
              : t.composerPlaceholder
            : "…",
          "aria-label": t.composerPlaceholder,
          className: "hb-resize-none hb-min-h-input hb-composer-input flex-1 bg-transparent text-sm outline-none",
          // `--font-sans` is the host's display face ("Collapse", a narrow
          // serif) and is NOT what body text uses — `html`/`body` take
          // `--theme-font-sans`, the system UI stack. Pointing the textarea at
          // the display face made every Latin character thin and hard to read at
          // typing size, so the draft now matches the rest of the dashboard.
          style: {
            color: "var(--color-card-foreground)",
            fontFamily: "var(--theme-font-sans, system-ui, -apple-system, 'Segoe UI', sans-serif)",
          },
          onChange: (event: { target: { value: string; selectionStart: number } }) => {
            setText(event.target.value);
            setCaret(event.target.selectionStart ?? event.target.value.length);
            setMenuDismissed(false);
          },
          onKeyUp: syncCaret,
          onClick: syncCaret,
          onKeyDown,
          onPaste,
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
          props.running
            ? React.createElement(
                "button",
                {
                  type: "button",
                  title: t.stopReasoningTitle,
                  "aria-label": t.stop,
                  "data-hb": "stop-action",
                  className: "hb-composer-btn hb-round-btn hb-round-stop",
                  onClick: props.onStop,
                },
                Icon(sdk, { name: "stop", size: 15 }),
              )
            : null,
          React.createElement(
            "button",
            {
              type: "button",
              title: t.attachFiles,
              "aria-label": t.attachFiles,
              "data-hb": "composer-upload",
              className: "hb-composer-btn hb-round-btn",
              onClick: () => fileRef.current?.click(),
            },
            Icon(sdk, { name: "paperclip", size: 17 }),
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
                cursor: canSend ? "pointer" : "default",
              },
              onClick: submit,
            },
            Icon(sdk, { name: props.running ? "insert" : "send", size: 18 }),
          ),
        ),
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
          onRescan: props.onRescanWorkspaces,
        }),

        React.createElement(ApprovalModeChip, {
          sdk,
          locale: props.locale,
          value: props.approvalMode,
          onChange: props.onApprovalModeChange,
        }),
      ),

      // ── status + metrics ─────────────────────────────────────────────────
      React.createElement(
        "div",
        {
          className: "hb-text-micro mt-1 flex items-center gap-3 px-1 tabular-nums",
          style: { color: "var(--color-muted-foreground)" },
        },
        props.status
          ? React.createElement("span", { className: "hb-truncate", title: props.status }, props.status)
          : null,
        React.createElement(
          "div",
          { className: "ml-auto flex items-center gap-3" },
          chips.map((chip) =>
            React.createElement(
              "span",
              {
                key: chip.key,
                title: chip.title,
                style:
                  chip.key === "context" && contextChip
                    ? {
                        color:
                          tone === "calm" ? "var(--color-muted-foreground)" : "var(--color-muted-foreground)",
                      }
                    : undefined,
              },
              chip.label,
            ),
          ),
        ),
      ),
    ),
  );
}

/** Screen dropped/picked files and hand the accepted ones up. */
export function screenDroppedFiles(files: FileList | File[]): {
  accepted: { file: File; id: string }[];
  rejected: Rejection[];
} {
  const list = Array.from(files);
  const { accepted, rejected } = screenFiles(
    list.map((file) => ({ name: file.name, size: file.size, type: file.type })),
  );
  const acceptedNames = new Set(accepted.map((a) => a.name));
  return {
    accepted: list
      .filter((file) => acceptedNames.has(file.name))
      .map((file, index) => ({ file, id: `att-${Date.now()}-${index}` })),
    rejected,
  };
}
