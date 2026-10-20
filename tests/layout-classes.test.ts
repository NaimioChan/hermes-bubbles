import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Guard against silently-dead utility classes.
 *
 * The plugin renders inside the dashboard's PREcompiled Tailwind bundle, which
 * only contains the classes the dashboard's own source happened to use. A class
 * we invent that it lacks applies NOTHING — no error, no warning. That shipped
 * three visible bugs at once:
 *
 *   `resize-none`      → the composer kept its native grip
 *   `max-h-[70vh]`     → the model picker had no height cap
 *   `text-[0.625rem]`  → the usage line rendered at the full 15px base
 *
 * The invariant is NOT "no arbitrary values" — measured on 0.22.2, the host CSS
 * does contain `text-[0.6875rem]`, `tracking-[0.06em]`, `w-[0.5em]` and
 * `max-h-48`, and they resolve. What matters is whether each class actually
 * exists, whichever syntax it uses. So this test checks membership against the
 * real compiled CSS (falling back to a recorded allowlist when the dashboard is
 * not installed, which happens on a fresh clone / CI).
 *
 * When this fails, either use a class the host has, or define an `hb-` class in
 * `src/ui/style.css`. `node scripts/audit-classes.mjs` prints the full report.
 */

const UI_DIR = join(__dirname, "..", "src", "ui");

/**
 * Classes measured present in hermes-agent 0.22.2's compiled bundle. Used only
 * when that bundle is not on disk, so the guard still runs on a fresh clone.
 */
const KNOWN_HOST_CLASSES = new Set([
  "flex", "inline-flex", "grid", "block",
  "flex-col", "flex-wrap", "items-center", "items-start", "items-end", "items-baseline", "items-stretch",
  "justify-center", "gap-0", "gap-0.5", "gap-1", "gap-1.5", "gap-2", "gap-2.5", "gap-3",
  "flex-1", "shrink-0", "min-w-0", "h-full", "w-full", "max-h-48", "max-h-64",
  "overflow-hidden", "overflow-x-auto", "overflow-y-auto", "relative", "absolute", "fixed", "inset-0",
  "mx-auto", "px-1", "px-1.5", "px-2", "px-2.5", "px-3", "px-4", "py-0.5", "py-1", "py-1.5", "py-2", "py-3", "py-4", "py-16",
  "mb-1", "mb-1.5", "mb-2", "mt-1", "mt-2", "ml-auto", "mr-1", "p-2", "p-3", "p-8", "space-y-0.5", "space-y-1.5", "space-y-2",
  "text-left", "text-center", "text-xs", "text-sm", "text-base", "font-medium", "font-mono", "tabular-nums",
  "uppercase", "leading-none", "leading-relaxed", "truncate", "break-words", "whitespace-pre-wrap",
  "cursor-pointer", "resize", "group", "hidden",
  "text-[0.6875rem]", "text-[0.8125rem]", "text-[0.5em]", "tracking-[0.06em]", "w-[0.5em]",
  "max-w-[22ch]", "opacity-0", "opacity-40", "opacity-70", "opacity-75", "opacity-80", "z-50",
]);

function hostClasses(): Set<string> | null {
  const home = process.env.HERMES_HOME
    ?? (process.platform === "win32"
      ? join(process.env.LOCALAPPDATA ?? join(process.env.USERPROFILE ?? ".", "AppData", "Local"), "hermes")
      : join(process.env.HOME ?? ".", ".hermes"));
  const assets = join(home, "hermes-agent", "hermes_cli", "web_dist", "assets");
  if (!existsSync(assets)) return null;
  const file = readdirSync(assets).find((f) => f.endsWith(".css"));
  if (!file) return null;
  const css = readFileSync(join(assets, file), "utf8");
  const names = new Set<string>();
  for (const match of css.matchAll(/\.((?:[a-z]|\\.)[\w:\\[\]/.%-]*)/g)) {
    names.add((match[1] ?? "").replace(/\\/g, ""));
  }
  return names;
}

