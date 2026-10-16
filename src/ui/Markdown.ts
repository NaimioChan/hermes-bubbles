/**
 * Renders the Markdown node tree from `core/markdown.ts`.
 *
 * Everything goes through `React.createElement`, so text is escaped by React and
 * the message content never reaches `innerHTML`. Inline `code` and fenced code
 * blocks are the only elements with a monospace treatment; everything else is
 * ordinary prose inside the bubble.
 *
 * Kept out of `Bubble.ts` because it is the one place that maps a document onto
 * the DOM, and the bubble's job is the frame around it.
 *
 * Styling: colors/radii come from dashboard CSS variables (DESIGN.md). Sizes and
 * spacing use `hb-` classes, because the host's precompiled Tailwind bundle does
 * not contain the utilities this needs (AGENTS.md 铁律 11).
 */

import type { MdBlock, MdInline } from "../core/markdown";
import { parseMarkdown } from "../core/markdown";
import type * as ReactNS from "react";
import type { HermesPluginSdk } from "./sdk";

/** How much of a long code block to show before capping its height. */
const CODE_MAX_HEIGHT = "20rem";

const HEADING_SIZE: Record<number, string> = {
  1: "1.15em",
  2: "1.08em",
  3: "1em",
  4: "0.95em",
  5: "0.9em",
  6: "0.9em",
};

interface Ctx {
  React: HermesPluginSdk["React"];
  /** Links open in a new tab; the dashboard is a local app and links leave it. */
  onOpenLink: (href: string) => void;
}

function renderInline(ctx: Ctx, nodes: MdInline[], keyPrefix: string): ReactNS.ReactNode[] {
  const { React } = ctx;
  return nodes.map((node, index): ReactNS.ReactNode => {
    const key = `${keyPrefix}-i${index}`;
    switch (node.type) {
      case "text":
        return node.value;
      case "code":
        return React.createElement(
          "code",
          {
            key,
            className: "hb-inline-code",
          },
          node.value,
        );
      case "strong":
        return React.createElement("strong", { key, style: { fontWeight: 600 } }, renderInline(ctx, node.children, key));
      case "em":
        return React.createElement("em", { key }, renderInline(ctx, node.children, key));
      case "del":
        return React.createElement("del", { key, style: { opacity: 0.7 } }, renderInline(ctx, node.children, key));
      case "link":
        return React.createElement(
          "a",
          {
            key,
            href: node.href,
            title: node.href,
            // `noreferrer` also implies noopener; the dashboard is same-origin
            // with nothing we want to hand a window reference to.
            rel: "noreferrer noopener",
            target: "_blank",
            className: "hb-link",
            onClick: () => ctx.onOpenLink(node.href),
          },
          renderInline(ctx, node.children, key),
        );
      case "image":
        return node.href
          ? React.createElement("img", {
              key,
              src: node.href,
              alt: node.alt,
              className: "hb-md-image",
              loading: "lazy",
            })
          : React.createElement("span", { key, className: "hb-muted" }, `🖼 ${node.alt}`);
    }
  });
}

function caretNode(ctx: Ctx, key: string): ReactNS.ReactNode {
  return ctx.React.createElement(
    "span",
    {
      key,
      className: "hb-caret",
      style: { color: "var(--color-primary)", marginLeft: "0.1em" },
    },
    "▌",
  );
}

