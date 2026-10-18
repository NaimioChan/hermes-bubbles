/**
 * Socket lifecycle: connect, reconnect with backoff, replay gap fill.
 *
 * The channel above is transport-agnostic; this is the piece that owns the
 * actual `WebSocket` and the reconnect state machine. It never touches React.
 */

import { Channel, type GatewayEvent, type ServerRequestHandler, type Transport } from "./channel";
import type { Messages } from "../core/i18n";
import { messagesFor } from "../core/i18n";

export type ConnectionState = "idle" | "connecting" | "open" | "closed" | "error";

export interface ClientOptions {
  /** Resolves a fresh, authenticated ws URL. Called on every connect attempt. */
  urlProvider: () => Promise<string>;
  onEvent: (event: GatewayEvent) => void;
  onServerRequest: ServerRequestHandler;
  onState?: (state: ConnectionState, detail?: string) => void;
  /** Fired after a successful reconnect, before the caller re-syncs state. */
  onReconnected?: () => void;
  onUnhandledRequest?: (request: { id: string; method: string }) => void;
  socketFactory?: (url: string) => WebSocket;
  /**
   * The catalog in the dashboard's current language.
   *
   * A provider rather than a fixed catalog because the language can change while
   * the socket lives, and because the transport owns the failure sentences
   * (`Heartbeat timed out`, the 4401/4403 refusals) — leaving them in this file
   * as literals is how an English dashboard used to show Chinese.
   */
  messages?: () => Messages;
}

const BACKOFF_MS = [500, 1_000, 2_000, 4_000, 8_000, 15_000];

export class GatewayClient {
  private readonly options: ClientOptions;
  private readonly channel: Channel;
  private socket: WebSocket | null = null;
  private state: ConnectionState = "idle";
  private attempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private everConnected = false;
  /** Short machine tag for the last terminal failure: "auth" | "scope" | "". */
  private failureKind = "";
  /** Human-facing text for that failure. */
  private failureMessage = "";
  /**
   * Callers that need a usable socket (any RPC) park here until one exists.
   * Without this, `connect(); openSession();` races: the RPC is sent before the
   * URL even resolves, and the caller sees "gateway not connected" on a socket
   * that comes up milliseconds later.
   */
  private openWaiters: { resolve: () => void; reject: (error: Error) => void }[] = [];
  /** Epoch reported by the backend, exposed so the dedupe gate can key on it. */
  epoch = "";

  constructor(options: ClientOptions) {
    this.options = options;
    this.channel = new Channel({
      onEvent: (event) => {
        if (event.type === "gateway.ready") {
          const payload = event.payload as { replay_epoch?: string } | undefined;
          if (payload?.replay_epoch) this.epoch = payload.replay_epoch;
        }
        this.options.onEvent(event);
      },
      onServerRequest: options.onServerRequest,
      onUnhandledRequest: options.onUnhandledRequest,
      onHeartbeatFailure: () => {
        // A silent socket is indistinguishable from a dead one; drop it and let
        // the reconnect path take over.
        this.dropAndReconnect(this.messages().heartbeatTimeout);
      },
    });
  }

  getState(): ConnectionState {
    return this.state;
  }

  /** The catalog in the dashboard's language; English when the caller did not supply one. */
  private messages(): Messages {
    return this.options.messages?.() ?? messagesFor("en");
  }

  private setState(state: ConnectionState, detail?: string): void {
    this.state = state;
    this.options.onState?.(state, detail);
  }

  async connect(): Promise<void> {
    if (this.disposed) return;
    if (this.state === "open" || this.state === "connecting") return;
    this.setState("connecting");
    let url: string;
    try {
      url = await this.options.urlProvider();
    } catch (error) {
      this.setState("error", error instanceof Error ? error.message : String(error));
      this.scheduleReconnect();
      return;
    }

    const factory = this.options.socketFactory ?? ((u: string) => new WebSocket(u));
    let socket: WebSocket;
    try {
      socket = factory(url);
    } catch (error) {
      this.setState("error", error instanceof Error ? error.message : String(error));
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;

    socket.onopen = () => {
      if (this.socket !== socket) return;
      this.attempt = 0;
      this.setState("open");
      const transport: Transport = {
        send: (text) => {
          if (this.socket === socket && socket.readyState === 1) socket.send(text);
        },
        close: () => socket.close(),
      };
      this.channel.bind(transport);
      this.settleOpenWaiters(null);
      if (this.everConnected) this.options.onReconnected?.();
      this.everConnected = true;
    };

    socket.onmessage = (message) => {
      if (this.socket !== socket) return;
      const data = message.data;
      if (typeof data === "string") {
        this.channel.handleFrame(data);
      } else if (data instanceof ArrayBuffer) {
        this.channel.handleFrame(new TextDecoder().decode(data));
      }
    };

    socket.onerror = () => {
      if (this.socket !== socket) return;
      this.setState("error", "socket error");
    };

    socket.onclose = (event) => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.channel.unbind();
      // 4401/4403 are auth/scope refusals: retrying with the same credential
      // will fail identically, so stop and surface it.
      if (event.code === 4401 || event.code === 4403) {
        this.failureKind = event.code === 4401 ? "auth" : "scope";
        this.failureMessage =
          event.code === 4401 ? this.messages().connectUnauthorized : this.messages().connectChatDisabled;
        this.settleOpenWaiters(new Error(this.failureMessage));
        this.setState("error", this.failureMessage);
        return;
      }
      this.dropAndReconnect();
    };
  }

  private dropAndReconnect(detail?: string): void {
    const socket = this.socket;
    this.socket = null;
    this.channel.unbind();
    if (socket && socket.readyState <= 1) {
      try {
        socket.close();
      } catch {
        // already closing
      }
    }
    this.setState("closed", detail);
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.reconnectTimer !== null) return;
    const delay = BACKOFF_MS[Math.min(this.attempt, BACKOFF_MS.length - 1)] ?? 15_000;
    this.attempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delay);
  }

  request<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    return this.channel.request<T>(method, params);
  }
  /**
   * Resolve once a socket is usable, starting one if needed.
   *
   * Callers should await this instead of `connect()` when they are about to send
   * an RPC. `connect()` alone is fire-and-forget: it returns before the URL
   * provider resolves, so an immediate `request()` fails on a socket that is
   * about to be fine.
   */
  async ensureOpen(): Promise<void> {
    if (this.disposed) throw new Error("gateway disposed");
    if (this.state === "open" && this.channel.isBound) return;
    // 4401/4403 are terminal auth/scope refusals: waiting will not help, and
    // the reconnect loop has already stopped.
    if (this.state === "error" && (this.failureKind === "auth" || this.failureKind === "scope")) {
      throw new Error(this.failureMessage || "gateway unavailable");
    }
    const waiter = new Promise<void>((resolve, reject) => {
      this.openWaiters.push({ resolve, reject });
    });
    void this.connect();
    return waiter;
  }

  private settleOpenWaiters(error: Error | null): void {
    const waiters = this.openWaiters;
    this.openWaiters = [];
    for (const waiter of waiters) {
      if (error) waiter.reject(error);
      else waiter.resolve();
    }
  }

  dispose(): void {
    this.disposed = true;
    this.settleOpenWaiters(new Error("gateway disposed"));
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.channel.unbind();
    const socket = this.socket;
    this.socket = null;
    try {
      socket?.close();
    } catch {
      // already closed
    }
    this.setState("idle");
  }
}
