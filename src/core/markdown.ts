/**
 * A Markdown parser sized for chat transcripts.
 *
 * Why hand-written: the bundle ships without dependencies, and the host exposes
 * no renderer — checked on 0.22.2, `SDK.components` has no markdown/prose entry
 * and `marked` / `markdown-it` / `DOMPurify` are all absent from `window`. A
 * focused subset beats vendoring a parser plus a sanitizer into an IIFE.
 *
 * Two constraints shape the design.
 *
 * 1. **It never produces HTML.** The output is a node tree that the UI renders
 *    with `React.createElement`, so text is escaped by React and there is no
 *    `innerHTML` anywhere. That deletes the injection class rather than
 *    sanitizing around it. `href` is still filtered, because React does not
 *    refuse a `javascript:` URL on its own.
 *
 * 2. **It is run on half-finished text.** Every streaming delta re-parses the
 *    whole message, so an unterminated fence, a lone `**`, or a table whose
 *    separator row has not arrived yet are normal inputs rather than errors.
 *    Unclosed fences stay code blocks (`closed: false`); unclosed inline
 *    markers degrade to literal text.
 *
 * Deliberately not supported: setext headings (`Title` + `---`). Models write
 * `##`, and treating a bare `---` as a heading would surprise far more often
 * than it helps.
 *
 * No DOM, no dependencies, pure string in / tree out (AGENTS.md 铁律 1).
 */

export interface MdText {
  type: "text";
  value: string;
}

export interface MdCodeSpan {
  type: "code";
  value: string;
}

export interface MdStrong {
  type: "strong";
  children: MdInline[];
}

export interface MdEm {
  type: "em";
  children: MdInline[];
}

export interface MdDel {
  type: "del";
  children: MdInline[];
}

export interface MdLink {
  type: "link";
  href: string;
  children: MdInline[];
}

export interface MdImage {
  type: "image";
  href: string | null;
  alt: string;
}

export type MdInline = MdText | MdCodeSpan | MdStrong | MdEm | MdDel | MdLink | MdImage;

export interface MdParagraph {
  type: "paragraph";
  children: MdInline[];
}

export interface MdHeading {
  type: "heading";
  level: number;
  children: MdInline[];
}

export interface MdCodeBlock {
  type: "code";
  lang: string;
  value: string;
  /** False when the closing fence never arrived, i.e. the message is still streaming. */
  closed: boolean;
}

export interface MdList {
  type: "list";
  ordered: boolean;
  start: number;
  /** Each item is its own block list, so items can nest further blocks. */
  items: MdBlock[][];
  loose: boolean;
}

export interface MdQuote {
  type: "blockquote";
  children: MdBlock[];
}

export interface MdHr {
  type: "hr";
}

export type MdAlign = "left" | "center" | "right" | null;

export interface MdTable {
  type: "table";
  align: MdAlign[];
  head: MdInline[][];
  rows: MdInline[][][];
}

export type MdBlock =
  | MdParagraph
  | MdHeading
  | MdCodeBlock
  | MdList
  | MdQuote
  | MdHr
  | MdTable;

const ESCAPABLE = new Set("\\`*_{}[]()#+-.!>~|".split(""));

/* ── entry point ──────────────────────────────────────────────────────────── */

export function parseMarkdown(source: string): MdBlock[] {
  if (!source) return [];
  return parseBlocks(source.replace(/\r\n?/g, "\n").split("\n"));
}

/* ── block level ──────────────────────────────────────────────────────────── */

const FENCE_RE = /^ {0,3}(`{3,}|~{3,})[ \t]*([^`]*)$/;
const HEADING_RE = /^ {0,3}(#{1,6})[ \t]+(.*)$/;
const HR_RE = /^ {0,3}(?:-{3,}|\*{3,}|_{3,})[ \t]*$/;
const LIST_RE = /^(\s*)([-*+]|\d{1,9}[.)])[ \t]+(.*)$/;
const QUOTE_RE = /^ {0,3}>[ \t]?(.*)$/;
const TABLE_SEP_RE = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;

