/**
 * The app-facing controller.
 *
 * Owns one socket and the multi-session store, and exposes them to React through
 * `subscribe()`/`getSnapshot()` (consumed with `useSyncExternalStore`).
 *
 * Framework-free on purpose: the whole session lifecycle — open, focus, route,
 * send, stop, switch model — is exercisable with a fake socket and no renderer.
 * See AGENTS.md 铁律 1–2.
 */

import { attachMethodFor, type Attachment, type AttachmentKind } from "../core/attachments";
import { EventDedupe } from "../core/dedupe";
import { reduceEvent, type GatewayEvent } from "../core/reduce";
import {
  ackUserInActive,
  activeTimeline,
  appendUserToActive,
  bindSnapshot,
  closeTab,
  emptyMultiState,
  focus,
  openDraft,
  openStored,
  replaceHistory,
  routeEvent,
  settleActive,
  timelineOf,
  type MultiState,
} from "../core/sessions";
import { parseCommandInput, parseDispatch, type DispatchResult } from "../core/slash";
import type { TimelineItem } from "../core/types";
import type { ServerRequest } from "../gateway/channel";
import { GatewayClient, type ConnectionState } from "../gateway/client";

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
  onServerRequest?: (card: ServerRequestCard) => void;
}

/** Server→client requests this page renders. Anything else is answered `-32601`. */
const HANDLED_REQUESTS = new Set(["approval", "clarify"]);

export interface ModelOptionProvider {
  slug: string;
  name: string;
  models: string[];
  is_current?: boolean;
  authenticated?: boolean;
  warning?: string;
}

export class ChatController {
  private readonly client: GatewayClient;
  private readonly dedupe = new EventDedupe();
  private readonly listeners = new Set<() => void>();
  private state: MultiState = emptyMultiState;
  private connection: ConnectionState = "idle";
  private detail = "";
  private resyncing = false;
  private cardSink: ((card: ServerRequestCard) => void) | null = null;

