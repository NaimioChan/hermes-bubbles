import { describe, expect, it } from "vitest";

import { fenceQuery, isFenceRefusal, mutationFence, newRequestId } from "../src/core/mutation";

/**
 * hermes-agent 0.22.5 fences `PATCH` / `DELETE /api/sessions/{id}` behind a
 * receipt: a request with neither `request_id` nor `expected_revision` is answered
 * `409 client_upgrade_required`. Rename and delete in this plugin sent neither, so
 * both were refused against a current backend — silently, because the wording of
 * the refusal reads as "update your app".
 */

describe("mutation fence", () => {
  it("sends the revision and a fresh request id", () => {
    const fence = mutationFence({ runtime_revision: 3, runtime_generation: 1 }, "req-1");
    expect(fence).toEqual({ request_id: "req-1", expected_revision: 3, expected_generation: 1 });
  });

  it("omits a generation the backend did not report", () => {
    // A snapshot for a row the store cannot see answers `runtime_generation: null`
    // — that means "do not send it", not "send null".
    expect(mutationFence({ runtime_revision: 0, runtime_generation: null }, "req-1")).toEqual({
      request_id: "req-1",
      expected_revision: 0,
    });
    expect(mutationFence({ runtime_revision: 0 }, "req-1")).not.toHaveProperty("expected_generation");
  });

  it("sends nothing when the backend has no snapshot to offer", () => {
    // Older hermes-agent: no receipt, so no fence. A guessed revision would be
    // worse than none — it would be refused as stale.
    expect(mutationFence(null, "req-1")).toBeNull();
    expect(mutationFence({}, "req-1")).toBeNull();
    expect(mutationFence({ runtime_revision: null }, "req-1")).toBeNull();
    expect(mutationFence({ runtime_revision: -1 }, "req-1")).toBeNull();
  });

  it("keys DELETE's query string", () => {
    const query = fenceQuery({ request_id: "a b", expected_revision: 2, expected_generation: 0 });
    const params = new URLSearchParams(query);
    expect(params.get("request_id")).toBe("a b");
    expect(params.get("expected_revision")).toBe("2");
    expect(params.get("expected_generation")).toBe("0");

    // No generation reported ⇒ no param, rather than `expected_generation=null`
    // (which the backend reads as StrictInt and refuses outright).
    const bare = new URLSearchParams(fenceQuery({ request_id: "r", expected_revision: 0 }));
    expect(bare.has("expected_generation")).toBe(false);
  });

  it("mints a different request id every time", () => {
    // A reused id replays the FIRST receipt, so a genuine second delete would look
    // like a no-op. Distinct ids are what keeps replay and repetition apart.
    const ids = new Set(Array.from({ length: 50 }, () => newRequestId()));
    expect(ids.size).toBe(50);
    expect(newRequestId("clean")).toMatch(/^clean-/);
  });

  it("recognises the fence refusal in a thrown message", () => {
    expect(
      isFenceRefusal(
        new Error(
          'client_upgrade_required: this app is out of sync (different versions) with the Hermes backend; update the app to edit sessions',
        ),
      ),
    ).toBe(true);
    expect(isFenceRefusal(new Error("mutation_identity_required"))).toBe(true);
    expect(isFenceRefusal(new Error("not_found"))).toBe(false);
    expect(isFenceRefusal("session_busy")).toBe(false);
    expect(isFenceRefusal(new Error(""))).toBe(false);
  });
});
