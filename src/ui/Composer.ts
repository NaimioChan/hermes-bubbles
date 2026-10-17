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

import type { Attachment } from "../core/attachments";
import { formatBytes, screenFiles } from "../core/attachments";
import { fitComposerHeight } from "../core/autosize";
import { metricChips, pressureTone } from "../core/metrics";
import { messagesFor, reasoningLabel, type Locale } from "../core/i18n";
import {
  applyCompletion,
  filterCommands,
  findSlashToken,
  REASONING_LEVELS,
  type CommandEntry,
} from "../core/slash";
import type { Usage } from "../core/types";
import type { HermesPluginSdk } from "./sdk";

export interface ModelChoice {
  model: string;
  provider: string;
}

export interface ComposerProps {
  sdk: HermesPluginSdk;
  locale: Locale;
  running: boolean;
  status: string;
  connected: boolean;
  usage: Usage | null;
  model: string;
  provider: string;
  reasoning: string;
  attachments: readonly Attachment[];
  catalog: readonly CommandEntry[];
  onSend: (text: string) => void;
  onStop: () => void;
  onPickFiles: (files: FileList | File[]) => void;
  onRemoveAttachment: (id: string) => void;
  onOpenModelPicker: () => void;
  onPickReasoning: (level: string) => void;
  onError: (message: string) => void;
  /** Text of the message being rewritten, or null when composing normally. */
  editingText?: string | null;
  onCancelEdit?: () => void;
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
 * The floor matches `.hb-min-h-input` (2rem); the ceiling is eight-ish lines of
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
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

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
    if (!value) return;
    setText("");
    setCaret(0);
    setMenuDismissed(false);
    props.onSend(value);
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
      const files = Array.from(event.dataTransfer?.files ?? []);
      if (!files.length) return;
      event.preventDefault();
      props.onPickFiles(files);
    },
    [props],
  );

  const canSend = Boolean(text.trim()) && props.connected;
  const chips = metricChips(props.usage, t);
  const tone = pressureTone(null);
  const contextChip = chips.find((c) => c.key === "context");

  return React.createElement(
    "div",
    {
      className: "px-4 pb-3",
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
      props.attachments.length
        ? React.createElement(
            "div",
            { className: "mb-1.5 flex flex-wrap gap-1.5" },
            props.attachments.map((item) =>
              React.createElement(
                "span",
                {
                  key: item.id,
                  className: "hb-text-micro inline-flex items-center gap-1.5 px-2 py-1",
                  style: {
                    background: "var(--color-muted)",
                    color: "var(--color-card-foreground)",
                    borderRadius: "calc(var(--radius) * 0.6)",
                  },
                },
                React.createElement(
                  "span",
                  null,
                  item.kind === "image" ? "🖼" : item.kind === "pdf" ? "📄" : "📎",
                ),
                React.createElement("span", { className: "hb-truncate hb-max-w-16ch" }, item.name),
                item.size
                  ? React.createElement(
                      "span",
                      { style: { color: "var(--color-muted-foreground)" } },
                      formatBytes(item.size),
                    )
                  : null,
                item.status === "staging"
                  ? React.createElement("span", { style: { color: "var(--color-muted-foreground)" } }, "…")
                  : null,
                item.status === "error"
                  ? React.createElement("span", { style: { color: "var(--color-destructive)" } }, "!")
                  : null,
                React.createElement(
                  "button",
                  {
                    type: "button",
                    className: "cursor-pointer px-1",
                    style: { color: "var(--color-muted-foreground)" },
                    onClick: () => props.onRemoveAttachment(item.id),
                  },
                  "×",
                ),
              ),
            ),
          )
        : null,

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
                React.createElement("span", { className: "font-mono" }, `/${entry.name}`),
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
                  entry.description,
                ),
              ),
            ),
          )
        : null,

      // ── input row ────────────────────────────────────────────────────────
      React.createElement(
        "div",
        {
          className: "flex items-end gap-1.5 px-2 py-1.5",
          style: {
            background: "var(--color-card)",
            borderRadius: "var(--radius)",
            boxShadow: "inset 0 0 0 1px var(--color-border)",
          },
        },

        // left: attach
        React.createElement(
          "button",
          {
            type: "button",
            title: t.attachFiles,
            "aria-label": t.attachFiles,
            className: "shrink-0 cursor-pointer px-2 py-1.5 text-base leading-none",
            style: { color: "var(--color-muted-foreground)" },
            onClick: () => fileRef.current?.click(),
          },
          "+",
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
          placeholder: props.connected ? t.composerPlaceholder : "…",
          "aria-label": t.composerPlaceholder,
          className: "hb-resize-none hb-min-h-input hb-composer-input flex-1 bg-transparent py-1.5 text-sm outline-none",
          style: { color: "var(--color-card-foreground)", fontFamily: "var(--font-sans)" },
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

        // right: model + reasoning + send/stop
        React.createElement(
          "div",
          { className: "flex shrink-0 items-center gap-1" },
          React.createElement(
            "button",
            {
              type: "button",
              title: `${t.pickModel}: ${props.model || "default"}`,
              className: "hb-text-micro hb-truncate hb-max-w-18ch cursor-pointer px-2 py-1.5",
              style: { color: "var(--color-muted-foreground)" },
              onClick: props.onOpenModelPicker,
            },
            props.model || "model",
          ),
          React.createElement(
            "button",
            {
              type: "button",
              title: `${t.reasoning}: ${reasoningLabel(props.reasoning || "medium", props.locale)}`,
              className: "hb-text-micro cursor-pointer px-2 py-1.5",
              style: { color: "var(--color-muted-foreground)" },
              onClick: () => {
                const current = props.reasoning || "medium";
                const index = REASONING_LEVELS.indexOf(current as (typeof REASONING_LEVELS)[number]);
                const next = REASONING_LEVELS[(index + 1) % REASONING_LEVELS.length];
                if (next) props.onPickReasoning(next);
              },
            },
            reasoningLabel(props.reasoning || "medium", props.locale),
          ),
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
                  "data-hb": "stop-action",
                  className: "cursor-pointer px-2.5 py-1.5 text-xs",
                  style: {
                    background: "var(--color-muted)",
                    color: "var(--color-muted-foreground)",
                    borderRadius: "calc(var(--radius) * 0.6)",
                  },
                  onClick: props.onStop,
                },
                t.stop,
              )
            : null,
          React.createElement(
            "button",
            {
              type: "button",
              disabled: !canSend,
              title: props.running ? t.insert : t.send,
              "data-hb": "primary-action",
              className: "cursor-pointer px-3 py-1.5 text-xs",
              style: {
                background: props.running ? "var(--color-muted)" : "var(--color-primary)",
                color: props.running ? "var(--color-card-foreground)" : "var(--color-primary-foreground)",
                borderRadius: "calc(var(--radius) * 0.6)",
                // `disabled:opacity-40` is absent from the host bundle, so the
                // dimming is done here rather than hoped for.
                opacity: canSend ? 1 : 0.4,
                cursor: canSend ? "pointer" : "default",
              },
              onClick: submit,
            },
            props.running ? t.insert : t.send,
          ),
        ),
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
  rejected: { name: string; reason: string }[];
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
