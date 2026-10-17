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
import { messagesFor, normalizeLocale, type Locale } from "../core/i18n";
import { editTargetFor, retitleStoredSession } from "../core/sessions";
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
import type { TurnNotice } from "../core/notify";
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
  /**
   * Requests that arrived while the page was unmounted.
   *
   * The backend blocks on an answer (clarify waits 3600s), so refusing a request
   * that arrives mid-navigation would break the turn. Park it and replay it when
   * the page mounts again.
   */
  private pendingCards: ServerRequestCard[] = [];
  /** Desktop-notification sink (see `setNoticeSink`). */
  private noticeSink: ((notice: TurnNotice) => void) | null = null;
  /** Auth-aware REST transport, injected by the page (SDK.fetchJSON). */
  private http: ((path: string, init: RequestInit) => Promise<unknown>) | null = null;

  setHttpFetcher(fn: ((path: string, init: RequestInit) => Promise<unknown>) | null): void {
    this.http = fn;
  }
  /** Locale for controller-emitted strings (notices, errors). The page keeps it current. */
  private locale: Locale = normalizeLocale(null);

  setLocale(locale: Locale): void {
    this.locale = locale;
  }

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

  /** Cards parked while the page was unmounted, for the remounting page. */
  takeParkedCards(): ServerRequestCard[] {
    const parked = this.pendingCards;
    this.pendingCards = [];
    return parked;
  }

  setServerRequestSink(sink: ((card: ServerRequestCard) => void) | null): void {
    this.cardSink = sink;
  }

  /** Desktop-notification sink. Set by the page; absent means "notify nobody". */
  setNoticeSink(sink: ((notice: TurnNotice) => void) | null): void {
    this.noticeSink = sink;
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
  /**
   * An auth-aware REST call.
   *
   * Uses the injected `fetchJSON` (the SDK's, which carries the session token),
   * never a bare `fetch` — see AGENTS.md: a bare fetch 401s against this server.
   */
  private async fetchJSON<T = unknown>(path: string, init: { method: string; body?: unknown }): Promise<T> {
    if (!this.http) throw new Error("REST transport unavailable");
    return this.http(path, {
      method: init.method,
      headers: { "Content-Type": "application/json" },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    }) as Promise<T>;
  }

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

    // With every tab closed there is no session to attach to. The composer stays
    // live in that state (a dashboard with no chat open is not a dead input box),
    // so sending mints a session first.
    if (!this.state.activeKey) await this.newSession();

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
    if (!runtimeId) throw new Error(messagesFor(this.locale).sessionNotReady);
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
      const t = messagesFor(this.locale);
      if (status === "steered") this.notice(t.steered, "info");
      else if (status === "redirected") this.notice(t.redirected, "info");
      else if (status === "queued") this.notice(t.queued, "info");
    }
  }

  // ── per-message actions ──────────────────────────────────────────────────

  /**
   * Replace the focused turn's reply with a fresh one.
   *
   * The backend's own retry shape: a plain `session.undo` rewinds the last turn
   * WITHOUT resending it, so the caller re-submits to get a new reply. Two
   * differences from the initial send matter here:
   *
   *   - `session.undo` is destructive, so a failure is surfaced rather than
   *     swallowed; the transcript is untouched when it throws.
   *   - the re-submitted text is the ORIGINAL user text, which is what makes
   *     this a regenerate rather than a new message.
   */
  async regenerateAssistant(itemId: string): Promise<void> {
    const key = this.state.activeKey;
    if (!key) return;
    const runtimeId = await this.ensureSession();
    if (!runtimeId) throw new Error(messagesFor(this.locale).sessionNotReady);

    const timeline = timelineOf(this.state, key);
    const index = timeline.items.findIndex((entry) => entry.id === itemId);
    if (index < 0) throw new Error("找不到该回复");

    // The turn's own user row is the nearest user item above the reply.
    let prompt: string | null = null;
    for (let i = index - 1; i >= 0; i -= 1) {
      const entry = timeline.items[i];
      if (entry && entry.kind === "user") {
        prompt = entry.text;
        break;
      }
    }
    if (prompt === null) throw new Error("找不到对应的用户消息");

    // Drop the reply and everything after it, then rewind server-side.
    const kept = timeline.items.slice(0, index);
    this.setState({
      ...this.state,
      sessions: {
        ...this.state.sessions,
        [key]: { items: kept, meta: { ...timeline.meta, running: true, status: "" } },
      },
    });

    try {
      await this.client.request("session.undo", { session_id: runtimeId, intent: "retry" });
    } catch (error) {
      // Put the transcript back exactly as it was: the server kept its copy.
      this.setState({
        ...this.state,
        sessions: { ...this.state.sessions, [key]: { items: timeline.items, meta: timeline.meta } },
      });
      throw error;
    }

    const result = await this.client.request<{ status?: string; user_row_id?: number }>("prompt.submit", {
      session_id: runtimeId,
      text: prompt,
    });
    this.setState(ackUserInActive(this.state, result?.user_row_id));
  }

  /**
   * Fork the session into a new stored child, opened as a second tab.
   *
   * `count` and the idempotency key exist so a retried call returns the SAME
   * child instead of forking twice — the backend documents that as the desktop
   * client's contract, and a lost response is exactly when this is called again.
   */
  async branchSession(itemId?: string): Promise<void> {
    const key = this.state.activeKey;
    const tab = this.state.tabs.find((t) => t.key === key);
    if (!tab) return;

    const runtimeId = tab.runtimeId;
    if (!runtimeId) {
      // A draft with no live session has nothing to fork; branch the stored row.
      if (!tab.storedId) throw new Error(messagesFor(this.locale).sessionNotReady);
      const forked = await this.rpc<{ session_id: string; stored_session_id: string; title: string }>(
        "session.branch_stored",
        { parent_session_id: tab.storedId },
      );
      await this.openStoredSession(forked.stored_session_id, forked.title || tab.title);
      return;
    }

    // Branch at the assistant reply's own row when we can identify it, so the
    // child carries the history up to that message rather than the whole session.
    const items = timelineOf(this.state, key).items;
    const index = itemId ? items.findIndex((entry) => entry.id === itemId) : -1;
    let count: number | undefined;
    if (index >= 0) {
      // Count the durable rows at or before this item; the backend projects
      // `count` onto its stored history, and local-only rows have no row id.
      let rows = 0;
      for (let i = 0; i <= index; i += 1) {
        const entry = items[i];
        if (entry && "rowId" in entry && typeof entry.rowId === "number") rows += 1;
      }
      if (rows > 0) count = rows;
    }

    const forked = await this.rpc<{
      session_id: string;
      stored_session_id: string;
      title: string;
    }>("session.branch", {
      session_id: runtimeId,
      count,
      idempotency_key: `hb-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    });

    // Open the child beside the parent rather than replacing it.
    await this.openStoredSession(forked.stored_session_id, forked.title || tab.title);
  }

  // ── stored-session management ────────────────────────────────────────────

  /**
   * Delete a stored session.
   *
   * Goes through REST (`DELETE /api/sessions/{id}`), NOT `session.delete`: the
   * RPC refuses with 4023 while a session is active anywhere, and a session
   * resumed for any reason stays active for a moment. REST works on the stored
   * row regardless and is what the desktop app uses for the same verb.
   *
   * Any tab holding this session is closed first so no tab is left pointing at
   * a deleted row.
   */
  async deleteStoredSession(storedId: string): Promise<void> {
    const openTab = this.state.tabs.find((tab) => tab.storedId === storedId);

    // Close the LIVE session first, on the server. Closing the tab is only a
    // local view operation: a still-live session re-persists its row after the
    // DELETE, so the row reappears and the delete looks like a no-op (the REST
    // call even returns ok).
    if (openTab?.runtimeId) {
      // Awaiting the close is the whole guarantee: once it returns the session is
      // no longer live, so the DELETE below cannot race a re-persist. (A blind
      // sleep here was both a race and untestable.)
      try {
        await this.client.request("session.close", { session_id: openTab.runtimeId });
      } catch {
        // Best effort: the DELETE below reports the real outcome.
      }
    }
    if (openTab) this.closeSession(openTab.key);

    await this.fetchJSON(`/api/sessions/${encodeURIComponent(storedId)}`, {
      method: "DELETE",
    });

    // REST answers `{ok: true}` even when the row is still active on the gateway
    // and will simply re-persist. Confirm it is actually gone rather than
    // reporting a success that did not happen.
    const still = await this.listSessions(200);
    if (still.some((row) => row.id === storedId)) {
      throw new Error(messagesFor(this.locale).deleteRefused);
    }
  }

  /**
   * Rename a stored session.
   *
   * REST `PATCH /api/sessions/{id}` — the same call the desktop app makes.
   * `session.title` was the obvious-looking choice and it "works", but only for
   * a LIVE session: reaching a runtime id means resuming the row, which makes it
   * active and then blocks a later delete with 4023. PATCH addresses the stored
   * row directly, so renaming has no side effect on liveness.
   */
  async renameStoredSession(storedId: string, title: string): Promise<string> {
    const next = title.trim();
    if (!next) throw new Error(messagesFor(this.locale).titleRequired);

    const result = await this.fetchJSON<{ ok?: boolean; title?: string }>(
      `/api/sessions/${encodeURIComponent(storedId)}`,
      { method: "PATCH", body: { title: next } },
    );
    const finalTitle = result?.title || next;

    this.setState({ ...this.state, tabs: retitleStoredSession(this.state.tabs, storedId, finalTitle) });
    return finalTitle;
  }

  /**
   * Edit an already-sent message and continue from there.
   *
   * The desktop app's shape: interrupt whatever is running, then submit the
   * corrected text with `truncate_before_row_id` + `confirm_truncate` so the
   * backend drops that turn and everything after it. A target without a durable
   * row id is refused rather than sent as a cut the gateway would reject.
   */
  async editAndResend(itemId: string, text: string): Promise<void> {
    const key = this.state.activeKey;
    if (!key) return;
    const next = text.trim();
    if (!next) return;

    const runtimeId = await this.ensureSession();
    if (!runtimeId) throw new Error(messagesFor(this.locale).sessionNotReady);

    const timeline = timelineOf(this.state, key);
    const target = editTargetFor(
      timeline.items as { kind: string; id: string; text?: string; rowId?: number }[],
      itemId,
    );
    if (!target) throw new Error(messagesFor(this.locale).editUnavailable);
    if (target.rowId === null) throw new Error(messagesFor(this.locale).editNoAnchor);

    // Whatever is running would fight the truncation.
    if (timeline.meta.running) {
      try {
        await this.client.request("session.interrupt", { session_id: runtimeId });
      } catch {
        // Best effort; the submit is gated server-side either way.
      }
    }

    const cutIndex = timeline.items.findIndex((item) => item.id === itemId);
    const kept = timeline.items.slice(0, cutIndex);
    this.setState({
      ...this.state,
      sessions: {
        ...this.state.sessions,
        [key]: { items: kept, meta: { ...timeline.meta, running: true, status: "" } },
      },
    });
    this.setState(appendUserToActive(this.state, next));

    try {
      const result = await this.client.request<{ status?: string; user_row_id?: number }>("prompt.submit", {
        session_id: runtimeId,
        text: next,
        truncate_before_row_id: target.rowId,
        confirm_truncate: true,
        // Only meaningful when the cut empties the transcript; the gateway
        // ignores it for a non-empty prefix.
        ...(kept.length === 0 ? { confirm_empty_truncate: true } : {}),
        // A cut of more than one user turn is a deep truncate on newer gateways.
        ...(target.userTurnsRemoved > 1 ? { confirm_deep_truncate: true } : {}),
      });
      this.setState(ackUserInActive(this.state, result?.user_row_id));
    } catch (error) {
      // The server kept its copy; put the transcript back.
      this.setState({
        ...this.state,
        sessions: { ...this.state.sessions, [key]: { items: timeline.items, meta: timeline.meta } },
      });
      throw error;
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
    if (!runtimeId) throw new Error(messagesFor(this.locale).sessionNotReady);

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
    if (result.applied && result.state !== this.state) {
      this.setState(result.state);
      this.announce(event, result.state);
    }
  }

  /**
   * Tell the page a turn ended, so it can decide whether to ring the desktop.
   *
   * The text is taken from the timeline rather than the frame: `message.complete`
   * often carries an empty `text` because the reply already streamed, and a
   * notification whose body is blank is worse than none.
   */
  private announce(event: GatewayEvent, state: MultiState): void {
    if (!this.noticeSink) return;
    if (event.type !== "message.complete" && event.type !== "error") return;
    const key = event.session_id
      ? (state.tabs.find((tab) => tab.runtimeId === event.session_id)?.key ?? null)
      : state.activeKey;
    if (!key) return;
    const timeline = state.sessions[key];
    if (!timeline) return;
    const p = event.payload ?? {};
    const textOf = (value: unknown): string => (typeof value === "string" ? value : "");
    let fallback = "";
    for (let i = timeline.items.length - 1; i >= 0; i -= 1) {
      const item = timeline.items[i];
      if (item?.kind === "assistant") {
        fallback = item.text;
        break;
      }
    }
    const error =
      event.type === "error"
        ? textOf(p.message) || "error"
        : textOf(p.error) || textOf(p.failure_reason) || undefined;
    this.noticeSink({
      kind: "complete",
      sessionKey: key,
      title: timeline.meta.title,
      text: textOf(p.text) || fallback,
      error,
    });
  }

  private handleServerRequest(request: ServerRequest): boolean {
    if (!HANDLED_REQUESTS.has(request.method)) return false;
    const card: ServerRequestCard = {
      id: request.id,
      method: request.method,
      params: request.params,
      respond: request.respond,
      fail: request.fail,
    };
    // Announce before parking: a request that arrives while the page is unmounted
    // still needs the human, and that is exactly the case the window is not on.
    this.noticeSink?.({
      kind: "request",
      method: request.method as "approval" | "clarify",
      params: request.params,
      requestId: request.id,
      sessionKey: typeof request.params.session_id === "string" ? request.params.session_id : "",
      title: "",
      text: "",
    });
    if (!this.cardSink) {
      // Between mounts (the user switched dashboard tabs). Park it rather than
      // letting the channel fail it with -32601: this client IS going to answer.
      this.pendingCards.push(card);
      return true;
    }
    this.cardSink(card);
    return true;
  }

  answerRequest(card: ServerRequestCard, result: Record<string, unknown>): void {
    card.respond(result);
  }
}

/** Re-exported so the page can reduce a lone event without importing core. */
export { reduceEvent };
