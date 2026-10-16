/**
 * Cross-socket duplicate gate.
 *
 * The backend joins EVERY socket that has spoken to a session into that
 * session's transport fan-out (tui_gateway/session_transports.py) and stamps
 * `seq` once, before the fan-out. A client holding two sockets to one backend
 * — a reconnect that overlaps the old socket, a second tab — receives the same
 * frame twice, and every `message.delta` lands twice, doubling the text in the
 * bubble.
 *
 * Key is `(epoch, session_id, seq)`. The epoch is the backend process's
 * `replay_epoch` from `gateway.ready`; a restart resets per-session seq
 * counters to 1, so the epoch is what keeps a restart from looking like a
 * duplicate of everything that came before.
 *
 * Frames without `seq` or `session_id` (global broadcasts) always pass: there
 * is no ordering contract on them to enforce.
 */

const SEEN_PER_SESSION_MAX = 2048;
const SESSIONS_MAX = 64;

interface SessionSeen {
  seen: Set<number>;
  /** Insertion order for eviction; JS Set preserves it. */
}

export interface EventKey {
  session_id?: string;
  seq?: number;
  replayEpoch?: string;
}

export class EventDedupe {
  private readonly sessions = new Map<string, SessionSeen>();
  private epoch = "";

  /** Called with `gateway.ready.payload.replay_epoch`. */
  setEpoch(epoch: string): void {
    if (epoch === this.epoch) return;
    this.epoch = epoch;
    // A different process is behind the socket: every watermark we hold is
    // meaningless against its counters.
    this.sessions.clear();
  }

  getEpoch(): string {
    return this.epoch;
  }

  /** True when the frame is new and must be handled. */
  admit(event: EventKey): boolean {
    const { session_id: sid, seq } = event;
    if (!sid || typeof seq !== "number" || !Number.isFinite(seq)) return true;

    const key = `${this.epoch}\u0000${sid}`;
    let entry = this.sessions.get(key);
    if (entry) {
      this.sessions.delete(key);
    } else {
      entry = { seen: new Set() };
    }
    this.sessions.set(key, entry);

    while (this.sessions.size > SESSIONS_MAX) {
      const oldest = this.sessions.keys().next().value;
      if (oldest === undefined) break;
      this.sessions.delete(oldest);
    }

    if (entry.seen.has(seq)) return false;
    entry.seen.add(seq);
    while (entry.seen.size > SEEN_PER_SESSION_MAX) {
      const oldest = entry.seen.values().next().value;
      if (oldest === undefined) break;
      entry.seen.delete(oldest);
    }
    return true;
  }
}
