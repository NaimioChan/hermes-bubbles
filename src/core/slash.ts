/**
 * Slash-command parsing and completion state.
 *
 * Pure logic: given the composer's text and caret position, decide whether a
 * slash token is active, what it is, and how an accepted completion rewrites
 * the text. No DOM, no RPC — the caller supplies the catalog and the items.
 *
 * The wire side (`complete.slash`, `commands.catalog`, `command.dispatch`) is
 * documented in `docs/01-protocol-contract.md` §4.
 */

export interface CompletionItem {
  text: string;
  display?: string;
  meta?: string;
  kind?: string;
}

export interface CatalogPair {
  name: string;
  description: string;
}

/** One entry in the popover, normalized from either `complete.slash` or `commands.catalog`. */
export interface CommandEntry {
  /** The token inserted into the composer (without the leading slash). */
  name: string;
  description: string;
  /** `command` | `skill` — from `complete.slash`'s `kind`; `command` for catalog rows. */
  kind: "command" | "skill";
  /** Usage count for skills, used to rank. */
  usage?: number;
}

/** The active `/token` under the caret, if any. */
export interface SlashToken {
  /** Text from the slash through the caret, e.g. `/ski`. */
  raw: string;
  /** Just the name part, e.g. `ski`. */
  query: string;
  /** Index of the `/` in the string. */
  start: number;
  /** Caret index the token ends at. */
  end: number;
}

/**
 * Find the slash token the caret is inside.
 *
 * A token only counts when the `/` starts the composer or follows whitespace —
 * otherwise a path like `src/foo` would pop the command menu mid-word. Newlines
 * end a token, so a slash on a previous line never completes.
 */
export function findSlashToken(text: string, caret: number): SlashToken | null {
  const pos = Math.max(0, Math.min(caret, text.length));
  let start = -1;
  for (let i = pos - 1; i >= 0; i -= 1) {
    const ch = text[i];
    if (ch === "/") {
      start = i;
      break;
    }
    if (ch === undefined || /\s/.test(ch)) break;
  }
  if (start === -1) return null;
  // The slash must open the composer or follow whitespace.
  if (start > 0) {
    const before = text[start - 1];
    if (before !== undefined && !/\s/.test(before)) return null;
  }
  const raw = text.slice(start, pos);
  // `/` alone is the "show me everything" case; anything after must be name-like.
  const body = raw.slice(1);
  if (body && !/^[\w:.-]*$/.test(body)) return null;
  return { raw, query: body, start, end: pos };
}

/**
 * Replace the active token with `name`, returning the new text and caret.
 *
 * A trailing space is appended so the user can immediately type an argument —
 * that is what every other chat composer does, and it makes the "did it take?"
 * feedback obvious.
 */
export function applyCompletion(
  text: string,
  token: SlashToken,
  name: string,
): { text: string; caret: number } {
  const inserted = `/${name} `;
  const next = text.slice(0, token.start) + inserted + text.slice(token.end);
  return { text: next, caret: token.start + inserted.length };
}

/** Case-insensitive substring match, prefix matches first, then skills by usage. */
export function filterCommands(entries: readonly CommandEntry[], query: string, limit = 50): CommandEntry[] {
  const q = query.trim().toLowerCase();
  const matched = q
    ? entries.filter(
        (entry) =>
          entry.name.toLowerCase().includes(q) || entry.description.toLowerCase().includes(q),
      )
    : entries.slice();

  return matched
    .sort((a, b) => {
      const aPrefix = q && a.name.toLowerCase().startsWith(q) ? 0 : 1;
      const bPrefix = q && b.name.toLowerCase().startsWith(q) ? 0 : 1;
      if (aPrefix !== bPrefix) return aPrefix - bPrefix;
      // A bare `/` lists commands before skills: the built-ins are what a new
      // user needs, and a 100-skill install would otherwise bury them.
      if (!q && a.kind !== b.kind) return a.kind === "command" ? -1 : 1;
      if (a.kind === "skill" && b.kind === "skill") return (b.usage ?? 0) - (a.usage ?? 0);
      return a.name.localeCompare(b.name);
    })
    .slice(0, limit);
}

