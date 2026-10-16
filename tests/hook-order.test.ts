import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Source-level guard for a bug class that unit tests cannot see.
 *
 * The plugin's components call hooks through `sdk.hooks.*` / `React.use*`. React
 * requires every hook in a component to run on every render, so a hook placed
 * *after* an early `return` changes the hook count between renders and throws
 * React #310 — which blanks the whole page.
 *
 * That is invisible to logic tests (they never render) and invisible to
 * typecheck (the order is legal TypeScript); it only fires at runtime when a
 * component goes from the "early return" branch to the other one. A turn with no
 * reasoning followed by one with reasoning did exactly that.
 *
 * This test reads the source and fails when a hook call sits after an early
 * `return` in the same block, tracking brace depth so a `return` inside a nested
 * arrow callback is not mistaken for one.
 */

const UI_DIR = join(__dirname, "..", "src", "ui");

const HOOK_CALL = /(?:\bsdk\.hooks\.|(?<![\w.])React\.use[A-Z]|\buse[A-Z]\w*\s*\()/;
const RETURN_STMT = /(?:^|[;{}\s])return(?:\s|;)/;

interface Line {
  /** Brace depth at the START of the line. */
  depth: number;
  text: string;
  /** The line with comments and string bodies blanked out. */
  code: string;
  hasReturn: boolean;
  hasHook: boolean;
}

/**
 * Per-line brace depth plus a comment/string-stripped copy of the line.
 *
 * Stripping matters for correctness, not tidiness: a comment containing the word
 * "return" (this file's own explanatory comments do) otherwise reads as an early
 * return and the guard reports violations that do not exist.
 */
function scanLines(source: string): Line[] {
  const out: Line[] = [];
  let depth = 0;
  let inBlockComment = false;

  for (const line of source.split(/\r?\n/)) {
    let code = "";
    let inSingle = false;
    let inDouble = false;
    let inTemplate = false;
    let i = 0;

    while (i < line.length) {
      const ch = line[i] as string;
      const next = line[i + 1];

      if (inBlockComment) {
        if (ch === "*" && next === "/") {
          inBlockComment = false;
          i += 2;
          continue;
        }
        i += 1;
        continue;
      }
      if (!inSingle && !inDouble && !inTemplate) {
        if (ch === "/" && next === "/") break; // rest of line is a comment
        if (ch === "/" && next === "*") {
          inBlockComment = true;
          i += 2;
          continue;
        }
        if (ch === "{") depth += 1;
        else if (ch === "}") depth -= 1;
      }
      if (ch === "\\") {
        i += 2;
        continue;
      }
      if (ch === "'" && !inDouble && !inTemplate) inSingle = !inSingle;
      else if (ch === '"' && !inSingle && !inTemplate) inDouble = !inDouble;
      else if (ch === "`" && !inSingle && !inDouble) inTemplate = !inTemplate;

      // Keep the character unless it is inside a string body.
      if (!inSingle && !inDouble && !inTemplate) code += ch;
      i += 1;
    }

    out.push({
      depth,
      text: line,
      code,
      hasReturn: RETURN_STMT.test(code),
      hasHook: HOOK_CALL.test(code),
    });
  }
  return out;
}

interface Offence {
  line: number;
  text: string;
}

/** A line that opens a new function body: `function f(...) {`, `const x = (...) => {`. */
function opensFunctionBody(text: string): boolean {
  if (!/\{\s*$/.test(text.trim())) return false;
  return /\bfunction\b/.test(text) || /=>\s*\{\s*$/.test(text);
}

/**
 * A hook is misplaced when a `return` was seen earlier in the SAME function body.
 *
 * Scoped per function rather than per brace depth: sibling components in one file
 * share a depth, so a depth-only walk-back would cross from one component into
 * the previous one's `return`.
 *
 * Depths are read AFTER a line's braces, so the opener and its body lines share
 * a depth: the scope is recorded at that depth and the closing `}` (one lower)
 * pops it. Sibling callbacks at the same depth therefore stay independent.
 */
export function findOffences(source: string): Offence[] {
  const lines = scanLines(source);
  const offences: Offence[] = [];
  /** Body depth of each open function, with whether it has already returned. */
  const scopes: { depth: number; returned: boolean }[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line) continue;

    // Leave every scope whose body this line has exited.
    while (scopes.length && line.depth < (scopes.at(-1)?.depth ?? -1)) scopes.pop();

    const scope = scopes.at(-1);
    if (scope && line.hasHook && scope.returned) {
      offences.push({ line: i + 1, text: line.text.trim() });
    }
    if (scope && line.hasReturn) scope.returned = true;

    if (opensFunctionBody(line.text)) scopes.push({ depth: line.depth, returned: false });
  }

  return offences;
}

describe("hook ordering in UI components", () => {
  const files = readdirSync(UI_DIR).filter((name) => name.endsWith(".ts"));

  it("finds the component files to scan", () => {
    expect(files.length).toBeGreaterThan(3);
  });

  it("never calls a hook after an early return", () => {
    const offences: string[] = [];
    for (const name of files) {
      for (const offence of findOffences(readFileSync(join(UI_DIR, name), "utf8"))) {
        offences.push(`${name}:${offence.line} ${offence.text}`);
      }
    }
    expect(offences).toEqual([]);
  });

  it("detects a planted violation, so the guard cannot silently match nothing", () => {
    const bad = [
      "function C({ x }) {",
      "  const [a] = useState(0);",
      "  if (!x) return null;",
      "  const b = useMemo(() => x, [x]);",
      "  return b;",
      "}",
    ].join("\n");
    expect(findOffences(bad)).toHaveLength(1);
  });

  it("does not flag a return inside a nested callback", () => {
    const fine = [
      "function C({ x }) {",
      "  const cb = useCallback(() => {",
      "    if (!x) return null;",
      "    return x;",
      "  }, [x]);",
      "  const later = useMemo(() => x, [x]);",
      "  return later;",
      "}",
    ].join("\n");
    expect(findOffences(fine)).toEqual([]);
  });

  it("does not flag hooks that all precede the return", () => {
    const fine = [
      "function C({ x }) {",
      "  const [a] = useState(0);",
      "  const b = useMemo(() => x, [x]);",
      "  if (!x) return null;",
      "  return b;",
      "}",
    ].join("\n");
    expect(findOffences(fine)).toEqual([]);
  });
});
