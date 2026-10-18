/**
 * Live usage metrics for the status strip.
 *
 * Formats the `Usage` counters the backend reports (`docs/01-protocol-contract.md`
 * §4 用量). Pure: numbers in, display strings out.
 */

import type { Messages } from "./i18n";
import type { Usage } from "./types";

/** `1234` → `1.2k`. Matches the desktop status bar's compaction. */
export function compactNumber(value: number | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return "";
  if (value < 1000) return String(Math.round(value));
  if (value < 10_000) return `${(value / 1000).toFixed(1)}k`;
  if (value < 1_000_000) return `${Math.round(value / 1000)}k`;
  return `${(value / 1_000_000).toFixed(1)}M`;
}

/** `12.3k/200k`; `~` prefix when the backend estimated rather than measured. */
export function contextLabel(usage: Usage | null): string {
  if (!usage) return "";
  if (usage.context_max) {
    const used = compactNumber(usage.context_used ?? 0);
    const max = compactNumber(usage.context_max);
    return `${usage.context_estimated ? "~" : ""}${used}/${max}`;
  }
  return usage.total && usage.total > 0 ? `${compactNumber(usage.total)} tok` : "";
}

/** A ten-cell bar, e.g. `▓▓░░░░░░░░`. Empty when there is no context budget. */
export function contextBar(percent: number | undefined, cells = 10): string {
  if (typeof percent !== "number" || !Number.isFinite(percent)) return "";
  const clamped = Math.max(0, Math.min(100, percent));
  const filled = Math.round((clamped / 100) * cells);
  return "▓".repeat(filled) + "░".repeat(Math.max(0, cells - filled));
}

/** `[▓▓░░░░░░░░] 6%`. */
export function contextBarLabel(usage: Usage | null): string {
  if (!usage?.context_max) return "";
  const pct = Math.max(0, Math.min(100, Math.round(usage.context_percent ?? 0)));
  return `[${contextBar(usage.context_percent)}] ${usage.context_estimated ? "~" : ""}${pct}%`;
}

/** `87%`, or empty when the provider reports no cache reads. */
export function cacheHitLabel(usage: Usage | null): string {
  const pct = usage?.cache_hit_pct;
  return typeof pct === "number" && Number.isFinite(pct) ? `${Math.round(pct)}%` : "";
}

/** `42 t/s`, or empty before the first completed call. */
export function tokensPerSecondLabel(usage: Usage | null): string {
  const tps = usage?.avg_tps;
  return typeof tps === "number" && Number.isFinite(tps) && tps > 0 ? `${Math.round(tps)} t/s` : "";
}

/** `$0.0123`, or empty when cost is unknown. */
export function costLabel(usage: Usage | null): string {
  const cost = usage?.cost_usd;
  if (typeof cost !== "number" || !Number.isFinite(cost)) return "";
  if (cost === 0) return "$0";
  // Sub-dollar amounts keep four decimals: a chat session routinely costs
  // fractions of a cent, and "$0.01" for every early turn is useless feedback.
  if (cost < 1) return `$${cost.toFixed(4)}`;
  return `$${cost.toFixed(2)}`;
}

/** `↑1.2k ↓340` — the token split, for the detail popover. */
export function ioLabel(usage: Usage | null): string {
  if (!usage) return "";
  const input = compactNumber(usage.input);
  const output = compactNumber(usage.output);
  if (!input && !output) return "";
  return `↑${input || "0"} ↓${output || "0"}`;
}

export interface MetricChip {
  key: string;
  label: string;
  /** Shown on hover. */
  title: string;
}

/**
 * The chips to show, in order. Only non-empty ones are returned, so the strip
 * collapses to nothing on a fresh session instead of showing placeholder dashes.
 */
export function metricChips(usage: Usage | null, t: Messages): MetricChip[] {
  if (!usage) return [];
  const chips: MetricChip[] = [];

  const ctx = contextBarLabel(usage);
  if (ctx) chips.push({ key: "context", label: ctx, title: t.metricContextTitle(contextLabel(usage)) });

  const cache = cacheHitLabel(usage);
  if (cache) chips.push({ key: "cache", label: `⚡${cache}`, title: t.metricCacheTitle });

  const tps = tokensPerSecondLabel(usage);
  if (tps) chips.push({ key: "tps", label: tps, title: t.metricTpsTitle });

  const cost = costLabel(usage);
  if (cost) chips.push({ key: "cost", label: cost, title: t.metricCostTitle });

  return chips;
}

/**
 * Percentage of the context window used, clamped — drives the warning color.
 * Returns null when the backend reported no budget.
 */
export function contextPressure(usage: Usage | null): number | null {
  if (!usage?.context_max) return null;
  const pct = usage.context_percent;
  if (typeof pct !== "number" || !Number.isFinite(pct)) return null;
  return Math.max(0, Math.min(100, pct));
}

export type PressureTone = "calm" | "warn" | "critical";

/** Where the context bar turns amber, then red. */
export function pressureTone(percent: number | null): PressureTone {
  if (percent === null) return "calm";
  if (percent >= 90) return "critical";
  if (percent >= 70) return "warn";
  return "calm";
}
