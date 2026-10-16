/**
 * One message bubble.
 *
 * All three item kinds render here so the transcript is a single flat list of
 * equal-weight rows — an assistant bubble interrupted by a tool card does not
 * need a nested container to stay grouped.
 *
 * Styling rules: every color/radius/space comes from a dashboard CSS variable
 * (DESIGN.md). Nothing in this file may hardcode a hex value.
 */

import type { AssistantItem, NoticeItem, ToolItem, UserItem } from "../core/types";
import type { HermesPluginSdk } from "./sdk";
import { formatCount, formatDuration, toolLabel, toolPreview } from "./format";

interface BubbleProps {
  sdk: HermesPluginSdk;
  item: UserItem | AssistantItem | ToolItem | NoticeItem;
  onAnswerRequest?: (choice: string) => void;
}

/** The shared corner treatment: large radius on three corners, small on the speaker's own side. */
const USER_RADIUS = "calc(var(--radius) * 1.6) calc(var(--radius) * 1.6) calc(var(--radius) * 0.5) calc(var(--radius) * 1.6)";
const ASSISTANT_RADIUS = "calc(var(--radius) * 1.6) calc(var(--radius) * 1.6) calc(var(--radius) * 1.6) calc(var(--radius) * 0.5)";

function Label({ sdk, text, muted }: { sdk: HermesPluginSdk; text: string; muted?: boolean }) {
  const { React } = sdk;
  return React.createElement(
    "div",
    {
      className: "mb-1 text-[0.6875rem] font-medium uppercase tracking-[0.06em]",
      style: { color: muted ? "var(--color-muted-foreground)" : "var(--color-muted-foreground)" },
    },
    text,
  );
}

function UserBubble({ sdk, item }: { sdk: HermesPluginSdk; item: UserItem }) {
  const { React } = sdk;
  return React.createElement(
    "div",
    { className: "flex flex-col items-end" },
    React.createElement(Label, { sdk, text: "你" }),
    React.createElement(
      "div",
      {
        className: "whitespace-pre-wrap break-words px-3 py-2 text-sm leading-relaxed",
        style: {
          maxWidth: "min(72ch, 82%)",
          background: "color-mix(in oklab, var(--color-primary) 16%, var(--color-card))",
          color: "var(--color-card-foreground)",
          borderRadius: USER_RADIUS,
          opacity: item.pending ? 0.75 : 1,
        },
      },
      item.text,
    ),
  );
}

/**
 * Reasoning, shown semi-explicitly: while the model is thinking, the last line
 * of its reasoning is visible as a live preview so a long pause reads as work
 * rather than a hang. Once the turn ends the block collapses to a one-line
 * summary and expands on demand.
 *
 * This is the middle ground between hiding reasoning entirely and dumping a wall
 * of it into the transcript — the same shape most agent chats use.
 */
function Reasoning({ sdk, text, streaming }: { sdk: HermesPluginSdk; text: string; streaming: boolean }) {
  const { React } = sdk;
  const { useState, useMemo } = sdk.hooks;
  const [open, setOpen] = useState(false);
  const trimmed = text.trim();

  // Hooks must run unconditionally: this component returns null for empty
  // reasoning, and a `useMemo` after that early return throws React #310
  // ("rendered more hooks than during the previous render") the first time a
  // turn has no reasoning and the next one does.
  const tail = useMemo(() => {
    const lines = trimmed.split("\n").filter((line) => line.trim());
    return lines.at(-1) ?? trimmed;
  }, [trimmed]);

  if (!trimmed) return null;

  const chars = trimmed.length;

  return React.createElement(
    "div",
    { className: "mt-1.5", style: { maxWidth: "min(72ch, 82%)" } },
    React.createElement(
      "button",
      {
        type: "button",
        className: "flex w-full cursor-pointer items-center gap-1.5 text-[0.6875rem]",
        style: { color: "var(--color-muted-foreground)" },
        onClick: () => setOpen((v: boolean) => !v),
      },
      React.createElement("span", { style: { color: "var(--color-muted-foreground)" } }, open ? "▾" : "▸"),
      React.createElement("span", { className: "shrink-0 uppercase tracking-[0.06em]" }, "思考"),
      streaming
        ? React.createElement(
            "span",
            { className: "hb-caret shrink-0", style: { color: "var(--color-primary)" } },
            "●",
          )
        : null,
      React.createElement("span", { className: "shrink-0", style: { opacity: 0.7 } }, `${chars} 字`),
      !open && !streaming
        ? React.createElement(
            "span",
            { className: "min-w-0 flex-1 truncate text-left", style: { opacity: 0.8 } },
            tail,
          )
        : null,
    ),
    // While streaming the tail stays visible under the header even when the
    // block is expanded, so the top of a long thought does not push it away.
    streaming && !open
      ? React.createElement(
          "div",
          {
            className: "mt-1 truncate px-2 py-1 text-xs",
            style: {
              color: "var(--color-muted-foreground)",
              borderLeft: "2px solid var(--color-border)",
            },
          },
          tail,
        )
      : null,
    open
      ? React.createElement(
          "div",
          {
            className: "hb-pre mt-1 whitespace-pre-wrap break-words px-2 py-1.5 text-xs",
            style: {
              background: "color-mix(in oklab, var(--color-muted) 45%, var(--color-card))",
              color: "var(--color-muted-foreground)",
              borderRadius: "var(--radius)",
              borderLeft: "2px solid var(--color-border)",
              maxHeight: "22rem",
              overflowY: "auto",
            },
          },
          trimmed,
        )
      : null,
  );
}

