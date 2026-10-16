/**
 * JSON-RPC channel over one socket generation.
 *
 * Wire rules are in `docs/01-protocol-contract.md` §2–§3. The load-bearing
 * detail is id typing: our requests use numeric ids, the backend's requests to
 * us use string ids, and that is the only way to tell a response from a
 * question on the same socket.
 *
 * No `WebSocket` construction here — the socket arrives through a factory, so
 * tests drive the channel with a fake. See AGENTS.md 铁律 2.
 */

export interface Transport {
  send(text: string): void;
  close(): void;
}

export interface ServerRequest {
  id: string;
  method: string;
  params: Record<string, unknown>;
  respond: (result: Record<string, unknown>) => void;
  fail: (code: number, message: string) => void;
}

export type ServerRequestHandler = (request: ServerRequest) => boolean | void;

export interface GatewayEvent {
  type: string;
  session_id?: string;
  seq?: number;
  replayEpoch?: string;
  payload?: Record<string, unknown>;
}

export interface ChannelOptions {
  requestTimeoutMs?: number;
  heartbeatIntervalMs?: number;
  /** A ping with no inbound traffic for this long drops the socket. */
  heartbeatDeadlineMs?: number;
  onEvent?: (event: GatewayEvent) => void;
  onServerRequest?: ServerRequestHandler;
  onUnhandledRequest?: (request: { id: string; method: string }) => void;
  onHeartbeatFailure?: (error: Error) => void;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;
const DEFAULT_HEARTBEAT_DEADLINE_MS = 45_000;

export class GatewayError extends Error {
  readonly code?: number;
  constructor(message: string, code?: number) {
    super(message);
    this.name = "GatewayError";
    this.code = code;
  }
}

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

function isServerRequestFrame(frame: Record<string, unknown>): boolean {
  return typeof frame.id === "string" && typeof frame.method === "string" && frame.method !== "event";
}

export class Channel {
  private readonly options: Required<
    Pick<ChannelOptions, "requestTimeoutMs" | "heartbeatIntervalMs" | "heartbeatDeadlineMs">
  > &
    Omit<ChannelOptions, "requestTimeoutMs" | "heartbeatIntervalMs" | "heartbeatDeadlineMs">;

  private transport: Transport | null = null;
  private nextId = 0;
  private readonly pending = new Map<number, PendingCall>();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private outstandingPings = new Set<string>();
  private lastInboundAt = 0;
  private lastPingAt = 0;
  private heartbeatSeq = 0;
  private closed = false;

  constructor(options: ChannelOptions = {}) {
    this.options = {
      requestTimeoutMs: options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      heartbeatIntervalMs: options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS,
      heartbeatDeadlineMs: options.heartbeatDeadlineMs ?? DEFAULT_HEARTBEAT_DEADLINE_MS,
      ...options,
    };
  }

  /** Bind a socket generation. Replaces (and rejects) any previous one. */
  bind(transport: Transport): void {
    this.unbind(new GatewayError("socket replaced"));
    this.transport = transport;
    this.closed = false;
    this.lastInboundAt = Date.now();
    this.lastPingAt = 0;
  }

  unbind(reason = new GatewayError("socket closed")): void {
    this.stopHeartbeat();
    this.transport = null;
    this.closed = true;
    for (const [id, call] of this.pending) {
      if (call.timer) clearTimeout(call.timer);
      this.pending.delete(id);
      call.reject(reason);
    }
  }

  get isBound(): boolean {
    return this.transport !== null && !this.closed;
  }

