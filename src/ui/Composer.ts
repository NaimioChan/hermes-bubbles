/**
 * The composer: text input, slash menu, attachment tray, model/reasoning
 * pickers, and the live metrics strip.
 *
 * All behavior that can be decided without a DOM lives in `core/slash.ts`,
 * `core/attachments.ts` and `core/metrics.ts`; this file wires it to elements.
 */

import type { Attachment } from "../core/attachments";
import { applyAtCompletion, findAtToken, formatBytes, screenFiles } from "../core/attachments";
import { metricChips, pressureTone } from "../core/metrics";
import {
  applyCompletion,
  filterCommands,
  findSlashToken,
  reasoningLabel,
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
  onCompletePath: (word: string) => Promise<{ text: string; display: string; meta: string }[]>;
  onError: (message: string) => void;
}

const MENU_LIMIT = 12;

export function Composer(props: ComposerProps) {
  const { sdk } = props;
  const { React } = sdk;
  const { useCallback, useEffect, useMemo, useRef, useState } = sdk.hooks;

  const [text, setText] = useState("");
  const [caret, setCaret] = useState(0);
  const [menuIndex, setMenuIndex] = useState(0);
  const [menuDismissed, setMenuDismissed] = useState(false);
  const [pathItems, setPathItems] = useState<{ text: string; display: string; meta: string }[]>([]);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  // The slash token under the caret drives the popover.
  const slashToken = useMemo(() => findSlashToken(text, caret), [text, caret]);
  const atToken = useMemo(() => findAtToken(text, caret), [text, caret]);

  const items = useMemo(
    () => (slashToken ? filterCommands(props.catalog, slashToken.query, MENU_LIMIT) : []),
    [slashToken, props.catalog],
  );

  const menuVisible = Boolean(slashToken && items.length && !menuDismissed);
  const pathVisible = Boolean(atToken && pathItems.length);

  useEffect(() => {
    if (!atToken || atToken.query.length < 1) {
      setPathItems([]);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      props
        .onCompletePath(atToken.query)
        .then((result) => {
          if (!cancelled) setPathItems(result.slice(0, MENU_LIMIT));
        })
        .catch(() => {
          if (!cancelled) setPathItems([]);
        });
    }, 120);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [atToken?.query, props]);

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

  const acceptPath = useCallback(
    (item: { text: string; display: string }) => {
      if (!atToken) return;
      const next = applyAtCompletion(text, atToken, item.text);
      setText(next.text);
      setPathItems([]);
      requestAnimationFrame(() => {
        const el = inputRef.current;
        if (el) {
          el.focus();
          el.setSelectionRange(next.caret, next.caret);
          setCaret(next.caret);
        }
      });
    },
    [atToken, text],
  );

  const submit = useCallback(() => {
    const value = text.trim();
    if (!value || props.running) return;
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
      if (pathVisible && (event.key === "Tab" || event.key === "Enter")) {
        event.preventDefault();
        const item = pathItems[menuIndex];
        if (item) acceptPath(item);
        return;
      }
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        submit();
      }
    },
    [menuVisible, pathVisible, items, menuIndex, pathItems, acceptCommand, acceptPath, submit],
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

  const chips = metricChips(props.usage);
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
                  className: "inline-flex items-center gap-1.5 px-2 py-1 text-[0.6875rem]",
                  style: {
                    background: "var(--color-muted)",
                    color: "var(--color-foreground)",
                    borderRadius: "calc(var(--radius) * 0.6)",
                  },
                },
                React.createElement("span", null, item.kind === "image" ? "🖼" : item.kind === "pdf" ? "📄" : "📎"),
                React.createElement("span", { className: "max-w-[16ch] truncate" }, item.name),
                item.size ? React.createElement("span", { style: { color: "var(--color-muted-foreground)" } }, formatBytes(item.size)) : null,
                item.status === "staging"
                  ? React.createElement("span", { style: { color: "var(--color-muted-foreground)" } }, "…")
                  : null,
                item.status === "error"
                  ? React.createElement("span", { style: { color: "var(--color-destructive)" } }, "失败")
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

      // ── slash / path popover ─────────────────────────────────────────────
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
                    color: "var(--color-foreground)",
                  },
                  onMouseEnter: () => setMenuIndex(index),
                  onClick: () => acceptCommand(entry),
                },
                React.createElement("span", { className: "font-mono" }, `/${entry.name}`),
                entry.kind === "skill"
                  ? React.createElement(
                      "span",
                      {
                        className: "px-1 text-[0.625rem]",
                        style: { background: "var(--color-muted)", borderRadius: "3px", color: "var(--color-muted-foreground)" },
                      },
                      "技能",
                    )
                  : null,
                React.createElement(
                  "span",
                  { className: "truncate", style: { color: "var(--color-muted-foreground)" } },
                  entry.description,
                ),
              ),
            ),
          )
        : null,

      pathVisible
        ? React.createElement(
            "div",
            {
              className: "mb-1.5 max-h-48 overflow-y-auto py-1 hb-scroll",
              style: {
                background: "var(--color-popover, var(--color-card))",
                borderRadius: "var(--radius)",
                boxShadow: "inset 0 0 0 1px var(--color-border)",
              },
            },
            pathItems.map((item, index) =>
              React.createElement(
                "button",
                {
                  key: item.text,
                  type: "button",
                  className: "flex w-full cursor-pointer items-baseline gap-2 px-3 py-1.5 text-left text-xs",
                  style: {
                    background: index === menuIndex ? "var(--color-accent, var(--color-muted))" : "transparent",
                    color: "var(--color-foreground)",
                  },
                  onClick: () => acceptPath(item),
                },
                React.createElement("span", { className: "font-mono" }, item.display || item.text),
                item.meta
                  ? React.createElement("span", { className: "truncate", style: { color: "var(--color-muted-foreground)" } }, item.meta)
                  : null,
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
            title: "添加文件或路径",
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
          placeholder: props.connected
            ? "发消息，或输入 / 唤起命令、@ 引用文件"
            : "连接中…",
          className: "max-h-48 min-h-[2rem] flex-1 resize-none bg-transparent py-1.5 text-sm outline-none",
          style: { color: "var(--color-foreground)", fontFamily: "var(--font-sans)" },
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
              title: `模型：${props.model || "默认"}（点击切换）`,
              className: "max-w-[18ch] cursor-pointer truncate px-2 py-1.5 text-[0.6875rem]",
              style: { color: "var(--color-muted-foreground)" },
              onClick: props.onOpenModelPicker,
            },
            props.model || "模型",
          ),
          React.createElement(
            "button",
            {
              type: "button",
              title: `思考强度：${reasoningLabel(props.reasoning || "medium")}`,
              className: "cursor-pointer px-2 py-1.5 text-[0.6875rem]",
              style: { color: "var(--color-muted-foreground)" },
              onClick: () => {
                const current = props.reasoning || "medium";
                const index = REASONING_LEVELS.indexOf(current as (typeof REASONING_LEVELS)[number]);
                const next = REASONING_LEVELS[(index + 1) % REASONING_LEVELS.length];
                if (next) props.onPickReasoning(next);
              },
            },
            `思考·${reasoningLabel(props.reasoning || "medium")}`,
          ),
          props.running
            ? React.createElement(
                "button",
                {
                  type: "button",
                  className: "cursor-pointer px-3 py-1.5 text-xs",
                  style: {
                    background: "var(--color-destructive)",
                    color: "var(--color-destructive-foreground, #fff)",
                    borderRadius: "calc(var(--radius) * 0.6)",
                  },
                  onClick: props.onStop,
                },
                "停止",
              )
            : React.createElement(
                "button",
                {
                  type: "button",
                  disabled: !text.trim() || !props.connected,
                  className: "cursor-pointer px-3 py-1.5 text-xs disabled:opacity-40",
                  style: {
                    background: "var(--color-primary)",
                    color: "var(--color-primary-foreground)",
                    borderRadius: "calc(var(--radius) * 0.6)",
                  },
                  onClick: submit,
                },
                "发送",
              ),
        ),
      ),

      // ── status + metrics ─────────────────────────────────────────────────
      React.createElement(
        "div",
        {
          className: "mt-1 flex items-center gap-3 px-1 text-[0.6875rem] tabular-nums",
          style: { color: "var(--color-muted-foreground)" },
        },
        props.status
          ? React.createElement("span", { className: "truncate" }, props.status)
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
                          tone === "calm"
                            ? "var(--color-muted-foreground)"
                            : "var(--color-muted-foreground)",
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