function indentOf(line: string): number {
  let n = 0;
  while (line[n] === " ") n += 1;
  return n;
}

function matchFence(line: string): { char: string; length: number; info: string } | null {
  const m = FENCE_RE.exec(line);
  if (!m) return null;
  const marker = m[1] as string;
  return { char: marker[0] as string, length: marker.length, info: (m[2] ?? "").trim() };
}

function parseBlocks(lines: string[]): MdBlock[] {
  const blocks: MdBlock[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] as string;

    if (!line.trim()) {
      i += 1;
      continue;
    }

    const fence = matchFence(line);
    if (fence) {
      const body: string[] = [];
      let closed = false;
      i += 1;
      while (i < lines.length) {
        const candidate = lines[i] as string;
        const closing = matchFence(candidate);
        if (closing && closing.char === fence.char && closing.length >= fence.length && !closing.info) {
          closed = true;
          i += 1;
          break;
        }
        body.push(candidate);
        i += 1;
      }
      blocks.push({ type: "code", lang: fence.info.split(/\s+/)[0] ?? "", value: body.join("\n"), closed });
      continue;
    }

    const heading = HEADING_RE.exec(line);
    if (heading) {
      blocks.push({
        type: "heading",
        level: (heading[1] as string).length,
        children: parseInline((heading[2] as string).trim()),
      });
      i += 1;
      continue;
    }

    if (HR_RE.test(line)) {
      blocks.push({ type: "hr" });
      i += 1;
      continue;
    }

    if (QUOTE_RE.test(line)) {
      const inner: string[] = [];
      while (i < lines.length) {
        const quoted = QUOTE_RE.exec(lines[i] as string);
        if (quoted) {
          inner.push(quoted[1] as string);
          i += 1;
          continue;
        }
        // Lazy continuation: a plain line keeps the quote going, unless it
        // starts a block that clearly ends it.
        const next = lines[i] as string;
        if (next.trim() && !matchFence(next) && !HEADING_RE.test(next) && !LIST_RE.test(next) && !HR_RE.test(next)) {
          inner.push(next);
          i += 1;
          continue;
        }
        break;
      }
      blocks.push({ type: "blockquote", children: parseBlocks(inner) });
      continue;
    }

    if (LIST_RE.test(line)) {
      const result = parseList(lines, i);
      blocks.push(result.block);
      i = result.next;
      continue;
    }

    if (isTableStart(lines, i)) {
      const result = parseTable(lines, i);
      blocks.push(result.block);
      i = result.next;
      continue;
    }

    // Paragraph: consecutive plain lines.
    const paragraph: string[] = [];
    while (i < lines.length) {
      const current = lines[i] as string;
      if (!current.trim()) break;
      if (
        paragraph.length > 0 &&
        (matchFence(current) ||
          HEADING_RE.test(current) ||
          HR_RE.test(current) ||
          LIST_RE.test(current) ||
          QUOTE_RE.test(current) ||
          isTableStart(lines, i))
      ) {
        break;
      }
      paragraph.push(current.trim());
      i += 1;
    }
    if (paragraph.length) {
      blocks.push({ type: "paragraph", children: parseInline(paragraph.join("\n")) });
    }
  }

  return blocks;
}

interface ListParse {
  block: MdList;
  next: number;
}