function classNamesIn(source: string): string[] {
  const out: string[] = [];
  for (const match of source.matchAll(/className:\s*"([^"]+)"/g)) {
    out.push(...(match[1] ?? "").split(/\s+/).filter(Boolean));
  }
  return out;
}

describe("layout classes", () => {
  const files = readdirSync(UI_DIR).filter((n) => n.endsWith(".ts") && n !== "sdk.ts" && n !== "format.ts");
  const ownCss = readFileSync(join(UI_DIR, "style.css"), "utf8");
  const ownClasses = new Set([...ownCss.matchAll(/\.(hb-[a-z0-9-]+)/g)].map((m) => m[1]));
  const host = hostClasses();

  it("defines every hb- class it uses", () => {
    const offenders: string[] = [];
    for (const name of files) {
      for (const cls of classNamesIn(readFileSync(join(UI_DIR, name), "utf8"))) {
        if (cls.startsWith("hb-") && !ownClasses.has(cls)) offenders.push(`${name}: ${cls}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("uses only classes the host bundle actually contains", () => {
    const resolved = host ?? KNOWN_HOST_CLASSES;
    const offenders: string[] = [];
    for (const name of files) {
      for (const cls of classNamesIn(readFileSync(join(UI_DIR, name), "utf8"))) {
        if (cls.startsWith("hb-")) continue;
        if (!resolved.has(cls) && !KNOWN_HOST_CLASSES.has(cls)) offenders.push(`${name}: ${cls}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("never asks the composer for a native resize grip", () => {
    // The specific bug: the textarea must be resize:none or the corner grip
    // moves an edge the user did not grab.
    const composer = readFileSync(join(UI_DIR, "Composer.ts"), "utf8");
    expect(composer).toContain("hb-resize-none");
    expect(ownCss).toMatch(/\.hb-resize-none\s*\{[^}]*resize:\s*none/);
  });

  it("keeps the chat text tiers defined in one place", () => {
    expect(ownCss).toMatch(/\.hb-text-micro\s*\{[^}]*font-size:\s*0\.6875rem/);
    expect(ownCss).toMatch(/\.hb-text-tiny\s*\{[^}]*font-size:\s*0\.625rem/);
  });

  it("adapts to a phone without changing a desktop", () => {
    // The mobile layout is one `@media (max-width: 768px)` block in style.css.
    // Its two load-bearing wins are easy to lose silently: the bubbles must beat
    // their inline `max-width` (needs !important), and the touch-only action rows
    // must stop being `opacity:0` (hover never fires on a phone).
    expect(ownCss).toMatch(/@media\s*\(max-width:\s*768px\)/);
    expect(ownCss).toMatch(/\[data-hb="message-actions"\][^{]*\{[^}]*max-width:\s*100%\s*!important/);
    expect(ownCss).toMatch(/\.hb-actions,\s*\.hb-row-tools\s*\{\s*opacity:\s*1/);
    // The composer wrap relies on these two hooks existing on the row and cluster.
    const composer = readFileSync(join(UI_DIR, "Composer.ts"), "utf8");
    expect(composer).toContain("hb-composer-row");
    expect(composer).toContain("hb-composer-tools");
  });

  it("keeps thinking blocks and tool rows out of the bubble treatment", () => {
    // Both were bubbles once: reasoning rode on the assistant row (an empty card
    // per think-only segment) and every tool call was a padded card. Their
    // spacing has to come from the per-kind gap rule, not from a bubble's own
    // margin, or a run of calls breaks into paragraphs again.
    const bubble = readFileSync(join(UI_DIR, "Bubble.ts"), "utf8");
    expect(bubble).toContain("hb-think");
    expect(bubble).toContain("hb-tool");
    expect(ownCss).toMatch(/\.hb-bubble-gap\[data-hb-kind="tool"\][^{]*\{[^}]*margin-top/);
    expect(ownCss).toMatch(/\.hb-bubble-gap\[data-hb-kind="reasoning"\][^{]*\{[^}]*margin-top/);
  });
});
