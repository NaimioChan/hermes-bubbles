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
import { formatElapsed, messageStamp, messagesFor, type Locale } from "../core/i18n";
import type { HermesPluginSdk } from "./sdk";
import { Markdown } from "./Markdown";
import { formatCount, formatDuration, toolLabel, toolPreview } from "./format";

interface BubbleProps {
  sdk: HermesPluginSdk;
  item: UserItem | AssistantItem | ToolItem | NoticeItem;
  locale: Locale;
  /** Per-message actions. Absent on a transcript that cannot act (a read-only view). */
  onEdit?: (itemId: string, text: string) => void;
  onBranch?: (itemId: string) => void;
  onRegenerate?: (itemId: string) => void;
  onCopy?: (text: string) => void;
}

/** The shared corner treatment: large radius on three corners, small on the speaker's own side. */
const USER_RADIUS = "calc(var(--radius) * 1.6) calc(var(--radius) * 1.6) calc(var(--radius) * 0.5) calc(var(--radius) * 1.6)";
const ASSISTANT_RADIUS = "calc(var(--radius) * 1.6) calc(var(--radius) * 1.6) calc(var(--radius) * 1.6) calc(var(--radius) * 0.5)";

function UserBubble({
  sdk,
  item,
  locale,
  onEdit,
}: {
  sdk: HermesPluginSdk;
  item: UserItem;
  locale: Locale;
  onEdit?: (itemId: string, text: string) => void;
}) {
  const { React } = sdk;
  const t = messagesFor(locale);
  return React.createElement(
    "div",
    { className: "flex flex-col items-end" },
    React.createElement(
      "div",
      {
        className: "whitespace-pre-wrap break-words px-3 py-2 text-sm leading-relaxed hb-bubble-text",
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
    // Edit is offered on a settled user turn only: while it is still in flight
    // there is no stored row to cut, and the affordance would fail on click.
    onEdit && !item.pending
      ? React.createElement(
          "div",
          { className: "hb-actions flex items-center gap-1.5", "data-hb": "user-actions" },
          React.createElement(
            "div",
            { className: "hb-actions-tools ml-auto flex items-center gap-1" },
            React.createElement(
              "button",
              {
                type: "button",
                title: t.edit,
                "aria-label": t.edit,
                "data-hb": "edit-message",
                className: "hb-action-btn",
                onClick: (event: { stopPropagation: () => void }) => {
                  event.stopPropagation();
                  onEdit(item.id, item.text);
                },
              },
              "✎",
            ),
          ),
        )
      : null,
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
function Reasoning({
  sdk,
  text,
  streaming,
  locale,
}: {
  sdk: HermesPluginSdk;
  text: string;
  streaming: boolean;
  locale: Locale;
}) {
  const { React } = sdk;
  const { useState, useMemo } = sdk.hooks;
  const [open, setOpen] = useState(false);
  const trimmed = text.trim();
  const t = messagesFor(locale);

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
    { className: "hb-stack-gap", style: { maxWidth: "min(72ch, 82%)" } },
    React.createElement(
      "button",
      {
        type: "button",
        className: "flex w-full cursor-pointer items-center gap-1.5 text-[0.6875rem]",
        "data-hb": "reasoning-toggle",
        style: { color: "var(--color-muted-foreground)" },
        onClick: () => setOpen((v: boolean) => !v),
      },
      React.createElement("span", { style: { color: "var(--color-muted-foreground)" } }, open ? "▾" : "▸"),
      React.createElement("span", { className: "shrink-0 uppercase tracking-[0.06em]" }, t.thought),
      streaming
        ? React.createElement(
            "span",
            { className: "hb-caret shrink-0", style: { color: "var(--color-primary)" } },
            "●",
          )
        : null,
      React.createElement("span", { className: "shrink-0", style: { opacity: 0.7 } }, t.chars(chars)),
      !open && !streaming
        ? React.createElement(
            "span",
            { className: "hb-truncate hb-flex-fill text-left", style: { opacity: 0.8 } },
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
            className: "hb-mt-sm hb-truncate px-2 py-1 text-xs",
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
            className: "hb-pre hb-mt-sm break-words px-2 py-1.5 text-xs",
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

/**
 * The action row under a settled reply, mirroring the desktop app's footer:
 * timestamp, branch in new chat, copy, regenerate.
 *
 * Always mounted but transparent until the row is hovered, so revealing it does
 * not shift the conversation (the desktop app calls this out explicitly — it is
 * why the bar is never unmounted while streaming). Read-aloud and reactions are
 * deliberately absent: both need voice/reaction plumbing this plugin has none of.
 */
function MessageActions({
  sdk,
  item,
  locale,
  onBranch,
  onRegenerate,
  onCopy,
}: {
  sdk: HermesPluginSdk;
  item: AssistantItem;
  locale: Locale;
  onBranch?: (itemId: string) => void;
  onRegenerate?: (itemId: string) => void;
  onCopy?: (text: string) => void;
}) {
  const { React } = sdk;
  const { useState } = sdk.hooks;
  const [copied, setCopied] = useState(false);
  const t = messagesFor(locale);

  const stamp = messageStamp(item.completedAt ?? item.at, locale);

  const iconButton = (key: string, title: string, glyph: string, action: () => void) =>
    React.createElement(
      "button",
      {
        key,
        type: "button",
        title,
        "aria-label": title,
        className: "hb-action-btn",
        onClick: (event: { stopPropagation: () => void }) => {
          event.stopPropagation();
          action();
        },
      },
      glyph,
    );

  return React.createElement(
    "div",
    {
      className: "hb-actions flex items-center gap-1.5",
      "data-hb": "message-actions",
      style: { maxWidth: "min(72ch, 82%)" },
    },
    stamp
      ? React.createElement(
          "time",
          {
            className: "hb-text-micro tabular-nums",
            style: { color: "var(--color-muted-foreground)" },
            // The tooltip carries the turn's duration when the backend implied one.
            title: item.durationS ? t.turnDuration(formatElapsed(item.durationS)) : undefined,
          },
          stamp,
        )
      : null,
    React.createElement(
      "div",
      { className: "hb-actions-tools ml-auto flex items-center gap-1" },
      onBranch ? iconButton("branch", t.branchNewChat, "⑂", () => onBranch(item.id)) : null,
      onCopy
        ? iconButton("copy", copied ? t.copied : t.copy, copied ? "✓" : "⧉", () => {
            onCopy(item.text);
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1500);
          })
        : null,
      onRegenerate ? iconButton("regen", t.refresh, "↻", () => onRegenerate(item.id)) : null,
    ),
  );
}

function AssistantBubble({
  sdk,
  item,
  locale,
  onBranch,
  onRegenerate,
  onCopy,
}: {
  sdk: HermesPluginSdk;
  item: AssistantItem;
  locale: Locale;
  onBranch?: (itemId: string) => void;
  onRegenerate?: (itemId: string) => void;
  onCopy?: (text: string) => void;
}) {
  const { React } = sdk;
  const errorColor = "var(--color-destructive)";
  return React.createElement(
    "div",
    { className: "flex flex-col items-start" },
    React.createElement(
      "div",
      {
        className: "break-words px-3 py-2 text-sm leading-relaxed hb-bubble-text",
        style: {
          maxWidth: "min(72ch, 82%)",
          background: "var(--color-card)",
          color: "var(--color-card-foreground)",
          borderRadius: ASSISTANT_RADIUS,
          boxShadow: "inset 0 0 0 1px var(--color-border)",
        },
      },
      // The reply is Markdown. The caret rides inside the last block so a slow
      // first token reads as work rather than a hang, without pushing a line.
      React.createElement(Markdown, { sdk, text: item.text, caret: Boolean(item.streaming) }),
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
    React.createElement(Reasoning, { sdk, text: item.reasoning, streaming: item.streaming, locale }),
    item.usage
      ? React.createElement(
          "div",
          {
            className: "hb-text-tiny hb-mt-sm tabular-nums",
            style: { color: "var(--color-muted-foreground)" },
          },
          [
            item.usage.total ? `${formatCount(item.usage.total)} tokens` : "",
            item.usage.context_percent ? `上下文 ${item.usage.context_percent}%` : "",
          ]
            .filter(Boolean)
            .join(" · "),
        )
      : null,
    // Actions only on a settled reply: mid-stream there is nothing to copy or
    // regenerate yet, and the desktop app's own bar is transient for the same reason.
    !item.streaming && (onBranch || onRegenerate || onCopy)
      ? React.createElement(MessageActions, { sdk, item, locale, onBranch, onRegenerate, onCopy })
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
    item.status === "error"
      ? "var(--color-destructive)"
      : item.status === "running"
        ? "var(--color-ring)"
        : "var(--color-border)";
  const argsText = item.argsText ?? (item.args ? JSON.stringify(item.args, null, 2) : "");
  const duration = formatDuration(item.durationS);
  const outputStyle = {
    padding: "0.5rem",
    fontFamily: "var(--font-mono)",
    fontSize: "0.8125rem",
    background: "color-mix(in oklab, var(--color-muted) 70%, transparent)",
    borderRadius: "calc(var(--radius) * 0.6)",
  };

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
            { className: "hb-truncate hb-flex-fill", style: { color: "var(--color-muted-foreground)" } },
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
          `输出被标记为 ${item.risk}`,
        )
      : null,
    open
      ? React.createElement(
          "div",
          { className: "hb-stack-gap space-y-1.5" },
          argsText
            ? React.createElement("pre", { className: "hb-output", style: outputStyle }, argsText)
            : null,
          preview.text
            ? React.createElement(
                "pre",
                { className: "hb-output", style: outputStyle },
                preview.text + (preview.truncated ? "\n…" : ""),
              )
            : null,
        )
      : preview.text
        ? React.createElement(
            "div",
            { className: "mt-1 hb-truncate", style: { color: "var(--color-muted-foreground)" } },
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
  const { sdk, item, locale } = props;
  switch (item.kind) {
    case "user":
      return UserBubble({ sdk, item, locale, onEdit: props.onEdit });
    case "assistant":
      return AssistantBubble({
        sdk,
        item,
        locale,
        onBranch: props.onBranch,
        onRegenerate: props.onRegenerate,
        onCopy: props.onCopy,
      });
    case "tool":
      return ToolCard({ sdk, item });
    case "notice":
      return NoticeRow({ sdk, item });
  }
}