function parseList(lines: string[], start: number): ListParse {
  const first = LIST_RE.exec(lines[start] as string) as RegExpExecArray;
  const baseIndent = (first[1] as string).length;
  const ordered = /\d/.test(first[2] as string);
  const startNumber = ordered ? Number.parseInt((first[2] as string).replace(/[.)]$/, ""), 10) : 1;

  const raw: string[][] = [[first[3] as string]];
  let loose = false;
  let i = start + 1;

  while (i < lines.length) {
    const line = lines[i] as string;

    if (!line.trim()) {
      // A blank line only continues the list if more list content follows.
      let j = i + 1;
      while (j < lines.length && !(lines[j] as string).trim()) j += 1;
      if (j >= lines.length) break;
      const nextLine = lines[j] as string;
      const nextMarker = LIST_RE.exec(nextLine);
      const continues = nextMarker ? indentOf(nextLine) >= baseIndent : indentOf(nextLine) >= baseIndent + 2;
      if (!continues) break;
      loose = true;
      (raw[raw.length - 1] as string[]).push("");
      i += 1;
      continue;
    }

    const marker = LIST_RE.exec(line);
    const indent = indentOf(line);

    // A sibling marker at the list's own indent opens a new item.
    if (marker && indent === baseIndent) {
      raw.push([marker[3] as string]);
      i += 1;
      continue;
    }

    // Anything more indented (or a plain indented line) belongs to the current
    // item, dedented so nested parsing sees its own structure.
    if (indent >= baseIndent + 2 || (!marker && indent > baseIndent)) {
      const dedent = Math.min(indent, baseIndent + 2);
      (raw[raw.length - 1] as string[]).push(line.slice(dedent));
      i += 1;
      continue;
    }

    if (marker && indent > baseIndent) {
      const dedent = Math.min(indent, baseIndent + 2);
      (raw[raw.length - 1] as string[]).push(line.slice(dedent));
      i += 1;
      continue;
    }

    break;
  }

  return {
    block: {
      type: "list",
      ordered,
      start: Number.isFinite(startNumber) ? startNumber : 1,
      items: raw.map((itemLines) => parseBlocks(itemLines)),
      loose,
    },
    next: i,
  };
}

function isTableStart(lines: string[], i: number): boolean {
  const header = lines[i];
  const separator = lines[i + 1];
  if (header === undefined || separator === undefined) return false;
  if (!header.includes("|")) return false;
  if (!separator.includes("|") && !separator.includes("-")) return false;
  return TABLE_SEP_RE.test(separator);
}

