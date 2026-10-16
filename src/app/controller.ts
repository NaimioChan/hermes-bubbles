/**
 * Session controller: the seam between the socket and React.
 *
 * Owns one `GatewayClient`, one timeline, and the rules that only make sense
 * with both in hand — filtering events to the active session, deduplicating
 * fan-out copies, and binding the optimistic user bubble to the backend's
 * acknowledgement.
 *
 * Framework-free on purpose: it is driven by `subscribe()`/`getSnapshot()` so
 * React can consume it through `useSyncExternalStore`, and tests can drive it
 * with a fake socket and no renderer.
 */

import { EventDedupe } from "../core/dedupe";
import { projectHistory, timelineFromSnapshot, type LiveSessionSnapshot, type TranscriptMessage } from "../core/history";
import { ackUser, appendUser, reduceEvent, settleTimeline, type GatewayEvent } from "../core/reduce";
import { emptyTimeline, type Timeline, type TimelineItem } from "../core/types";
import { GatewayClient, type ConnectionState } from "../gateway/client";
import type { ServerRequest } from "../gateway/channel";

export interface ServerRequestCard {
  id: string;
  method: string;
  params: Record<string, unknown>;
  respond: (result: Record<string, unknown>) => void;
  fail: (code: number, message: string) => void;
}

export interface ControllerOptions {
  urlProvider: () => Promise<string>;
  socketFactory?: (url: string) => WebSocket;
  /** Called when the backend asks a question this page can render (approval, clarify). */
  onServerRequest?: (card: ServerRequestCard) => void;
  /** prompt.submit's ack deadline; the desktop uses 30 min because a turn can legitimately run long. */
  promptTimeoutMs?: number;
}

/** Server→client requests this page renders. Anything else is answered `-32601`. */
const HANDLED_REQUESTS = new Set(["approval", "clarify"]);

export class ChatController {
  private readonly client: GatewayClient;
  private readonly dedupe = new EventDedupe();
  private readonly listeners = new Set<() => void>();
  private timeline: Timeline = emptyTimeline;
  private state: ConnectionState = "idle";
  private detail = "";
  /** Set while a reconnect is in flight so replay does not double-render. */
  private resyncing = false;
  /** The page's card sink. Swappable so a remount does not need a new socket. */
  private cardSink: ((card: ServerRequestCard) => void) | null = null;

  constructor(options: ControllerOptions) {
    this.cardSink = options.onServerRequest ?? null;
    this.client = new GatewayClient({
      urlProvider: options.urlProvider,
      socketFactory: options.socketFactory,
      onState: (state, detail) => {
        this.state = state;
        this.detail = detail ?? "";
        if (state !== "open") {
          this.timeline = { items: this.timeline.items, meta: { ...this.timeline.meta, connected: false } };
        }
        this.emit();
      },
      onEvent: (event) => this.handleEvent(event),
      onServerRequest: (request) => this.handleServerRequest(request),
    });
  }

