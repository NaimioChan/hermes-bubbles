/**
 * The locator rail: a column of ticks beside the transcript, one per user
 * message, for jumping back to something you said earlier.
 *
 * This is the placement arithmetic only — pure, so the interesting part (how a
 * 300-message session maps onto a 600px rail, and what happens when two ticks
 * would land on the same pixel) can be tested without a DOM.
 *
 * The model is deliberately index-based rather than time-based: what a user is
 * looking for is "that thing I said a dozen messages ago", and even spacing
 * makes that targetable. Proportional-to-scroll-height would bunch every tick in
 * a long session into a few pixels.
 */

export interface RailTick {
  /** The timeline item this tick points at. */
  itemId: string;
  /** Position down the rail, 0 (top) .. 1 (bottom). */
  position: number;
  /** Short label for the tooltip: the message's own opening words. */
  label: string;
}

/** How much of a message to show in a tick's tooltip. */
const LABEL_CHARS = 48;

/**
 * Build the ticks for a transcript.
 *
 * `top`/`bottom` are the rail's usable ends as fractions, so the first and last
 * ticks are not flush against the edge of the container (a tick at 0 is partly
 * invisible and hard to hit).
 */
export function railTicks(
  items: readonly { readonly kind: string; readonly id: string; readonly text?: string }[],
  top = 0.02,
  bottom = 0.98,
): RailTick[] {
  const users = items.filter((item) => item.kind === "user");
  if (!users.length) return [];

  const span = Math.max(0, bottom - top);
  return users.map((item, index) => {
    // A single message sits in the middle rather than at the very top.
    const position = users.length === 1 ? top + span / 2 : top + (span * index) / (users.length - 1);
    return {
      itemId: item.id,
      position,
      label: summarise(item.text ?? ""),
    };
  });
}

function summarise(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= LABEL_CHARS) return flat;
  return `${flat.slice(0, LABEL_CHARS - 1)}…`;
}

/**
 * The tick nearest a pointer position, as an index into `ticks`.
 *
 * Used for the hover readout, so a rail with 200 ticks still tells you which
 * message you are about to jump to.
 */
export function nearestTick(ticks: readonly RailTick[], ratio: number): number {
  if (!ticks.length) return -1;
  let best = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let i = 0; i < ticks.length; i += 1) {
    const distance = Math.abs((ticks[i]?.position ?? 0) - ratio);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = i;
    }
  }
  return best;
}

/**
 * Which ticks to actually paint when the rail is short.
 *
 * A 400-message session on a 500px rail produces sub-pixel spacing, which reads
 * as a solid line rather than as a set of markers. Above this density the rail
 * paints a representative sample and relies on `nearestTick` for precision.
 */
export const RAIL_MAX_TICKS = 120;

export function visibleTicks(ticks: readonly RailTick[], max = RAIL_MAX_TICKS): RailTick[] {
  if (ticks.length <= max) return [...ticks];
  const out: RailTick[] = [];
  const seen = new Set<number>();
  for (let i = 0; i < max; i += 1) {
    const index = Math.round((i * (ticks.length - 1)) / (max - 1));
    if (seen.has(index)) continue;
    seen.add(index);
    const tick = ticks[index];
    if (tick) out.push(tick);
  }
  // Always keep the newest message reachable.
  const last = ticks[ticks.length - 1];
  if (last && out[out.length - 1]?.itemId !== last.itemId) out.push(last);
  return out;
}
