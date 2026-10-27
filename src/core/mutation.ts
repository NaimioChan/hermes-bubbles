/**
 * Write fencing for `PATCH` / `DELETE /api/sessions/{id}`.
 *
 * hermes-agent 0.22.5 put an optimistic-concurrency receipt in front of session
 * mutations: a body with neither `request_id` nor `expected_revision` is answered
 * `409 client_upgrade_required` — deliberately worded so an old app shows its
 * "update the app" toast. Every rename and delete in this plugin therefore failed
 * silently against a current backend until the fence was sent.
 *
 * The fence has three parts and the backend reads each one strictly:
 *
 *   `request_id`          a fresh idempotency key per user action. Reusing one
 *                         replays the FIRST receipt, so a genuine second delete
 *                         would look like a no-op.
 *   `expected_revision`   the row's `runtime_revision` — the optimistic lock. A
 *                         stale value is a refusal, not a silent overwrite.
 *   `expected_generation` the store generation, when the snapshot reports one.
 *                         Omitting it is allowed; sending a wrong one is not.
 *
 * Both values come from `GET /api/sessions/{id}/mutation-snapshot`, which answers
 * `runtime_generation: null` for a row it cannot see — that null means "do not
 * send it", not "send null".
 *
 * Pure data (AGENTS.md 铁律 1): the controller does the HTTP.
 */

export interface MutationSnapshot {
  session_id?: string;
  exists?: boolean;
  runtime_revision?: number | null;
  runtime_generation?: number | null;
}

export interface MutationFence {
  request_id: string;
  expected_revision: number;
  expected_generation?: number;
}

/** A fresh idempotency key. `prefix` is only for reading logs. */
export function newRequestId(prefix = "hb", now = Date.now(), random = Math.random()): string {
  return `${prefix}-${now.toString(36)}-${Math.floor(random * 0x100000000).toString(36)}`;
}

/**
 * Build the fence from a snapshot.
 *
 * `null` means "this backend does not have the receipt yet" (an older
 * hermes-agent, or a 404 on the snapshot route): send nothing, and the request
 * goes through the way it used to. Sending a guessed revision against a backend
 * that checks it would be worse than sending none — it would be refused.
 */
export function mutationFence(snapshot: MutationSnapshot | null, requestId: string): MutationFence | null {
  if (!snapshot) return null;
  const revision = snapshot.runtime_revision;
  if (typeof revision !== "number" || !Number.isFinite(revision) || revision < 0) return null;
  const generation = snapshot.runtime_generation;
  return {
    request_id: requestId,
    expected_revision: revision,
    ...(typeof generation === "number" && Number.isFinite(generation) && generation >= 0
      ? { expected_generation: generation }
      : {}),
  };
}

/**
 * The fence as a query string. DELETE carries it in the query (there is no body
 * on a DELETE that the backend reads); PATCH carries the same fields in its body.
 */
export function fenceQuery(fence: MutationFence): string {
  const params = new URLSearchParams({
    request_id: fence.request_id,
    expected_revision: String(fence.expected_revision),
  });
  if (fence.expected_generation !== undefined) {
    params.set("expected_generation", String(fence.expected_generation));
  }
  return params.toString();
}

/**
 * Whether a refusal means "the store is still settling" and a retry is safe.
 *
 * `session.close` returns before the gateway retires the session, so a mutation
 * issued straight after it is answered `409 session_busy`. Nothing was written,
 * so retrying with a freshly read fence is correct rather than risky.
 */
export function isBusyRefusal(error: unknown): boolean {
  const text = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return /session_busy|storage_unavailable|runtime_draining/i.test(text);
}

/**
 * Whether a refusal means "your fence is missing / the app is too old".
 *
 * 0.22.5 answers `409` with a `client_upgrade_required` detail even to a client
 * that simply forgot the fence, so the two are indistinguishable by status. The
 * caller treats it as "retry with a fresh fence" rather than showing the user a
 * message about updating an app they do not have.
 */
export function isFenceRefusal(error: unknown): boolean {
  const text = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return /client_upgrade_required|mutation_identity_required/i.test(text);
}
