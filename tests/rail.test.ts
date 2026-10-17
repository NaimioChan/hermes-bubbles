import { describe, expect, it } from "vitest";

import { nearestTick, railTicks, visibleTicks } from "../src/core/rail";

const user = (id: string, text = "") => ({ kind: "user", id, text });
const assistant = (id: string) => ({ kind: "assistant", id, text: "reply" });

describe("rail ticks", () => {
  it("makes one tick per user message and ignores replies", () => {
    const ticks = railTicks([user("u1"), assistant("a1"), user("u2"), assistant("a2")]);
    expect(ticks.map((t) => t.itemId)).toEqual(["u1", "u2"]);
  });

  it("returns nothing for a transcript with no user messages", () => {
    expect(railTicks([])).toEqual([]);
    expect(railTicks([assistant("a1")])).toEqual([]);
  });

  it("spreads ticks over the rail, first near the top and last near the bottom", () => {
    const ticks = railTicks([user("u1"), user("u2"), user("u3")]);
    expect(ticks[0]!.position).toBeCloseTo(0.02, 5);
    expect(ticks[2]!.position).toBeCloseTo(0.98, 5);
    // Evenly spaced, not bunched.
    expect(ticks[1]!.position).toBeGreaterThan(ticks[0]!.position);
    expect(ticks[1]!.position).toBeLessThan(ticks[2]!.position);
  });

  it("centres a single tick instead of pinning it to an edge", () => {
    const [tick] = railTicks([user("only")]);
    expect(tick!.position).toBeCloseTo(0.5, 5);
  });

  it("stays inside the rail for a long transcript", () => {
    const many = Array.from({ length: 300 }, (_, i) => user(`u${i}`));
    const ticks = railTicks(many);
    expect(ticks).toHaveLength(300);
    expect(Math.min(...ticks.map((t) => t.position))).toBeGreaterThanOrEqual(0);
    expect(Math.max(...ticks.map((t) => t.position))).toBeLessThanOrEqual(1);
  });

  it("labels a tick from the message, flattening whitespace", () => {
    const [tick] = railTicks([user("u1", "  第一行\n\n第二行  ")]);
    expect(tick!.label).toBe("第一行 第二行");
  });

  it("truncates a long label rather than overflowing the tooltip", () => {
    const [tick] = railTicks([user("u1", "x".repeat(200))]);
    expect(tick!.label.length).toBeLessThanOrEqual(48);
    expect(tick!.label.endsWith("…")).toBe(true);
  });

  it("labels an empty message without producing 'undefined'", () => {
    const [tick] = railTicks([user("u1")]);
    expect(tick!.label).toBe("");
  });
});

describe("nearest tick", () => {
  const ticks = railTicks([user("u1"), user("u2"), user("u3")]);

  it("finds the tick closest to a pointer ratio", () => {
    expect(nearestTick(ticks, 0.0)).toBe(0);
    expect(nearestTick(ticks, 0.5)).toBe(1);
    expect(nearestTick(ticks, 1.0)).toBe(2);
  });

  it("returns -1 for an empty rail", () => {
    expect(nearestTick([], 0.5)).toBe(-1);
  });
});

describe("visible ticks", () => {
  it("returns every tick when the rail is short enough", () => {
    const ticks = railTicks(Array.from({ length: 20 }, (_, i) => user(`u${i}`)));
    expect(visibleTicks(ticks)).toHaveLength(20);
  });

  it("samples down to the cap for a very long session, keeping the newest", () => {
    const ticks = railTicks(Array.from({ length: 400 }, (_, i) => user(`u${i}`)));
    const shown = visibleTicks(ticks, 100);
    expect(shown.length).toBeLessThanOrEqual(101);
    expect(shown.length).toBeGreaterThan(50);
    // The last message must always be reachable.
    expect(shown.at(-1)!.itemId).toBe("u399");
  });

  it("never returns duplicates", () => {
    const ticks = railTicks(Array.from({ length: 500 }, (_, i) => user(`u${i}`)));
    const shown = visibleTicks(ticks, 60);
    expect(new Set(shown.map((t) => t.itemId)).size).toBe(shown.length);
  });
});