function AssistantBubble({ sdk, item }: { sdk: HermesPluginSdk; item: AssistantItem }) {
  const { React } = sdk;
  const errorColor = "var(--color-destructive)";
  return React.createElement(
    "div",
    { className: "flex flex-col items-start" },
    React.createElement(Label, { sdk, text: "Hermes" }),
    React.createElement(
      "div",
      {
        className: "whitespace-pre-wrap break-words px-3 py-2 text-sm leading-relaxed",
        style: {
          maxWidth: "min(72ch, 82%)",
          background: "var(--color-card)",
          color: "var(--color-card-foreground)",
          borderRadius: ASSISTANT_RADIUS,
          boxShadow: "inset 0 0 0 1px var(--color-border)",
        },
      },
      item.text,
      // A caret is the only "still working" signal on the bubble itself; without
      // it a slow first token reads as a hang.
      item.streaming
        ? React.createElement(
            "span",
            {
              className: "ml-0.5 inline-block w-[0.5em] animate-pulse",
              style: { color: "var(--color-primary)" },
            },
            "▌",
          )
        : null,
    ),
    item.error
      ? React.createElement(
          "div",
          {
            className: "mt-1 px-3 py-1.5 text-xs",
            style: { maxWidth: "min(72ch, 82%)", color: errorColor },
          },
          item.error,
        )
      : null,
    React.createElement(Reasoning, { sdk, text: item.reasoning, streaming: item.streaming }),
    item.usage
      ? React.createElement(
          "div",
          {
            className: "mt-1 text-[0.625rem] tabular-nums",
            style: { color: "var(--color-muted-foreground)" },
          },
          [item.usage.total ? `${formatCount(item.usage.total)} tokens` : "", item.usage.context_percent ? `上下文 ${item.usage.context_percent}%` : ""]
            .filter(Boolean)
            .join(" · "),
        )
      : null,
  );
}

function ToolCard({ sdk, item }: { sdk: HermesPluginSdk; item: ToolItem }) {
  const { React } = sdk;
  const { useState } = sdk.hooks;
  // Running tools are open (the user is watching); finished ones collapse so a
  // long chain stays scannable.
  const [open, setOpen] = useState(item.status === "running");
  const preview = toolPreview(item.resultText);
  const stripe =
    item.status === "error" ? "var(--color-destructive)" : item.status === "running" ? "var(--color-ring)" : "var(--color-border)";
  const argsText = item.argsText ?? (item.args ? JSON.stringify(item.args, null, 2) : "");
  const duration = formatDuration(item.durationS);

  return React.createElement(
    "div",
    {
      className: "px-3 py-2 text-xs",
      style: {
        maxWidth: "min(72ch, 82%)",
        background: "color-mix(in oklab, var(--color-muted) 60%, var(--color-card))",
        borderRadius: "var(--radius)",
        borderLeft: `2px solid ${stripe}`,
      },
    },
    React.createElement(
      "button",
      {
        type: "button",
        className: "flex w-full cursor-pointer items-center gap-2 text-left",
        style: { color: "var(--color-card-foreground)" },
        onClick: () => setOpen((v: boolean) => !v),
      },
      React.createElement("span", null, open ? "▾" : "▸"),
      React.createElement("span", { className: "font-medium" }, toolLabel(item.name)),
      item.status === "running"
        ? React.createElement("span", { style: { color: "var(--color-muted-foreground)" } }, "…")
        : null,
      item.summary
        ? React.createElement(
            "span",
            {
              className: "truncate",
              style: { color: "var(--color-muted-foreground)" },
            },
            item.summary,
          )
        : null,
      duration
        ? React.createElement(
            "span",
            { className: "ml-auto shrink-0 tabular-nums", style: { color: "var(--color-muted-foreground)" } },
            duration,
          )
        : null,
    ),
    item.risk
      ? React.createElement(
          "div",
          { className: "mt-1", style: { color: "var(--color-destructive)" } },
          `⚠ 输出被标记为 ${item.risk}`,
        )
      : null,
    open
      ? React.createElement(
          "div",
          { className: "mt-1.5 space-y-1.5" },
          argsText
            ? React.createElement(
                "pre",
                {
                  className: "overflow-x-auto whitespace-pre-wrap break-words p-2",
                  style: {
                    fontFamily: "var(--font-mono)",
                    fontSize: "0.8125rem",
                    background: "var(--color-background)",
                    borderRadius: "calc(var(--radius) * 0.6)",
                  },
                },
                argsText,
              )
            : null,
          preview.text
            ? React.createElement(
                "pre",
                {
                  className: "overflow-x-auto whitespace-pre-wrap break-words p-2",
                  style: {
                    fontFamily: "var(--font-mono)",
                    fontSize: "0.8125rem",
                    background: "var(--color-background)",
                    borderRadius: "calc(var(--radius) * 0.6)",
                  },
                },
                preview.text + (preview.truncated ? "\n…" : ""),
              )
            : null,
        )
      : preview.text
        ? React.createElement(
            "div",
            { className: "mt-1 truncate", style: { color: "var(--color-muted-foreground)" } },
            preview.text.split("\n")[0],
          )
        : null,
  );
}

function NoticeRow({ sdk, item }: { sdk: HermesPluginSdk; item: NoticeItem }) {
  const { React } = sdk;
  return React.createElement(
    "div",
    {
      className: "px-3 py-1.5 text-xs",
      style: {
        maxWidth: "min(72ch, 82%)",
        color: item.tone === "error" ? "var(--color-destructive)" : "var(--color-muted-foreground)",
      },
    },
    item.text,
  );
}

export function Bubble(props: BubbleProps) {
  const { sdk, item } = props;
  switch (item.kind) {
    case "user":
      return UserBubble({ sdk, item });
    case "assistant":
      return AssistantBubble({ sdk, item });
    case "tool":
      return ToolCard({ sdk, item });
    case "notice":
      return NoticeRow({ sdk, item });
  }
}