  request<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const transport = this.transport;
    if (!transport) {
      return Promise.reject(new GatewayError("gateway not connected"));
    }
    this.nextId += 1;
    const id = this.nextId;
    return new Promise<T>((resolve, reject) => {
      const timer =
        this.options.requestTimeoutMs > 0
          ? setTimeout(() => {
              this.pending.delete(id);
              reject(new GatewayError(`request timed out: ${method}`));
            }, this.options.requestTimeoutMs)
          : null;
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      try {
        transport.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
      } catch (error) {
        if (timer) clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  /** Feed one inbound text frame. Returns the decoded frame, or null when it was not JSON. */
  handleFrame(text: string): Record<string, unknown> | null {
    let frame: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(text);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
      frame = parsed as Record<string, unknown>;
    } catch {
      return null;
    }

    this.lastInboundAt = Date.now();

    if (isServerRequestFrame(frame)) {
      this.deliverServerRequest(frame);
      return frame;
    }

    const rawId = frame.id;
    if (typeof rawId === "number") {
      if (this.outstandingPings.delete(`heartbeat-${rawId}`)) {
        // pong: liveness already recorded above
        return frame;
      }
      const call = this.pending.get(rawId);
      if (call) {
        if (call.timer) clearTimeout(call.timer);
        this.pending.delete(rawId);
        const error = frame.error as { message?: string; code?: number } | undefined;
        if (error) {
          call.reject(new GatewayError(error.message || "Hermes RPC failed", error.code));
        } else {
          call.resolve(frame.result);
        }
      }
      return frame;
    }

    if (typeof rawId === "string" && this.outstandingPings.delete(rawId)) {
      return frame;
    }

    if (frame.method === "event" && frame.params && typeof frame.params === "object") {
      const event = frame.params as GatewayEvent;
      if (typeof event.type === "string") {
        if (event.type === "gateway.ready") {
          const payload = event.payload as { heartbeat?: boolean } | undefined;
          if (payload?.heartbeat) this.startHeartbeat();
          void this.advertiseCapabilities();
        }
        this.options.onEvent?.(event);
      }
    }

    return frame;
  }

  /**
   * Tell the backend this client answers server→client requests. Without it the
   * backend treats us as a build older than server requests and fails every
   * approval / clarify immediately instead of waiting for the user.
   */
  private async advertiseCapabilities(): Promise<void> {
    try {
      await this.request("client.capabilities", { server_requests: true });
    } catch {
      // An older backend answers -32601 here; that is expected and harmless.
    }
  }

  private deliverServerRequest(frame: Record<string, unknown>): void {
    const id = frame.id as string;
    const method = frame.method as string;
    const params = (frame.params && typeof frame.params === "object" ? frame.params : {}) as Record<string, unknown>;
    let answered = false;

    const respond = (result: Record<string, unknown>): void => {
      if (answered) return;
      answered = true;
      this.sendRaw({ jsonrpc: "2.0", id, result });
    };
    const fail = (code: number, message: string): void => {
      if (answered) return;
      answered = true;
      this.sendRaw({ jsonrpc: "2.0", id, error: { code, message } });
    };

    const handled = this.options.onServerRequest?.({ id, method, params, respond, fail });
    if (handled === false || !handled) {
      // Fail fast rather than letting the backend wait out its full deadline
      // against a client that was never going to answer.
      this.options.onUnhandledRequest?.({ id, method });
      fail(-32601, `client does not handle ${method}`);
    }
  }

  private sendRaw(frame: Record<string, unknown>): void {
    try {
      this.transport?.send(JSON.stringify(frame));
    } catch {
      // The socket is gone; the pending request will reject on unbind.
    }
  }

  startHeartbeat(): void {
    this.stopHeartbeat();
    if (this.options.heartbeatIntervalMs <= 0) return;
    this.lastInboundAt = Date.now();
    this.heartbeatTimer = setInterval(() => {
      if (!this.transport) return;
      const now = Date.now();
      // Judge silence against the last ping we sent, not against an absolute
      // clock: a background tab throttles timers to ~60s, so the previous
      // pong is legitimately old at every tick.
      if (this.lastPingAt > this.lastInboundAt && now - this.lastInboundAt >= this.options.heartbeatDeadlineMs) {
        // Stop before reporting: the interval would otherwise keep firing and
        // report the same dead socket on every tick.
        this.stopHeartbeat();
        this.options.onHeartbeatFailure?.(new Error("WebSocket heartbeat timed out"));
        return;
      }
      this.heartbeatSeq += 1;
      const id = `heartbeat-${this.heartbeatSeq}`;
      this.outstandingPings.add(id);
      while (this.outstandingPings.size > 32) {
        const oldest = this.outstandingPings.values().next().value;
        if (oldest === undefined) break;
        this.outstandingPings.delete(oldest);
      }
      this.lastPingAt = now;
      try {
        this.transport.send(JSON.stringify({ jsonrpc: "2.0", id, method: "gateway.ping", params: {} }));
      } catch (error) {
        this.options.onHeartbeatFailure?.(error instanceof Error ? error : new Error(String(error)));
      }
    }, this.options.heartbeatIntervalMs);
  }

  stopHeartbeat(): void {
    this.outstandingPings.clear();
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }
}