  // ── React interop ────────────────────────────────────────────────────────

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): Timeline => this.timeline;

  getConnection = (): { state: ConnectionState; detail: string } => ({ state: this.state, detail: this.detail });

  private emit(): void {
    for (const listener of this.listeners) listener();
  }

  private setTimeline(next: Timeline): void {
    this.timeline = next;
    this.emit();
  }

  // ── lifecycle ────────────────────────────────────────────────────────────

  connect(): void {
    void this.client.connect();
  }

  /**
   * Wait until the socket is usable, then open a session.
   *
   * The await is the point: `connect()` is fire-and-forget, so an immediate
   * `openSession()` sends `session.create` before a socket exists and fails with
   * "gateway not connected" — on a connection that succeeds moments later.
   */
  async start(storedId?: string): Promise<void> {
    await this.client.ensureOpen();
    await this.openSession(storedId);
  }

  dispose(): void {
    this.client.dispose();
    this.listeners.clear();
  }

  // ── session ──────────────────────────────────────────────────────────────

  /**
   * Start (or attach to) a session and load its transcript.
   *
   * `session.create` with no `session_id` mints a new one; `session.resume`
   * attaches to an existing stored id. Both return the same snapshot shape.
   */
  async openSession(storedId?: string): Promise<void> {
    const snapshot = storedId
      ? await this.client.request<LiveSessionSnapshot>("session.resume", {
          session_id: storedId,
          omit_messages: false,
        })
      : await this.client.request<LiveSessionSnapshot>("session.create", { source: "desktop" });

    this.dedupe.setEpoch(this.client.epoch);
    this.setTimeline(timelineFromSnapshot(snapshot));
  }

  async listSessions(limit = 30): Promise<{ id: string; title: string; preview: string; started_at: number }[]> {
    const result = await this.client.request<{
      sessions: { id: string; title: string; preview: string; started_at: number }[];
    }>("session.list", { limit });
    return result.sessions ?? [];
  }

  /** Re-read the durable transcript after a reconnect (replay covers the gap in theory; this is the backstop). */
  async resync(): Promise<void> {
    const id = this.timeline.meta.runtimeId ?? this.timeline.meta.storedId;
    if (!id || this.resyncing) return;
    this.resyncing = true;
    try {
      await this.client.ensureOpen();
      const result = await this.client.request<{ messages: TranscriptMessage[] }>("session.history", {
        session_id: id,
      });
      const restored = projectHistory(result.messages ?? []);
      const live = this.timeline.meta.running ? this.unpersistedTail() : [];
      this.setTimeline({ items: restored.concat(live), meta: this.timeline.meta });
    } catch {
      // Best effort: a failed resync leaves the streamed view in place.
    } finally {
      this.resyncing = false;
    }
  }

  /**
   * The items a history read cannot contain: the bubble currently streaming and
   * anything appended after it. Everything earlier is already in the store.
   */
  private unpersistedTail(): TimelineItem[] {
    const items = this.timeline.items;
    for (let i = items.length - 1; i >= 0; i -= 1) {
      const item = items[i];
      if (item && item.kind === "assistant" && item.streaming) return items.slice(i);
    }
    return [];
  }

  // ── sending ──────────────────────────────────────────────────────────────

  async send(text: string): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed) return;
    if (!this.timeline.meta.runtimeId) {
      await this.start();
    }
    const sessionId = this.timeline.meta.runtimeId;
    if (!sessionId) throw new Error("会话尚未建立");

    this.setTimeline(appendUser(this.timeline, trimmed));
    const result = await this.client.request<{ status?: string; user_row_id?: number }>(
      "prompt.submit",
      { session_id: sessionId, text: trimmed },
      // The RPC only acknowledges receipt; the reply arrives on the event
      // stream. A short timeout here would report a false failure mid-turn.
    );
    this.setTimeline(ackUser(this.timeline, result?.user_row_id));
  }

  async interrupt(): Promise<void> {
    const sessionId = this.timeline.meta.runtimeId;
    if (!sessionId) return;
    try {
      await this.client.request("session.interrupt", { session_id: sessionId });
    } catch {
      // A failed stop RPC does not mean the turn is still running; the settle
      // below is what the UI needs either way.
    }
    this.setTimeline(settleTimeline(this.timeline));
  }

  // ── event intake ─────────────────────────────────────────────────────────

  private handleEvent(event: GatewayEvent): void {
    if (event.type === "gateway.ready") {
      this.dedupe.setEpoch(this.client.epoch);
      // `gateway.ready` is the first frame and the proof the channel works.
      // Reduce it (rather than returning early) so `meta.connected` flips true
      // and the composer leaves its disabled "连接中…" state.
      const next = reduceEvent(this.timeline, event);
      if (next !== this.timeline) this.setTimeline(next);
      return;
    }

    // One socket receives every session's events; only the active one belongs
    // on screen.
    const active = this.timeline.meta.runtimeId;
    if (event.session_id && active && event.session_id !== active) return;
    if (event.session_id && !active) {
      // Before the first snapshot resolves there is nothing to filter against,
      // and dropping the frames would lose the start of a turn.
      return;
    }

    if (!this.dedupe.admit({ session_id: event.session_id, seq: event.seq, replayEpoch: event.replayEpoch })) {
      return;
    }

    const next = reduceEvent(this.timeline, event);
    if (next !== this.timeline) this.setTimeline(next);
  }

  private handleServerRequest(request: ServerRequest): boolean {
    if (!HANDLED_REQUESTS.has(request.method)) return false;
    if (!this.cardSink) return false;
    this.cardSink({
      id: request.id,
      method: request.method,
      params: request.params,
      respond: request.respond,
      fail: request.fail,
    });
    return true;
  }

  /** Swap the card sink (page mount/unmount) without rebuilding the socket. */
  setServerRequestSink(sink: ((card: ServerRequestCard) => void) | null): void {
    this.cardSink = sink;
  }

  /** Send a card answer through the request the backend is blocking on. */
  answerRequest(card: ServerRequestCard, result: Record<string, unknown>): void {
    card.respond(result);
  }
}