/** Normalize a `complete.slash` result's items. */
export function entriesFromCompletion(items: readonly CompletionItem[]): CommandEntry[] {
  const out: CommandEntry[] = [];
  for (const item of items) {
    const name = (item.text ?? "").replace(/^\//, "").trim();
    if (!name) continue;
    out.push({
      name,
      description: item.display || item.meta || "",
      kind: item.kind === "skill" ? "skill" : "command",
    });
  }
  return out;
}

export interface CommandsCatalog {
  pairs?: string[][];
  categories?: { name: string; pairs: string[][] }[];
  skills?: Record<string, { usage?: number; origin?: string }>;
  warning?: string;
}

/**
 * Flatten `commands.catalog` into popover entries.
 *
 * Prefers `categories` when present because it carries the same pairs with
 * grouping; falls back to the flat `pairs` list. Skills are appended last and
 * ranked by usage.
 */
export function entriesFromCatalog(catalog: CommandsCatalog): CommandEntry[] {
  const out: CommandEntry[] = [];
  const seen = new Set<string>();

  const push = (pair: string[] | undefined): void => {
    const name = (pair?.[0] ?? "").replace(/^\//, "").trim();
    if (!name || seen.has(name)) return;
    seen.add(name);
    out.push({ name, description: pair?.[1] ?? "", kind: "command" });
  };

  if (catalog.categories?.length) {
    for (const category of catalog.categories) {
      for (const pair of category.pairs ?? []) push(pair);
    }
  }
  if (!out.length) {
    for (const pair of catalog.pairs ?? []) push(pair);
  }

  for (const [name, meta] of Object.entries(catalog.skills ?? {})) {
    const clean = name.replace(/^\//, "").trim();
    if (!clean || seen.has(clean)) continue;
    seen.add(clean);
    out.push({ name: clean, description: meta?.origin === "local" ? "技能" : `技能 · ${meta?.origin ?? ""}`, kind: "skill", usage: meta?.usage ?? 0 });
  }

  return out;
}

/** Split a submitted line into the command name and its raw argument. */
export function parseCommandInput(text: string): { name: string; arg: string } | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return null;
  const body = trimmed.slice(1);
  const match = /^([\w:.-]+)\s*([\s\S]*)$/.exec(body);
  if (!match) return null;
  return { name: match[1] ?? "", arg: (match[2] ?? "").trim() };
}

export type DispatchType = "exec" | "alias" | "plugin" | "send" | "skill" | "prefill";

export interface DispatchResult {
  type: DispatchType;
  output?: string;
  target?: string;
  message?: string;
  notice?: string;
  display?: string;
  name?: string;
  status?: string;
}

/** Validate a `command.dispatch` reply; unknown shapes are rejected rather than guessed at. */
export function parseDispatch(raw: unknown): DispatchResult | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const row = raw as Record<string, unknown>;
  const str = (v: unknown): string => (typeof v === "string" ? v : "");
  switch (row.type) {
    case "alias":
      return typeof row.target === "string" ? { type: "alias", target: row.target } : null;
    case "exec":
    case "plugin":
      return { type: row.type, output: str(row.output) };
    case "prefill":
      return typeof row.message === "string"
        ? { type: "prefill", message: row.message, notice: str(row.notice) }
        : null;
    case "send":
      return typeof row.message === "string"
        ? { type: "send", message: row.message, display: str(row.display), notice: str(row.notice) }
        : null;
    case "skill":
      return typeof row.name === "string"
        ? { type: "skill", name: row.name, message: str(row.message), display: str(row.display) }
        : null;
    default:
      return null;
  }
}

/** The nine levels the backend accepts for `config.set key=reasoning`. */
export const REASONING_LEVELS = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
] as const;

export type ReasoningLevel = (typeof REASONING_LEVELS)[number];

/** `none` is the "off" sentinel, not a level — it is valid as a value but not ranked. */
export const REASONING_VALUES = ["none", ...REASONING_LEVELS] as const;

export function isReasoningLevel(value: string): value is ReasoningLevel {
  return (REASONING_LEVELS as readonly string[]).includes(value);
}

// The labels moved to `core/i18n.ts` when the page became bilingual; this file
// stays protocol-only (the legal values and their ranking).
