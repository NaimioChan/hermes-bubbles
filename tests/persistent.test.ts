import { describe, expect, it, vi } from "vitest";

import { createControllerHolder } from "../src/app/persistent";

function makeHolder() {
  const dispose = vi.fn();
  let built = 0;
  const holder = createControllerHolder(() => {
    built += 1;
    return { dispose };
  });
  return { holder, dispose, built: () => built };
}

describe("persistent controller", () => {
  it("builds the controller once and reuses it", () => {
    const { holder, built } = makeHolder();
    const a = holder.acquire();
    const b = holder.acquire();
    expect(a).toBe(b);
    expect(built()).toBe(1);
  });

  it("does NOT dispose on release — that is what kept closing the sessions", () => {
    const { holder, dispose } = makeHolder();
    holder.acquire();
    holder.release();
    expect(dispose).not.toHaveBeenCalled();
    expect(holder.peek()).not.toBeNull();
  });

  it("survives a full unmount/remount cycle with the same instance", () => {
    // The dashboard's route change: unmount (release) then mount (acquire).
    const { holder, dispose, built } = makeHolder();
    const first = holder.acquire();
    holder.release();              // navigate away
    const second = holder.acquire(); // navigate back
    expect(second).toBe(first);
    expect(built()).toBe(1);
    expect(dispose).not.toHaveBeenCalled();
  });

  it("stays alive across many route changes", () => {
    const { holder, dispose } = makeHolder();
    for (let i = 0; i < 20; i += 1) {
      holder.acquire();
      holder.release();
    }
    expect(dispose).not.toHaveBeenCalled();
  });

  it("reuses one instance under StrictMode's double mount", () => {
    // mount → unmount → mount, the development-only sequence that would
    // otherwise open two sockets.
    const { holder, built } = makeHolder();
    holder.acquire();
    holder.release();
    holder.acquire();
    expect(built()).toBe(1);
    expect(holder.refCount()).toBe(1);
  });

  it("tracks the reference count without going negative", () => {
    const { holder } = makeHolder();
    expect(holder.release()).toBe(0);
    expect(holder.release()).toBe(0);
    holder.acquire();
    expect(holder.refCount()).toBe(1);
  });

  it("disposes only when explicitly reset", () => {
    const { holder, dispose } = makeHolder();
    holder.acquire();
    holder.reset();
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(holder.peek()).toBeNull();
    // A later mount builds a fresh one.
    holder.acquire();
    expect(holder.peek()).not.toBeNull();
  });

  it("peek does not create an instance", () => {
    const { holder, built } = makeHolder();
    expect(holder.peek()).toBeNull();
    expect(built()).toBe(0);
  });
});
