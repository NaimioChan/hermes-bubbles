/**
 * Socket lifecycle: connect, reconnect with backoff, replay gap fill.
 *
 * The channel above is transport-agnostic; this is the piece that owns the
 * actual `WebSocket` and the reconnect state machine. It never touches React.
 */

import { Channel, type GatewayEvent, type ServerRequestHandler, type Transport } from "./channel";

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
        this.dropAndReconnect("心跳超时");
      },
    });
  }

  getState(): ConnectionState {
    return this.state;
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
        this.setState("error", event.code === 4401 ? "鉴权失败，请刷新页面" : "聊天功能未启用");
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

  dispose(): void {
    this.disposed = true;
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