function splitTableRow(line: string): string[] {
  const cells: string[] = [];
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  let current = "";
  let inCode = false;
  for (let i = 0; i < trimmed.length; i += 1) {
    const ch = trimmed[i] as string;
    if (ch === "\\" && i + 1 < trimmed.length) {
      current += trimmed[i + 1] as string;
      i += 1;
      continue;
    }
    if (ch === "`") {
      inCode = !inCode;
      current += ch;
      continue;
    }
    if (ch === "|" && !inCode) {
      cells.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  cells.push(current.trim());
  return cells;
}

function parseAlign(separator: string): MdAlign[] {
  return splitTableRow(separator).map((cell) => {
    const left = cell.startsWith(":");
    const right = cell.endsWith(":");
    if (left && right) return "center";
    if (right) return "right";
    if (left) return "left";
    return null;
  });
}

function parseTable(lines: string[], start: number): { block: MdTable; next: number } {
  const head = splitTableRow(lines[start] as string).map((cell) => parseInline(cell));
  const align = parseAlign(lines[start + 1] as string);
  const rows: MdInline[][][] = [];
  let i = start + 2;
  while (i < lines.length) {
    const line = lines[i] as string;
    if (!line.trim() || !line.includes("|")) break;
    const cells = splitTableRow(line);
    // Pad or clip so every row matches the header width; a short row is normal
    // while a streamed table is still arriving.
    while (cells.length < head.length) cells.push("");
    rows.push(cells.slice(0, head.length).map((cell) => parseInline(cell)));
    i += 1;
  }
  return { block: { type: "table", align, head, rows }, next: i };
}

/* ── inline level ─────────────────────────────────────────────────────────── */

function runLength(source: string, at: number, ch: string): number {
  let n = 0;
  while (source[at + n] === ch) n += 1;
  return n;
}

/** Index of the next run of exactly `len` copies of `ch`, or -1. */
function findRun(source: string, from: number, ch: string, len: number): number {
  let i = from;
  while (i < source.length) {
    if (source[i] === ch && runLength(source, i, ch) === len) return i;
    i += 1;
  }
  return -1;
}

/**
 * Allow only schemes that cannot execute. Anything else (notably
 * `javascript:` and `data:`) loses its link and renders as plain text.
 */
export function safeHref(raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) {
    return /^(https?:|mailto:|tel:)/i.test(value) ? value : null;
  }
  // Relative, root-relative and fragment links are fine.
  return value;
}

function findClosingDelim(source: string, from: number, delim: string, underscore: boolean): number {
  let j = from;
  while (j < source.length) {
    const at = source.indexOf(delim, j);
    if (at === -1) return -1;
    if (underscore) {
      const after = source[at + delim.length];
      // `_` cannot close against a following word character, or snake_case
      // identifiers would turn into emphasis.
      if (after !== undefined && /[A-Za-z0-9]/.test(after)) {
        j = at + delim.length;
        continue;
      }
    }
    return at;
  }
  return -1;
}

interface EmphasisMatch {
  node: MdInline;
  end: number;
}

function parseEmphasis(source: string, at: number): EmphasisMatch | null {
  const ch = source[at] as string;
  const underscore = ch === "_";
  if (underscore && at > 0 && /[A-Za-z0-9]/.test(source[at - 1] as string)) return null;

  const run = runLength(source, at, ch);
  const maxLen = Math.min(run, 3);

  // Longest delimiter first, so `***x***` nests rather than splitting oddly.
  for (let len = maxLen; len >= 1; len -= 1) {
    const afterOpen = source[at + len];
    if (afterOpen === undefined || /\s/.test(afterOpen)) continue;
    const delim = ch.repeat(len);
    const close = findClosingDelim(source, at + len, delim, underscore);
    if (close === -1 || close === at + len) continue;
    if (/\s/.test(source[close - 1] as string)) continue;

    const children = parseInline(source.slice(at + len, close));
    // While streaming, `**bold` arrives before its closer. Leaving it literal
    // avoids showing a stray pair of asterisks pop in and out.
    const node: MdInline =
      len === 3
        ? { type: "strong", children: [{ type: "em", children }] }
        : len === 2
          ? { type: "strong", children }
          : { type: "em", children };
    return { node, end: close + len };
  }
  return null;
}

function parseLinkLike(source: string, at: number): { href: string; children: MdInline[]; end: number } | null {
  // `at` points at `[`.
  const closeBracket = findClosingBracket(source, at);
  if (closeBracket === -1) return null;
  if (source[closeBracket + 1] !== "(") return null;
  const closeParen = findClosingParen(source, closeBracket + 1);
  if (closeParen === -1) return null;
  const target = source.slice(closeBracket + 2, closeParen).trim();
  // A title (`"..."`) may follow the URL; keep only the URL.
  const href = target.split(/\s+/)[0] ?? "";
  if (!href) return null;
  return { href, children: parseInline(source.slice(at + 1, closeBracket)), end: closeParen + 1 };
}

/**
 * Matching `)` for the `(` at `from`, counting nesting.
 *
 * A plain `indexOf(")")` truncates any URL that contains parentheses —
 * `[x](https://en.wikipedia.org/wiki/A_(b))` would stop inside the article name
 * and leave a stray `)` as text.
 */
function findClosingParen(source: string, from: number): number {
  let depth = 0;
  for (let i = from; i < source.length; i += 1) {
    const ch = source[i] as string;
    if (ch === "\\") {
      i += 1;
      continue;
    }
    if (ch === "(") depth += 1;
    else if (ch === ")") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Matching `]` for the `[` at `from`, skipping code spans and nested brackets. */
function findClosingBracket(source: string, from: number): number {
  let depth = 0;
  let inCode = false;
  for (let i = from; i < source.length; i += 1) {
    const ch = source[i] as string;
    if (ch === "\\") {
      i += 1;
      continue;
    }
    if (ch === "`") inCode = !inCode;
    if (inCode) continue;
    if (ch === "[") depth += 1;
    else if (ch === "]") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function flatten(nodes: MdInline[]): string {
  let out = "";
  for (const node of nodes) {
    if (node.type === "text" || node.type === "code") out += node.value;
    else if (node.type === "image") out += node.alt;
    else if ("children" in node) out += flatten(node.children);
  }
  return out;
}

/**
 * Trailing punctuation is far more likely to be sentence punctuation than part
 * of the URL ("see https://x.com, then"). Closing brackets are only stripped
 * when the URL did not open one.
 */
function stripTrailingPunctuation(url: string): string {
  let out = url;
  for (;;) {
    const last = out[out.length - 1];
    if (last === undefined) return out;
    if (/[.,;:!?'"]/.test(last)) {
      out = out.slice(0, -1);
      continue;
    }
    if (last === ")") {
      const opens = (out.match(/\(/g) ?? []).length;
      const closes = (out.match(/\)/g) ?? []).length;
      if (closes > opens) {
        out = out.slice(0, -1);
        continue;
      }
    }
    return out;
  }
}

export function parseInline(source: string): MdInline[] {
  const nodes: MdInline[] = [];
  let buffer = "";

  const flush = () => {
    if (!buffer) return;
    const last = nodes[nodes.length - 1];
    if (last && last.type === "text") last.value += buffer;
    else nodes.push({ type: "text", value: buffer });
    buffer = "";
  };

  let i = 0;
  while (i < source.length) {
    const ch = source[i] as string;

    if (ch === "\\" && i + 1 < source.length && ESCAPABLE.has(source[i + 1] as string)) {
      buffer += source[i + 1] as string;
      i += 2;
      continue;
    }

    if (ch === "`") {
      const open = runLength(source, i, "`");
      const close = findRun(source, i + open, "`", open);
      if (close !== -1) {
        flush();
        // CommonMark strips one leading and trailing space, which is how you
        // write a code span that starts with a backtick.
        const raw = source.slice(i + open, close);
        nodes.push({ type: "code", value: raw.replace(/^ (.*) $/s, "$1") });
        i = close + open;
        continue;
      }
    }

    if (ch === "!" && source[i + 1] === "[") {
      const parsed = parseLinkLike(source, i + 1);
      if (parsed) {
        flush();
        nodes.push({ type: "image", href: safeHref(parsed.href), alt: flatten(parsed.children) });
        i = parsed.end;
        continue;
      }
    }

    if (ch === "[") {
      const parsed = parseLinkLike(source, i);
      if (parsed) {
        const href = safeHref(parsed.href);
        flush();
        if (href) nodes.push({ type: "link", href, children: parsed.children });
        else nodes.push(...parsed.children);
        i = parsed.end;
        continue;
      }
    }

    if (ch === "<") {
      const end = source.indexOf(">", i + 1);
      if (end !== -1) {
        const inner = source.slice(i + 1, end);
        if (/^(https?:\/\/|mailto:)\S+$/i.test(inner)) {
          flush();
          nodes.push({
            type: "link",
            href: inner,
            children: [{ type: "text", value: inner.replace(/^mailto:/i, "") }],
          });
          i = end + 1;
          continue;
        }
      }
    }

    if (ch === "~" && source[i + 1] === "~") {
      const close = findRun(source, i + 2, "~", 2);
      if (close !== -1 && close > i + 2 && !/\s$/.test(source.slice(i + 2, close))) {
        flush();
        nodes.push({ type: "del", children: parseInline(source.slice(i + 2, close)) });
        i = close + 2;
        continue;
      }
    }

    if (ch === "*" || ch === "_") {
      const match = parseEmphasis(source, i);
      if (match) {
        flush();
        nodes.push(match.node);
        i = match.end;
        continue;
      }
    }

    // Bare URLs, which models emit constantly.
    if ((ch === "h" || ch === "H") && /^https?:\/\//i.test(source.slice(i, i + 8))) {
      const match = /^https?:\/\/[^\s<>`]+/i.exec(source.slice(i));
      if (match) {
        const url = stripTrailingPunctuation(match[0]);
        if (url.length > "https://".length && safeHref(url)) {
          flush();
          nodes.push({ type: "link", href: url, children: [{ type: "text", value: url }] });
          i += url.length;
          continue;
        }
      }
    }

    buffer += ch;
    i += 1;
  }

  flush();
  return nodes;
}