function renderBlocks(ctx: Ctx, blocks: MdBlock[], keyPrefix = "b", caret = false): ReactNS.ReactNode[] {
  const { React } = ctx;

  const nodes: ReactNS.ReactNode[] = blocks.map((block, index): ReactNS.ReactNode => {
    const key = `${keyPrefix}-${index}`;
    // Only the last block can carry the caret; it is appended to that block's
    // own inline content so it sits at the end of the final line.
    const withCaret = caret && index === blocks.length - 1;
    switch (block.type) {
      case "paragraph":
        return React.createElement(
          "p",
          { key, className: "hb-md-p" },
          renderInline(ctx, block.children, key),
          withCaret ? caretNode(ctx, `${key}-caret`) : null,
        );

      case "heading": {
        const tag = `h${Math.min(Math.max(block.level, 1), 6)}`;
        return React.createElement(
          tag,
          {
            key,
            className: "hb-md-h",
            style: { fontSize: HEADING_SIZE[block.level] ?? "1em" },
          },
          renderInline(ctx, block.children, key),
          withCaret ? caretNode(ctx, `${key}-caret`) : null,
        );
      }

      case "code":
        return React.createElement(
          "div",
          { key, className: "hb-md-codeblock" },
          block.lang
            ? React.createElement(
                "div",
                { className: "hb-md-code-lang", style: { color: "var(--color-muted-foreground)" } },
                block.lang,
              )
            : null,
          React.createElement(
            "pre",
            {
              className: "hb-pre hb-md-pre",
              style: { maxHeight: CODE_MAX_HEIGHT, overflow: "auto" },
            },
            React.createElement("code", null, block.value),
          ),
        );

      case "list": {
        const tag = block.ordered ? "ol" : "ul";
        return React.createElement(
          tag,
          {
            key,
            className: block.ordered ? "hb-md-ol" : "hb-md-ul",
            start: block.ordered && block.start !== 1 ? block.start : undefined,
            style: { listStyleType: block.ordered ? "decimal" : "disc" },
          },
          block.items.map((item, itemIndex) =>
            React.createElement(
              "li",
              {
                key: `${key}-l${itemIndex}`,
                className: block.loose ? "hb-md-li-loose" : undefined,
              },
              renderBlocks(ctx, item, `${key}-l${itemIndex}`),
            ),
          ),
        );
      }

      case "blockquote":
        return React.createElement(
          "blockquote",
          {
            key,
            className: "hb-md-quote",
            style: { borderLeft: "2px solid var(--color-border)", color: "var(--color-muted-foreground)" },
          },
          renderBlocks(ctx, block.children, key),
        );

      case "hr":
        return React.createElement("hr", {
          key,
          className: "hb-md-hr",
          style: { borderColor: "var(--color-border)" },
        });

      case "table":
        return React.createElement(
          "div",
          {
            key,
            className: "hb-md-table-wrap",
            style: { borderColor: "var(--color-border)", borderRadius: "calc(var(--radius) * 0.6)" },
          },
          React.createElement(
            "table",
            { className: "hb-md-table" },
            React.createElement(
              "thead",
              null,
              React.createElement(
                "tr",
                null,
                block.head.map((cell, cellIndex) =>
                  React.createElement(
                    "th",
                    {
                      key: `${key}-h${cellIndex}`,
                      style: {
                        textAlign: block.align[cellIndex] ?? "left",
                        borderColor: "var(--color-border)",
                        background: "color-mix(in oklab, var(--color-muted) 50%, transparent)",
                      },
                    },
                    renderInline(ctx, cell, `${key}-h${cellIndex}`),
                  ),
                ),
              ),
            ),
            React.createElement(
              "tbody",
              null,
              block.rows.map((row, rowIndex) =>
                React.createElement(
                  "tr",
                  { key: `${key}-r${rowIndex}` },
                  row.map((cell, cellIndex) =>
                    React.createElement(
                      "td",
                      {
                        key: `${key}-r${rowIndex}c${cellIndex}`,
                        style: {
                          textAlign: block.align[cellIndex] ?? "left",
                          borderColor: "var(--color-border)",
                        },
                      },
                      renderInline(ctx, cell, `${key}-r${rowIndex}c${cellIndex}`),
                    ),
                  ),
                ),
              ),
            ),
          ),
        );
    }
  });

  // A caret on a trailing block that cannot hold inline content (code, table,
  // list, hr) goes underneath, which is the honest place for it.
  if (caret) {
    const last = blocks[blocks.length - 1];
    const inlineCapable = last && (last.type === "paragraph" || last.type === "heading");
    if (!inlineCapable) {
      nodes.push(
        React.createElement("div", { key: `${keyPrefix}-tail-caret` }, caretNode(ctx, `${keyPrefix}-tail-caret-s`)),
      );
    }
  }

  return nodes;
}

/**
 * Markdown, or nothing at all when the text is empty.
 *
 * The parse result is memoised on the raw string: a streaming turn re-parses only
 * when the text actually changed, and a 500-line reply behind a scroll position
 * does not re-walk the tree on unrelated renders.
 */
export function Markdown({
  sdk,
  text,
  caret = false,
}: {
  sdk: HermesPluginSdk;
  text: string;
  caret?: boolean;
}) {
  const { React } = sdk;
  const { useMemo } = sdk.hooks;

  const blocks = useMemo(() => parseMarkdown(text), [text]);
  if (!blocks.length) return null;

  const ctx: Ctx = {
    React,
    onOpenLink: (href: string) => {
      try {
        window.open(href, "_blank", "noopener,noreferrer");
      } catch {
        // A blocked popup is not worth interrupting the transcript for; the
        // anchor's own href is still there and the title shows the target.
      }
    },
  };

  return React.createElement("div", { className: "hb-md" }, renderBlocks(ctx, blocks, "b", caret));
}