  constructor(options: ControllerOptions) {
    this.cardSink = options.onServerRequest ?? null;
    this.client = new GatewayClient({
      urlProvider: options.urlProvider,
      socketFactory: options.socketFactory,
      onState: (state, detail) => {
        this.connection = state;
        this.detail = detail ?? "";
        if (state !== "open") {
          const sessions: MultiState["sessions"] = {};
          for (const [key, timeline] of Object.entries(this.state.sessions)) {
            sessions[key] = { items: timeline.items, meta: { ...timeline.meta, connected: false } };
          }
          this.state = { ...this.state, sessions };
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

  getSnapshot = (): MultiState => this.state;

  getConnection = (): { state: ConnectionState; detail: string } => ({
    state: this.connection,
    detail: this.detail,
  });

  /** The focused tab's timeline — what the transcript renders. */
  getActiveTimeline = () => activeTimeline(this.state);

  private emit(): void {
    for (const listener of this.listeners) listener();
  }

  private setState(next: MultiState): void {
    this.state = next;
    this.emit();
  }

  setServerRequestSink(sink: ((card: ServerRequestCard) => void) | null): void {
    this.cardSink = sink;
  }

  /**
   * Every RPC goes through here so the socket is guaranteed before the frame is
   * sent.
   *
   * Calling `client.request` directly is how the page shipped a
   * "gateway not connected" banner: the call raced the async connect and failed
   * on a socket that came up milliseconds later. Routing everything through one
   * guarded helper makes that impossible to reintroduce by accident.
   */
  private async rpc<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    await this.client.ensureOpen();
    return this.client.request<T>(method, params);
  }

  // ── lifecycle ────────────────────────────────────────────────────────────

  dispose(): void {
    this.client.dispose();
    this.listeners.clear();
  }

  /** Connect (if needed) and make sure there is at least one open tab. */
  async start(): Promise<void> {
    await this.client.ensureOpen();
    if (!this.state.tabs.length) {
      this.setState(openDraft(this.state));
      await this.ensureSession();
    }
  }

  /** A fresh chat tab. */
  async newSession(): Promise<void> {
    this.setState(openDraft(this.state));
    await this.ensureSession();
  }

  /**
   * Attach to a stored session.
   *
   * `session.resume` reuses the live session when there is one, so reopening a
   * tab you already have open is cheap; the store dedupes the tab either way.
   */
  async openStoredSession(storedId: string, title: string): Promise<void> {
    await this.client.ensureOpen();
    this.setState(openStored(this.state, storedId, title));
    const key = `stored:${storedId}`;
    try {
      const snapshot = await this.client.request<Record<string, unknown>>("session.resume", {
        session_id: storedId,
        omit_messages: false,
      });
      this.setState(bindSnapshot(this.state, key, snapshot as never, { connected: this.connection === "open" }));
    } catch (error) {
      this.setState(this.markError(key, error));
    }
  }

  focusSession(key: string): void {
    this.setState(focus(this.state, key));
  }

  closeSession(key: string): void {
    this.setState(closeTab(this.state, key));
  }

  /** Stored sessions for the sidebar. */
  async listSessions(
    limit = 40,
  ): Promise<{ id: string; title: string; preview: string; started_at: number; message_count: number }[]> {
    const result = await this.rpc<{
      sessions: { id: string; title: string; preview: string; started_at: number; message_count: number }[];
    }>("session.list", { limit });
    return result.sessions ?? [];
  }

  /**
   * Give the focused tab a backend session if it does not have one.
   *
   * A draft becomes real here rather than at page load, so opening a second tab
   * does not mint a session the user never speaks into.
   */
  private async ensureSession(): Promise<string | null> {
    const key = this.state.activeKey;
    if (!key) return null;
    const tab = this.state.tabs.find((t) => t.key === key);
    if (!tab) return null;
    if (tab.runtimeId) return tab.runtimeId;

    const method = tab.storedId ? "session.resume" : "session.create";
    const params = tab.storedId
      ? { session_id: tab.storedId, omit_messages: false }
      : { source: "desktop" };
    const snapshot = await this.client.request<Record<string, unknown>>(method, params);
    this.setState(bindSnapshot(this.state, key, snapshot as never, { connected: this.connection === "open" }));
    return (snapshot as { session_id?: string }).session_id ?? null;
  }

  private markError(key: string, error: unknown): MultiState {
    const message = error instanceof Error ? error.message : String(error);
    const timeline = timelineOf(this.state, key);
    const items: TimelineItem[] = [
      ...timeline.items,
      { kind: "notice", id: `err-${Date.now()}`, at: Date.now(), text: message, tone: "error" },
    ];
    return { ...this.state, sessions: { ...this.state.sessions, [key]: { items, meta: timeline.meta } } };
  }

  // ── sending ──────────────────────────────────────────────────────────────

  /**
   * Send a turn.
   *
   * A leading `/` is a command, not a message: it goes through
   * `command.dispatch` and the reply's `type` decides what happens next.
   */
  async send(text: string): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed) return;

    const command = parseCommandInput(trimmed);
    if (command) {
      await this.dispatchCommand(command.name, command.arg);
      return;
    }

    await this.submitMessage(trimmed, trimmed);
  }

  /**
   * Run a slash command and apply its directive.
   *
   * The dispatch reply is a small instruction language (see the contract): most
   * shapes either show text or turn into a normal message. Anything unrecognised
   * becomes a visible notice rather than a silent no-op.
   */
  async dispatchCommand(name: string, arg: string): Promise<DispatchResult | null> {
    const runtimeId = this.state.tabs.find((t) => t.key === this.state.activeKey)?.runtimeId ?? null;
    let reply: unknown;
    try {
      reply = await this.client.request("command.dispatch", {
        name,
        arg: arg || undefined,
        session_id: runtimeId ?? undefined,
      });
    } catch (error) {
      this.notice(error instanceof Error ? error.message : String(error), "error");
      return null;
    }

    const directive = parseDispatch(reply);
    if (!directive) {
      this.notice(`/${name} 返回了无法识别的结果`, "error");
      return null;
    }

    switch (directive.type) {
      case "alias":
        // An alias names another command; run that rather than showing the target.
        return this.dispatchCommand((directive.target ?? "").replace(/^\//, ""), arg);
      case "exec":
      case "plugin":
        this.notice(directive.output || `/${name} 已执行`);
        return directive;
      case "prefill":
        // The composer puts `message` in the box; the notice explains why.
        if (directive.notice) this.notice(directive.notice);
        return directive;
      case "send":
      case "skill":
        // `display` is what the user sees; `message` is what the model gets.
        await this.submitMessage(directive.message ?? "", directive.display || directive.message || "");
        if (directive.notice) this.notice(directive.notice);
        return directive;
      default:
        this.notice(`/${name} 的结果类型 ${String((directive as { type: string }).type)} 暂不支持`, "error");
        return directive;
    }
  }

  /**
   * Submit a resolved message, with the text shown to the user when it differs.
   *
   * Sending while a turn is live is deliberately allowed: the gateway's busy path
   * decides whether the text queues, steers (injected into the running turn's
   * next tool result) or redirects, and reports which in `status`. The composer
   * used to disable itself instead, which is not how Hermes behaves elsewhere —
   * mid-turn input is a correction, not an error.
   */
  private async submitMessage(message: string, display: string): Promise<void> {
    if (!message.trim()) return;
    const runtimeId = await this.ensureSession();
    if (!runtimeId) throw new Error("会话尚未建立");
    const wasRunning = activeTimeline(this.state).meta.running;

    this.setState(appendUserToActive(this.state, display || message));
    const result = await this.client.request<{ status?: string; user_row_id?: number }>("prompt.submit", {
      session_id: runtimeId,
      text: message,
    });
    this.setState(ackUserInActive(this.state, result?.user_row_id));

    // Tell the user what the backend did with a mid-turn message: without this
    // the text just sits in the transcript and looks ignored until the turn ends.
    if (wasRunning) {
      const status = result?.status;
      if (status === "steered") {
        this.notice("已插入当前任务，模型会在下一步看到它", "info");
      } else if (status === "redirected") {
        this.notice("已改为新方向", "info");
      } else if (status === "queued") {
        this.notice("已排队，当前任务结束后发送", "info");
      }
    }
  }

  /** Append a local notice line to the focused transcript. */
  notice(text: string, tone: "info" | "error" = "info"): void {
    const key = this.state.activeKey;
    if (!key) return;
    const timeline = timelineOf(this.state, key);
    const items: TimelineItem[] = [
      ...timeline.items,
      { kind: "notice", id: `n-${Date.now()}-${timeline.items.length}`, at: Date.now(), text, tone },
    ];
    this.setState({ ...this.state, sessions: { ...this.state.sessions, [key]: { items, meta: timeline.meta } } });
  }

  async interrupt(): Promise<void> {
    const runtimeId = this.state.tabs.find((t) => t.key === this.state.activeKey)?.runtimeId;
    if (!runtimeId) return;
    try {
      await this.client.request("session.interrupt", { session_id: runtimeId });
    } catch {
      // A failed stop RPC does not mean the turn is still running; the settle
      // below is what the UI needs either way.
    }
    this.setState(settleActive(this.state));
  }

  // ── model & reasoning ────────────────────────────────────────────────────

  /** Provider/model inventory for the picker. */
  async listModels(): Promise<{ providers: ModelOptionProvider[]; model: string; provider: string }> {
    const runtimeId = this.state.tabs.find((t) => t.key === this.state.activeKey)?.runtimeId;
    const result = await this.rpc<{
      providers: ModelOptionProvider[];
      model: string;
      provider: string;
    }>("model.options", runtimeId ? { session_id: runtimeId } : {});
    return { providers: result.providers ?? [], model: result.model ?? "", provider: result.provider ?? "" };
  }

  /**
   * Switch the focused session's model.
   *
   * The value carries a `--provider` suffix because the backend parses the pair
   * out of one string. ` --session` keeps a pick scoped to this tab instead of
   * rewriting the profile default.
   */
  async setModel(
    model: string,
    provider: string,
    options: { sessionOnly?: boolean; confirmExpensive?: boolean } = {},
  ): Promise<{ deferred?: boolean; confirmRequired?: boolean; confirmMessage?: string }> {
    const runtimeId = this.state.tabs.find((t) => t.key === this.state.activeKey)?.runtimeId;
    const scope = options.sessionOnly === false ? "" : " --session";
    const result = await this.rpc<{
      confirm_required?: boolean;
      confirm_message?: string;
      deferred?: boolean;
      warning?: string;
    }>("config.set", {
      session_id: runtimeId ?? undefined,
      key: "model",
      value: `${model} --provider ${provider}${scope}`,
      ...(options.confirmExpensive ? { confirm_expensive_model: true } : {}),
    });
    if (result?.warning) this.notice(result.warning);
    return {
      deferred: result?.deferred,
      confirmRequired: result?.confirm_required,
      confirmMessage: result?.confirm_message,
    };
  }

  /** Set the reasoning level for the focused session. */
  async setReasoning(level: string): Promise<void> {
    const runtimeId = this.state.tabs.find((t) => t.key === this.state.activeKey)?.runtimeId;
    await this.rpc("config.set", {
      session_id: runtimeId ?? undefined,
      key: "reasoning",
      value: level,
      scope: "session",
    });
  }

  // ── attachments ──────────────────────────────────────────────────────────

  /**
   * Stage one file.
   *
   * The browser can only supply bytes — there is no host path to hand over — so
   * images and PDFs go through the base64 variants and everything else through
   * `file.attach`'s `data_url`. The reply's `ref_text` is what the composer
   * inserts.
   */
  async attachFile(
    file: { name: string; type: string; size: number; dataUrl: () => Promise<string> },
    id: string,
  ): Promise<Attachment> {
    const kind: AttachmentKind =
      file.type === "application/pdf" || /\.pdf$/i.test(file.name)
        ? "pdf"
        : file.type.startsWith("image/")
          ? "image"
          : "file";

    const runtimeId = await this.ensureSession();
    if (!runtimeId) throw new Error("会话尚未建立");

    const dataUrl = await file.dataUrl();
    const params: Record<string, unknown> = { session_id: runtimeId };
    if (kind === "file") {
      params.data_url = dataUrl;
      params.name = file.name;
    } else {
      params.content_base64 = dataUrl.replace(/^data:[^;]+;base64,/, "");
      params.filename = file.name;
    }

    const result = await this.rpc<{
      attached?: boolean;
      ref_text?: string;
      path?: string;
      name?: string;
    }>(attachMethodFor(kind), params);
    if (!result?.attached) throw new Error("后端未接受该附件");

    return {
      id,
      kind,
      name: result.name || file.name,
      size: file.size,
      path: result.path,
      refText: result.ref_text,
      status: "ready",
    };
  }

  /** Path / `@`-reference completions for the composer. */
  async completePath(word: string): Promise<{ text: string; display: string; meta: string }[]> {
    const runtimeId = this.state.tabs.find((t) => t.key === this.state.activeKey)?.runtimeId;
    const result = await this.rpc<{ items: { text: string; display: string; meta: string }[] }>(
      "complete.path",
      { word, session_id: runtimeId ?? undefined },
    );
    return result.items ?? [];
  }

  /** Slash completions for a `/token`. */
  async completeSlash(text: string): Promise<{
    items: { text: string; display: string; meta: string; kind?: string }[];
    replace_from?: number;
  }> {
    const runtimeId = this.state.tabs.find((t) => t.key === this.state.activeKey)?.runtimeId;
    const result = await this.rpc<{
      items: { text: string; display: string; meta: string; kind?: string }[];
      replace_from?: number;
    }>("complete.slash", { text, session_id: runtimeId ?? undefined });
    return { items: result.items ?? [], replace_from: result.replace_from };
  }

  /** The full command catalog; fetched once and filtered locally for instant menus. */
  async commandsCatalog(): Promise<unknown> {
    return this.rpc("commands.catalog", {});
  }

  // ── resync ───────────────────────────────────────────────────────────────

  /** Re-read the focused session's durable transcript after a reconnect. */
  async resync(): Promise<void> {
    const key = this.state.activeKey;
    if (!key || this.resyncing) return;
    const tab = this.state.tabs.find((t) => t.key === key);
    const sessionId = tab?.runtimeId ?? tab?.storedId;
    if (!sessionId) return;
    this.resyncing = true;
    try {
      await this.client.ensureOpen();
      const result = await this.rpc<{ messages: Parameters<typeof replaceHistory>[2] }>("session.history", {
        session_id: sessionId,
      });
      this.setState(replaceHistory(this.state, key, result.messages ?? []));
    } catch {
      // Best effort: a failed resync leaves the streamed view in place.
    } finally {
      this.resyncing = false;
    }
  }

  // ── event intake ─────────────────────────────────────────────────────────

  private handleEvent(event: GatewayEvent): void {
    if (event.type === "gateway.ready") this.dedupe.setEpoch(this.client.epoch);
    // The store decides which timeline owns the event and drops what no tab
    // owns; this method only does the connection-level bookkeeping.
    const result = routeEvent(this.state, event, this.dedupe);
    if (result.applied && result.state !== this.state) this.setState(result.state);
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

  answerRequest(card: ServerRequestCard, result: Record<string, unknown>): void {
    card.respond(result);
  }
}

/** Re-exported so the page can reduce a lone event without importing core. */
export { reduceEvent };
