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

import type { AssistantItem, NoticeItem, ReasoningItem, SubagentChild, SubagentsItem, TimelineItem, ToolItem, UserItem } from "../core/types";
import { isSubagentTerminal } from "../core/types";
import { formatElapsed, messageStamp, messagesFor, type Locale } from "../core/i18n";
import type { HermesPluginSdk } from "./sdk";
import { Markdown } from "./Markdown";
import { formatCount, formatDuration, toolLabel, toolPreview } from "./format";

interface BubbleProps {
  sdk: HermesPluginSdk;
  item: TimelineItem;
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
 * One thinking segment.
 *
 * Rendered as transcript furniture rather than a message: no card, no speaker
 * corner radius, no copy/branch row. While the model thinks, the last line of
 * its reasoning is visible so a long pause reads as work instead of a hang;
 * once the segment ends it collapses to a one-line summary and expands on
 * demand.
 *
 * This replaced a design where reasoning rode on the assistant bubble. Every
 * think-only segment then became an assistant row with empty text, which is
 * what put a blank bubble (and its reserved copy-button strip) under each chain
 * of thought.
 */
function ReasoningRow({
  sdk,
  item,
  locale,
}: {
  sdk: HermesPluginSdk;
  item: ReasoningItem;
  locale: Locale;
}) {
  const { React } = sdk;
  const { useState, useMemo } = sdk.hooks;
  const [open, setOpen] = useState(false);
  const trimmed = item.text.trim();
  const t = messagesFor(locale);

  // Hooks run unconditionally: this component returns null for empty reasoning,
  // and a `useMemo` after that early return throws React #310 the first time a
  // turn has no reasoning and the next one does.
  const tail = useMemo(() => {
    const lines = trimmed.split("\n").filter((line) => line.trim());
    return lines.at(-1) ?? trimmed;
  }, [trimmed]);

  if (!trimmed) return null;

  return React.createElement(
    "div",
    {
      className: "hb-think",
      "data-hb": "reasoning-row",
      "data-streaming": item.streaming ? "true" : "false",
    },
    React.createElement(
      "button",
      {
        type: "button",
        className: "hb-think-head",
        "data-hb": "reasoning-toggle",
        "data-open": open ? "true" : "false",
        "aria-expanded": open ? "true" : "false",
        onClick: () => setOpen((v: boolean) => !v),
      },
      React.createElement("span", { className: "hb-think-caret" }, open ? "▾" : "▸"),
      React.createElement("span", { className: "hb-think-label" }, t.thought),
      item.streaming
        ? React.createElement("span", { className: "hb-caret hb-think-live" }, "●")
        : null,
      React.createElement("span", { className: "hb-think-count" }, t.chars(trimmed.length)),
      // Collapsed, the segment is its own summary. The tail is the same string
      // that streams in, so the row stays one line as it updates.
      !open
        ? React.createElement("span", { className: "hb-think-tail" }, tail)
        : null,
    ),
    open
      ? React.createElement("div", { className: "hb-think-body" }, trimmed)
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
  // Never paint an empty bubble. A turn can create an assistant row before any
  // text exists (a `message.start`, a think-only segment on an old snapshot);
  // the card and its reserved action strip would then read as a blank message
  // with a gap under it. Only a failure has something to say with no text.
  const hasText = item.text.trim().length > 0;
  if (!hasText && !item.error) return null;
  const t = messagesFor(locale);
  return React.createElement(
    "div",
    { className: "flex flex-col items-start" },
    hasText
      ? React.createElement(
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
          React.createElement(Markdown, { sdk, text: item.text, caret: Boolean(item.streaming), locale }),
        )
      : null,
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
    item.usage
      ? React.createElement(
          "div",
          {
            className: "hb-text-tiny hb-mt-sm tabular-nums",
            style: { color: "var(--color-muted-foreground)" },
          },
          [
            item.usage.total ? `${formatCount(item.usage.total)} tokens` : "",
            item.usage.context_percent ? t.contextPercent(item.usage.context_percent) : "",
          ]
            .filter(Boolean)
            .join(" · "),
        )
      : null,
    // Actions only on a settled reply: mid-stream there is nothing to copy or
    // regenerate yet, and the desktop app's own bar is transient for the same reason.
    hasText && !item.streaming && (onBranch || onRegenerate || onCopy)
      ? React.createElement(MessageActions, { sdk, item, locale, onBranch, onRegenerate, onCopy })
      : null,
  );
}

/**
 * A tool call.
 *
 * Deliberately not a card. A turn fires ten or twenty of these, and a card per
 * call (padding, background, a second preview line under the header) turns the
 * transcript into a wall of grey boxes that buries the actual answer. This is a
 * single dim row — caret, name, one-line summary, duration — on a hairline
 * rail: dense enough that a run of calls reads as a list of things that
 * happened, quiet enough that the reply stays the thing you see.
 *
 * Still collapsed by default: the arguments and output are one click away, and
 * expanding is the only thing that grows the row.
 */
function ToolRow({ sdk, item }: { sdk: HermesPluginSdk; item: ToolItem }) {
  const { React } = sdk;
  const { useState } = sdk.hooks;
  const [open, setOpen] = useState(false);
  const preview = toolPreview(item.resultText);
  const argsText = item.argsText ?? (item.args ? JSON.stringify(item.args, null, 2) : "");
  const duration = formatDuration(item.durationS);

  return React.createElement(
    "div",
    {
      className: "hb-tool",
      "data-hb": "tool-row",
      "data-status": item.status,
      "data-name": item.name,
    },
    React.createElement(
      "button",
      {
        type: "button",
        className: "hb-tool-head",
        "data-hb": "tool-toggle",
        "data-open": open ? "true" : "false",
        "aria-expanded": open ? "true" : "false",
        onClick: () => setOpen((v: boolean) => !v),
      },
      React.createElement("span", { className: "hb-tool-caret" }, open ? "▾" : "▸"),
      React.createElement("span", { className: "hb-tool-name" }, toolLabel(item.name)),
      item.status === "running"
        ? React.createElement("span", { className: "hb-caret hb-tool-live" }, "●")
        : null,
      item.summary
        ? React.createElement("span", { className: "hb-tool-summary" }, item.summary)
        : null,
      duration
        ? React.createElement("span", { className: "hb-tool-duration tabular-nums" }, duration)
        : null,
    ),
    item.risk
      ? React.createElement(
          "div",
          { className: "hb-tool-risk" },
          `输出被标记为 ${item.risk}`,
        )
      : null,
    open
      ? React.createElement(
          "div",
          { className: "hb-tool-body" },
          argsText
            ? React.createElement("pre", { className: "hb-output hb-tool-pre" }, argsText)
            : null,
          preview.text
            ? React.createElement(
                "pre",
                { className: "hb-output hb-tool-pre" },
                preview.text + (preview.truncated ? "\n…" : ""),
              )
            : null,
        )
      : null,
  );
}

/**
 * One `delegate_task` batch.
 *
 * Collapsed, it is one line: how many children, how many finished. Expanded, one
 * row per child with its goal and status, and each row expands again onto what
 * that child is actually doing — the last tool, the recent progress lines and,
 * once it finished, its summary. Concurrency is the reason this is a batch card
 * instead of one card per child: three children running at once must read as
 * three rows on one card, not three cards interleaved with the parent's tools.
 */
function SubagentsCard({ sdk, item, locale }: { sdk: HermesPluginSdk; item: SubagentsItem; locale: Locale }) {
  const { React } = sdk;
  const { useState } = sdk.hooks;
  const t = messagesFor(locale);
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const done = item.children.filter((child) => isSubagentTerminal(child.status)).length;
  const total = item.children.length;
  const running = item.children.some((child) => child.status === "running" || child.status === "queued");
  const failed = item.children.some(
    (child) => child.status === "failed" || child.status === "error" || child.status === "timeout",
  );
  const stripe = failed
    ? "var(--color-destructive)"
    : running
      ? "var(--color-ring)"
      : "var(--color-border)";

  const toneOf = (status: string): string => {
    if (status === "running") return "var(--color-primary)";
    if (status === "failed" || status === "error" || status === "timeout" || status === "interrupted") {
      return "var(--color-destructive)";
    }
    return "var(--color-muted-foreground)";
  };

  const childRow = (child: SubagentChild) => {
    const isOpen = Boolean(expanded[child.key]);
    const duration = formatDuration(child.durationS);
    const detail: Array<ReturnType<typeof React.createElement>> = [];
    if (child.lastTool) {
      detail.push(
        React.createElement(
          "div",
          { key: "tool", className: "hb-sub-detail" },
          `${toolLabel(child.lastTool)}${child.toolCount ? ` · ${t.subagentTools(child.toolCount)}` : ""}`,
        ),
      );
    }
    if (child.thinking && !child.summary) {
      detail.push(
        React.createElement("div", { key: "think", className: "hb-sub-detail hb-sub-think" }, child.thinking),
      );
    }
    if (child.progress.length) {
      detail.push(
        React.createElement(
          "div",
          { key: "progress", className: "hb-sub-progress" },
          child.progress.map((line, index) =>
            React.createElement("div", { key: `p${index}`, className: "hb-sub-line" }, line),
          ),
        ),
      );
    }
    if (child.summary) {
      detail.push(
        React.createElement("div", { key: "summary", className: "hb-sub-summary" }, child.summary),
      );
    }
    if (child.tokens && (child.tokens.input || child.tokens.output)) {
      detail.push(
        React.createElement(
          "div",
          { key: "tokens", className: "hb-sub-detail" },
          `${child.tokens.input ?? 0} → ${child.tokens.output ?? 0} tokens`,
        ),
      );
    }
    const files = [...(child.filesWritten ?? []), ...(child.filesRead ?? [])];
    if (files.length) {
      detail.push(
        React.createElement(
          "div",
          { key: "files", className: "hb-sub-detail" },
          files.slice(0, 6).join(" · ") + (files.length > 6 ? " …" : ""),
        ),
      );
    }

    return React.createElement(
      "div",
      { key: child.key, className: "hb-sub-child", "data-hb": "subagent-row", "data-status": child.status },
      React.createElement(
        "button",
        {
          type: "button",
          className: "hb-sub-row",
          "data-hb": "subagent-row-toggle",
          "data-open": isOpen ? "true" : "false",
          "aria-expanded": isOpen ? "true" : "false",
          onClick: () => setExpanded((prev) => ({ ...prev, [child.key]: !prev[child.key] })),
        },
        React.createElement("span", { className: "hb-sub-caret" }, isOpen ? "▾" : "▸"),
        React.createElement("span", { className: "hb-sub-index" }, `${child.taskIndex + 1}`),
        React.createElement(
          "span",
          { className: "hb-sub-goal hb-truncate" },
          child.goal || t.subagents,
        ),
        React.createElement("span", { className: "hb-sub-status", style: { color: toneOf(child.status) } },
          t.subagentStatus(child.status)),
        child.status === "running"
          ? React.createElement("span", { className: "hb-caret hb-sub-live", style: { color: "var(--color-primary)" } }, "●")
          : null,
        duration
          ? React.createElement("span", { className: "hb-sub-duration tabular-nums" }, duration)
          : null,
      ),
      isOpen && detail.length
        ? React.createElement("div", { className: "hb-sub-body" }, detail)
        : null,
    );
  };

  return React.createElement(
    "div",
    { className: "hb-sub-card", "data-hb": "subagent-card", style: { borderLeftColor: stripe } },
    React.createElement(
      "button",
      {
        type: "button",
        className: "hb-sub-head",
        "data-hb": "subagent-toggle",
        "data-open": open ? "true" : "false",
        "aria-expanded": open ? "true" : "false",
        onClick: () => setOpen((v: boolean) => !v),
      },
      React.createElement("span", { className: "hb-sub-caret" }, open ? "▾" : "▸"),
      React.createElement("span", { className: "hb-sub-title" }, t.subagents),
      running
        ? React.createElement("span", { className: "hb-caret hb-sub-live", style: { color: "var(--color-primary)" } }, "●")
        : null,
      React.createElement("span", { className: "hb-sub-count" }, t.subagentProgress(done, total)),
    ),
    open ? React.createElement("div", { className: "hb-sub-list" }, item.children.map(childRow)) : null,
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
      return ToolRow({ sdk, item });
    case "reasoning":
      return ReasoningRow({ sdk, item, locale });
    case "subagents":
      return SubagentsCard({ sdk, item, locale });
    case "notice":
      return NoticeRow({ sdk, item });
  }
}
