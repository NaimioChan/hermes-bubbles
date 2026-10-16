import { describe, expect, it } from "vitest";

import { EventDedupe } from "../src/core/dedupe";

describe("EventDedupe", () => {
  it("admits the first sighting and rejects the fan-out copy", () => {
    const gate = new EventDedupe();
    gate.setEpoch("epoch-a");
    const frame = { session_id: "s1", seq: 7, replayEpoch: "epoch-a" };
    expect(gate.admit(frame)).toBe(true);
    expect(gate.admit(frame)).toBe(false);
  });

  it("keeps per-session counters independent", () => {
    const gate = new EventDedupe();
    gate.setEpoch("e");
    expect(gate.admit({ session_id: "s1", seq: 1 })).toBe(true);
    expect(gate.admit({ session_id: "s2", seq: 1 })).toBe(true);
    expect(gate.admit({ session_id: "s1", seq: 1 })).toBe(false);
  });

  it("admits frames with no seq or session (global broadcasts have no ordering contract)", () => {
    const gate = new EventDedupe();
    gate.setEpoch("e");
    expect(gate.admit({})).toBe(true);
    expect(gate.admit({})).toBe(true);
    expect(gate.admit({ session_id: "s1" })).toBe(true);
    expect(gate.admit({ seq: 3 })).toBe(true);
  });

  it("forgets every watermark when the backend epoch changes", () => {
    const gate = new EventDedupe();
    gate.setEpoch("epoch-a");
    expect(gate.admit({ session_id: "s1", seq: 5 })).toBe(true);
    // A restart resets seq to 1; without the epoch reset the new process's
    // frames would look like replays of the old one.
    gate.setEpoch("epoch-b");
    expect(gate.admit({ session_id: "s1", seq: 5 })).toBe(true);
  });

  it("does not clear on a repeated epoch", () => {
    const gate = new EventDedupe();
    gate.setEpoch("epoch-a");
    gate.admit({ session_id: "s1", seq: 5 });
    gate.setEpoch("epoch-a");
    expect(gate.admit({ session_id: "s1", seq: 5 })).toBe(false);
  });

  it("treats a non-finite seq as unordered", () => {
    const gate = new EventDedupe();
    gate.setEpoch("e");
    expect(gate.admit({ session_id: "s1", seq: Number.NaN })).toBe(true);
    expect(gate.admit({ session_id: "s1", seq: Number.NaN })).toBe(true);
  });

  it("bounds the sessions it remembers", () => {
    const gate = new EventDedupe();
    gate.setEpoch("e");
    for (let i = 0; i < 200; i += 1) {
      expect(gate.admit({ session_id: `s${i}`, seq: 1 })).toBe(true);
    }
    // The oldest sessions were evicted, so their frames are admitted again
    // rather than leaking memory forever.
    expect(gate.admit({ session_id: "s0", seq: 1 })).toBe(true);
    // The most recent ones are still remembered.
    expect(gate.admit({ session_id: "s199", seq: 1 })).toBe(false);
  });
});
