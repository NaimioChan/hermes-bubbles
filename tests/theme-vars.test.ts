import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Guard against undefined CSS custom properties.
 *
 * `var(--missing)` is worse than a broken value: with no fallback the whole
 * declaration is dropped at computed-value time and the element silently
 * inherits or shows through. Two shipped that way —
 *
 *   --color-foreground   → never defined by the host (23 --color-* vars exist,
 *                          this is not one); foreground text silently fell back
 *                          to the inherited color
 *   --color-background   → never defined either; code blocks and the approval
 *                          card resolved to TRANSPARENT, so they had no surface
 *
 * The host owns the variable set and it moves between versions, so the check is
 * against the real compiled CSS with a recorded allowlist as the offline
 * fallback — same shape as `layout-classes.test.ts`.
 */

const UI_DIR = join(__dirname, "..", "src", "ui");

/** Variables measured present in hermes-agent 0.22.2's compiled bundle. */
const KNOWN_HOST_VARS = new Set([
  "--color-accent", "--color-accent-foreground", "--color-black", "--color-border",
  "--color-card", "--color-card-foreground", "--color-destructive",
  "--color-destructive-foreground", "--color-input", "--color-midground",
  "--color-muted", "--color-muted-foreground", "--color-popover",
  "--color-popover-foreground", "--color-primary", "--color-primary-foreground",
  "--color-ring", "--color-secondary", "--color-secondary-foreground",
  "--color-success", "--color-text-secondary", "--color-warning", "--color-white",
  "--radius", "--font-sans", "--font-mono", "--spacing-mul", "--font-size-base",
]);

function hostVars(): Set<string> | null {
  const home = process.env.HERMES_HOME
    ?? (process.platform === "win32"
      ? join(process.env.LOCALAPPDATA ?? join(process.env.USERPROFILE ?? ".", "AppData", "Local"), "hermes")
      : join(process.env.HOME ?? ".", ".hermes"));
  const assets = join(home, "hermes-agent", "hermes_cli", "web_dist", "assets");
  if (!existsSync(assets)) return null;
  const file = readdirSync(assets).find((f) => f.endsWith(".css"));
  if (!file) return null;
  const css = readFileSync(join(assets, file), "utf8");
  return new Set([...css.matchAll(/(--[a-z][a-z0-9-]*)\s*:/g)].map((m) => m[1] as string));
}

/** Every `var(--x)` reference in a source string, with whether it has a fallback. */
function varRefs(source: string): { name: string; hasFallback: boolean }[] {
  const out: { name: string; hasFallback: boolean }[] = [];
  for (const match of source.matchAll(/var\(\s*(--[a-z0-9-]+)\s*(,)?/g)) {
    out.push({ name: match[1] as string, hasFallback: Boolean(match[2]) });
  }
  return out;
}

describe("theme variables", () => {
  const files = [
    ...readdirSync(UI_DIR).filter((n) => n.endsWith(".ts")).map((n) => join(UI_DIR, n)),
    join(UI_DIR, "style.css"),
  ];
  const host = hostVars();

  it("only references variables the host defines, or supplies a fallback", () => {
    const resolved = host ?? KNOWN_HOST_VARS;
    const offenders: string[] = [];
    for (const file of files) {
      const name = file.split(/[\\/]/).pop();
      for (const ref of varRefs(readFileSync(file, "utf8"))) {
        if (ref.hasFallback) continue;
        if (resolved.has(ref.name) || KNOWN_HOST_VARS.has(ref.name)) continue;
        offenders.push(`${name}: ${ref.name}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("does not use the two variables the host never defines", () => {
    // Named explicitly because they are the ones that shipped broken: they read
    // as valid tokens and fail silently, so a bare use is always a bug.
    const banned = /\bvar\(\s*--color-(foreground|background)\s*\)/;
    const offenders: string[] = [];
    for (const file of files) {
      if (banned.test(readFileSync(file, "utf8"))) offenders.push(file.split(/[\\/]/).pop() as string);
    }
    expect(offenders).toEqual([]);
  });

  it("guards the scanner itself", () => {
    expect(varRefs("var(--color-card)").map((r) => r.hasFallback)).toEqual([false]);
    expect(varRefs("var(--color-card, red)").map((r) => r.hasFallback)).toEqual([true]);
    expect(varRefs("var(--a) var(--b, c)")).toHaveLength(2);
  });
});
