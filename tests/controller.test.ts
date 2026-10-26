import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ChatController } from "../src/app/controller";
import { messagesFor } from "../src/core/i18n";
import type { TurnNotice } from "../src/core/notify";
import { activeTimeline, timelineOf } from "../src/core/sessions";

/**
 * A scriptable stand-in for the browser WebSocket. The controller only uses
 * `onopen` / `onmessage` / `onclose` / `onerror` / `send` / `close` /
 * `readyState`, so this is the whole surface it needs.
 */
class FakeSocket {
  static instances: FakeSocket[] = [];
  readonly sent: string[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((message: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }

  send(text: string): void {
    this.sent.push(text);
  }

  close(): void {
    this.readyState = 3;
  }

  frames(): Record<string, unknown>[] {
    return this.sent.map((line) => JSON.parse(line) as Record<string, unknown>);
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  deliver(frame: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }

  /**
   * Reply to the most recent outbound request with the given method.
   *
   * "Most recent" matters: a second `session.create` would otherwise be answered
   * on the first one's id and the new request would hang.
   */
  replyTo(method: string, result: unknown): void {
    const frames = this.frames().filter((f) => f.method === method);
    const frame = frames.at(-1);
    this.deliver({ jsonrpc: "2.0", id: frame?.id, result });
  }

  /** Reply to the Nth outbound request (0-based). */
  reply(index: number, result: unknown): void {
    const frame = this.frames()[index];
    this.deliver({ jsonrpc: "2.0", id: frame?.id, result });
  }

  /** Answer the last request of `method` with a JSON-RPC error. */
  replyError(method: string, code: number, message: string): void {
    const frames = this.frames().filter((f) => f.method === method);
    const frame = frames.at(-1);
    this.deliver({ jsonrpc: "2.0", id: frame?.id, error: { code, message } });
  }

  event(type: string, payload?: Record<string, unknown>, extra: Record<string, unknown> = {}): void {
    this.deliver({ jsonrpc: "2.0", method: "event", params: { type, payload, ...extra } });
  }
}

function makeController(overrides: Partial<ConstructorParameters<typeof ChatController>[0]> = {}) {
  return new ChatController({
    urlProvider: async () => "ws://127.0.0.1:9119/api/ws?token=t",
    socketFactory: (url) => new FakeSocket(url) as unknown as WebSocket,
    ...overrides,
  });
}

/** `connect()` awaits the async URL provider before it builds a socket. */
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

async function connectAndOpen(
  overrides: Partial<ConstructorParameters<typeof ChatController>[0]> = {},
): Promise<{ controller: ChatController; socket: FakeSocket }> {
  const controller = makeController(overrides);
  void controller.start().catch(() => undefined);
  await tick();
  const socket = FakeSocket.instances.at(-1) as FakeSocket;
  socket.open();
  socket.event("gateway.ready", { heartbeat: false, replay_epoch: "epoch-1" });
  await tick();
  // `start()` creates a draft then mints a session; answer it.
  if (socket.frames().some((f) => f.method === "session.create")) {
    socket.replyTo("session.create", {
      session_id: "runtime-1",
      stored_session_id: "20261016_120000_abc",
      messages: [],
      info: { model: "m", provider: "p", running: false },
    });
  }
  await tick();
  await tick();
  return { controller, socket };
}

beforeEach(() => {
  FakeSocket.instances = [];
});

afterEach(() => {
  vi.useRealTimers();
});

describe("connection", () => {
  it("connects, opens a draft and mints a session", async () => {
    const { controller } = await connectAndOpen();
    expect(controller.getSnapshot().tabs).toHaveLength(1);
    expect(controller.getSnapshot().activeKey).toBe("runtime-1");
    expect(controller.getConnection().state).toBe("open");
  });

  it("marks the session connected once gateway.ready arrives", async () => {
    const { controller } = await connectAndOpen();
    expect(activeTimeline(controller.getSnapshot()).meta.connected).toBe(true);
  });

  it("waits for the socket before creating the session (connect race)", async () => {
    const controller = makeController();
    void controller.start().catch(() => undefined);
    await tick();
    const socket = FakeSocket.instances.at(-1) as FakeSocket;
    socket.open();
    socket.event("gateway.ready", { heartbeat: false, replay_epoch: "e" });
    await tick();
    // The create must be on the wire only after the socket exists.
    expect(socket.frames().some((f) => f.method === "session.create")).toBe(true);
    expect(controller.getConnection().state).toBe("open");
  });

  it("stops retrying on an auth refusal (4401) instead of hammering the socket", async () => {
    const { controller, socket } = await connectAndOpen();
    socket.onclose?.({ code: 4401 });
    expect(controller.getConnection().state).toBe("error");
    expect(controller.getConnection().detail).toBe(messagesFor("en").connectUnauthorized);
  });

  it("stops retrying when chat is disabled on this dashboard (4403)", async () => {
    const { controller, socket } = await connectAndOpen();
    socket.onclose?.({ code: 4403 });
    expect(controller.getConnection().detail).toBe(messagesFor("en").connectChatDisabled);
  });

  it("reconnects after an ordinary drop", async () => {
    const { controller, socket } = await connectAndOpen();
    vi.useFakeTimers();
    try {
      socket.onclose?.({ code: 1006 });
      expect(activeTimeline(controller.getSnapshot()).meta.connected).toBe(false);
      await vi.advanceTimersByTimeAsync(600);
      await vi.advanceTimersByTimeAsync(0);
      const next = FakeSocket.instances.at(-1) as FakeSocket;
      expect(next).not.toBe(socket);
      next.open();
      next.event("gateway.ready", { heartbeat: false, replay_epoch: "epoch-1" });
      expect(controller.getConnection().state).toBe("open");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("sending", () => {
  it("appends the user bubble optimistically and binds the row id on ack", async () => {
    const { controller, socket } = await connectAndOpen();
    const sending = controller.send("你好");
    await tick();
    socket.replyTo("prompt.submit", { status: "streaming", user_row_id: 12 });
    await sending;

    expect(activeTimeline(controller.getSnapshot()).items[0]).toMatchObject({
      kind: "user",
      text: "你好",
      pending: false,
      rowId: 12,
    });
  });

  it("ignores an empty send", async () => {
    const { controller, socket } = await connectAndOpen();
    await controller.send("   ");
    expect(socket.frames().some((f) => f.method === "prompt.submit")).toBe(false);
  });

  it("settles the timeline when interrupted even if the RPC fails", async () => {
    const { controller, socket } = await connectAndOpen();
    const sending = controller.send("跑个长任务");
    await tick();
    socket.replyTo("prompt.submit", { status: "streaming" });
    await sending;
    socket.event("message.start", undefined, { session_id: "runtime-1", seq: 1 });
    socket.event("message.delta", { text: "开始" }, { session_id: "runtime-1", seq: 2 });

    const stopping = controller.interrupt();
    await tick();
    const id = socket.frames().find((f) => f.method === "session.interrupt")?.id;
    socket.deliver({ jsonrpc: "2.0", id, error: { code: -32000, message: "nope" } });
    await stopping;

    expect(activeTimeline(controller.getSnapshot()).meta.running).toBe(false);
    expect(activeTimeline(controller.getSnapshot()).items.at(-1)).toMatchObject({ streaming: false });
  });
});

describe("event routing", () => {
  it("renders a streamed reply end to end", async () => {
    const { controller, socket } = await connectAndOpen();
    socket.event("message.start", undefined, { session_id: "runtime-1", seq: 1 });
    socket.event("message.delta", { text: "你" }, { session_id: "runtime-1", seq: 2 });
    socket.event("message.delta", { text: "好" }, { session_id: "runtime-1", seq: 3 });
    socket.event("message.complete", { text: "", status: "complete" }, { session_id: "runtime-1", seq: 4 });

    const items = activeTimeline(controller.getSnapshot()).items;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "assistant", text: "你好", streaming: false });
  });

  it("drops the fan-out copy of a delta", async () => {
    const { controller, socket } = await connectAndOpen();
    const extra = { session_id: "runtime-1", seq: 5 };
    socket.event("message.delta", { text: "只出现一次" }, extra);
    socket.event("message.delta", { text: "只出现一次" }, extra);
    expect(activeTimeline(controller.getSnapshot()).items[0]).toMatchObject({ text: "只出现一次" });
  });

  it("ignores an event for a session no tab owns", async () => {
    const { controller, socket } = await connectAndOpen();
    socket.event("message.delta", { text: "别的窗口" }, { session_id: "runtime-other", seq: 1 });
    expect(activeTimeline(controller.getSnapshot()).items).toHaveLength(0);
  });

  it("renders session-less broadcasts", async () => {
    const { controller, socket } = await connectAndOpen();
    socket.event("status.update", { kind: "compacting", text: "压缩中…" });
    expect(activeTimeline(controller.getSnapshot()).meta.status).toBe("压缩中…");
  });

  it("adopts a new epoch so a backend restart does not look like a replay", async () => {
    const { controller, socket } = await connectAndOpen();
    socket.event("message.delta", { text: "a" }, { session_id: "runtime-1", seq: 9 });
    socket.event("gateway.ready", { heartbeat: false, replay_epoch: "epoch-2" });
    socket.event("message.delta", { text: "b" }, { session_id: "runtime-1", seq: 9 });
    expect(activeTimeline(controller.getSnapshot()).items[0]).toMatchObject({ text: "ab" });
  });

  it("carries reasoning_effort from session.info into the meta", async () => {
    const { controller, socket } = await connectAndOpen();
    socket.event("session.info", { model: "m2", provider: "p2", reasoning_effort: "high", running: false });
    expect(activeTimeline(controller.getSnapshot()).meta).toMatchObject({
      model: "m2",
      reasoningEffort: "high",
    });
  });

  it("retitles the tab as soon as auto-titling emits session.title", async () => {
    const { controller, socket } = await connectAndOpen();
    expect(controller.getSnapshot().tabs[0]?.title).toBe("");

    socket.event("session.title", { title: "混音导出报错" }, { session_id: "runtime-1", seq: 1 });

    // The strip reads `tab.title`; the timeline's meta is not enough.
    expect(controller.getSnapshot().tabs[0]?.title).toBe("混音导出报错");
    expect(activeTimeline(controller.getSnapshot()).meta.title).toBe("混音导出报错");
  });
});

describe("multi-session", () => {
  it("opens a second tab with its own timeline and session", async () => {
    const { controller, socket } = await connectAndOpen();
    const opening = controller.newSession();
    await tick();
    socket.replyTo("session.create", { session_id: "runtime-2", messages: [], info: {} });
    await opening;

    const state = controller.getSnapshot();
    expect(state.tabs).toHaveLength(2);
    expect(state.activeKey).toBe("runtime-2");
    expect(Object.keys(state.sessions).sort()).toEqual(["runtime-1", "runtime-2"]);
  });

  it("routes each session's events to its own tab", async () => {
    const { controller, socket } = await connectAndOpen();
    const opening = controller.newSession();
    await tick();
    socket.replyTo("session.create", { session_id: "runtime-2", messages: [], info: {} });
    await opening;

    socket.event("message.delta", { text: "给第二个" }, { session_id: "runtime-2", seq: 1 });
    const state = controller.getSnapshot();
    expect(timelineOf(state, "runtime-2").items).toHaveLength(1);
    expect(timelineOf(state, "runtime-1").items).toHaveLength(0);
  });

  it("switching focus changes which transcript is active without losing the other", async () => {
    const { controller, socket } = await connectAndOpen();
    const opening = controller.newSession();
    await tick();
    socket.replyTo("session.create", { session_id: "runtime-2", messages: [], info: {} });
    await opening;

    socket.event("message.delta", { text: "第二个的" }, { session_id: "runtime-2", seq: 1 });
    controller.focusSession("runtime-1");
    expect(activeTimeline(controller.getSnapshot()).items).toHaveLength(0);
    controller.focusSession("runtime-2");
    expect(activeTimeline(controller.getSnapshot()).items[0]).toMatchObject({ text: "第二个的" });
  });

  it("closing a tab removes its timeline", async () => {
    const { controller, socket } = await connectAndOpen();
    const opening = controller.newSession();
    await tick();
    socket.replyTo("session.create", { session_id: "runtime-2", messages: [], info: {} });
    await opening;

    controller.closeSession("runtime-2");
    const state = controller.getSnapshot();
    expect(state.tabs).toHaveLength(1);
    expect(state.sessions["runtime-2"]).toBeUndefined();
    expect(state.activeKey).toBe("runtime-1");
  });

  it("opening a stored session resumes it and binds the snapshot", async () => {
    const { controller, socket } = await connectAndOpen();
    const opening = controller.openStoredSession("20261015_old", "旧对话");
    await tick();
    socket.replyTo("session.resume", {
      session_id: "runtime-old",
      stored_session_id: "20261015_old",
      messages: [{ role: "user", text: "以前说的话" }],
      info: { model: "m", provider: "p", title: "旧对话" },
    });
    await opening;

    const state = controller.getSnapshot();
    expect(state.activeKey).toBe("runtime-old");
    expect(timelineOf(state, "runtime-old").items[0]).toMatchObject({ text: "以前说的话" });
  });
});

describe("slash commands", () => {
  it("routes a leading slash to command.dispatch instead of prompt.submit", async () => {
    const { controller, socket } = await connectAndOpen();
    const running = controller.send("/help");
    await tick();
    expect(socket.frames().some((f) => f.method === "command.dispatch")).toBe(true);
    expect(socket.frames().some((f) => f.method === "prompt.submit")).toBe(false);

    socket.replyTo("command.dispatch", { type: "exec", output: "帮助内容" });
    await running;
    expect(activeTimeline(controller.getSnapshot()).items.at(-1)).toMatchObject({
      kind: "notice",
      text: "帮助内容",
    });
  });

  it("sends the argument along with the command name", async () => {
    const { controller, socket } = await connectAndOpen();
    const running = controller.send("/model gpt-4 --provider openai");
    await tick();
    const frame = socket.frames().find((f) => f.method === "command.dispatch");
    expect(frame).toMatchObject({ params: { name: "model", arg: "gpt-4 --provider openai" } });
    socket.replyTo("command.dispatch", { type: "exec", output: "ok" });
    await running;
  });

  it("turns a send directive into a normal prompt with the display form", async () => {
    const { controller, socket } = await connectAndOpen();
    const running = controller.send("/review");
    await tick();
    socket.replyTo("command.dispatch", { type: "send", message: "<expanded>", display: "/review" });
    await tick();
    const submit = socket.frames().find((f) => f.method === "prompt.submit");
    expect(submit).toMatchObject({ params: { text: "<expanded>" } });
    socket.replyTo("prompt.submit", { status: "streaming" });
    await running;

    // The user sees the command they typed, not the expanded body.
    expect(activeTimeline(controller.getSnapshot()).items[0]).toMatchObject({ kind: "user", text: "/review" });
  });

  it("follows an alias to its target command", async () => {
    const { controller, socket } = await connectAndOpen();
    const running = controller.send("/h");
    await tick();
    socket.replyTo("command.dispatch", { type: "alias", target: "/help" });
    await tick();
    const calls = socket.frames().filter((f) => f.method === "command.dispatch");
    expect(calls).toHaveLength(2);
    expect(calls[1]).toMatchObject({ params: { name: "help" } });
    socket.replyTo("command.dispatch", { type: "exec", output: "帮助" });
    await running;
  });

  it("surfaces an unrecognised dispatch shape as an error notice", async () => {
    const { controller, socket } = await connectAndOpen();
    const running = controller.send("/weird");
    await tick();
    socket.replyTo("command.dispatch", { type: "nonsense" });
    await running;
    expect(activeTimeline(controller.getSnapshot()).items.at(-1)).toMatchObject({
      kind: "notice",
      tone: "error",
    });
  });

  it("surfaces a failed dispatch RPC as an error notice", async () => {
    const { controller, socket } = await connectAndOpen();
    const running = controller.send("/boom");
    await tick();
    const id = socket.frames().find((f) => f.method === "command.dispatch")?.id;
    socket.deliver({ jsonrpc: "2.0", id, error: { code: -32000, message: "命令不可用" } });
    await running;
    expect(activeTimeline(controller.getSnapshot()).items.at(-1)).toMatchObject({
      kind: "notice",
      text: "命令不可用",
      tone: "error",
    });
  });
});

describe("model & reasoning", () => {
  it("sends a session-scoped model switch with the provider suffix", async () => {
    const { controller, socket } = await connectAndOpen();
    const switching = controller.setModel("gpt-4", "openai", { sessionOnly: true });
    await tick();
    const frame = socket.frames().find((f) => f.method === "config.set");
    expect(frame).toMatchObject({
      params: { key: "model", value: "gpt-4 --provider openai --session", session_id: "runtime-1" },
    });
    socket.replyTo("config.set", { key: "model", value: "gpt-4" });
    await switching;
  });

  it("reports a deferred switch instead of pretending it landed", async () => {
    const { controller, socket } = await connectAndOpen();
    const switching = controller.setModel("gpt-4", "openai");
    await tick();
    socket.replyTo("config.set", { key: "model", value: "gpt-4", deferred: true });
    const result = await switching;
    expect(result.deferred).toBe(true);
  });

  it("reports a confirm-required switch", async () => {
    const { controller, socket } = await connectAndOpen();
    const switching = controller.setModel("pricey", "openai");
    await tick();
    socket.replyTo("config.set", {
      key: "model",
      confirm_required: true,
      confirm_message: "很贵",
    });
    const result = await switching;
    expect(result.confirmRequired).toBe(true);
    expect(result.confirmMessage).toBe("很贵");
  });

  it("keeps a confirm-required message out of the transcript", async () => {
    // The reply applied NOTHING, so the message has to reach the user through a
    // dialog with an accept control. As a notice it was a dead end: the switch
    // stayed unapplied and there was no way to say yes. The gateway repeats the
    // same text in `warning`, so a notice would also print it twice.
    const { controller, socket } = await connectAndOpen();
    const before = activeTimeline(controller.getSnapshot()).items.length;
    const switching = controller.setModel("pricey", "openai");
    await tick();
    socket.replyTo("config.set", {
      key: "model",
      warning: "很贵",
      confirm_required: true,
      confirm_message: "很贵",
    });
    const result = await switching;
    expect(result.confirmRequired).toBe(true);
    expect(activeTimeline(controller.getSnapshot()).items.length).toBe(before);
  });

  it("re-sends the accepted pick with confirm_expensive_model", async () => {
    // The flag name says "expensive", but the gateway treats it as the generic
    // "the user said yes" marker for every selection guard (cost, data policy,
    // and the large-live-context case this dialog exists for).
    const { controller, socket } = await connectAndOpen();
    const switching = controller.setModel("pricey", "openai", {
      sessionOnly: true,
      confirmExpensive: true,
    });
    await tick();
    expect(socket.frames().find((f) => f.method === "config.set")).toMatchObject({
      params: {
        key: "model",
        value: "pricey --provider openai --session",
        confirm_expensive_model: true,
      },
    });
    socket.replyTo("config.set", { key: "model", value: "pricey" });
    expect((await switching).confirmRequired).toBe(false);
  });

  it("sends a session-scoped reasoning level", async () => {
    const { controller, socket } = await connectAndOpen();
    const setting = controller.setReasoning("high");
    await tick();
    expect(socket.frames().find((f) => f.method === "config.set")).toMatchObject({
      params: { key: "reasoning", value: "high", scope: "session" },
    });
    socket.replyTo("config.set", { key: "reasoning", value: "high" });
    await setting;
  });

  it("reads and writes the profile-wide approval mode", async () => {
    const { controller, socket } = await connectAndOpen();
    const reading = controller.getApprovalMode();
    await tick();
    expect(socket.frames().find((f) => f.method === "config.get")).toMatchObject({
      params: { key: "approvals.mode" },
    });
    socket.replyTo("config.get", { key: "approvals.mode", value: "smart" });
    await expect(reading).resolves.toBe("smart");

    const writing = controller.setApprovalMode("off");
    await tick();
    // No session id and no scope: approval mode is profile config, not per-session.
    expect(socket.frames().find((f) => f.method === "config.set")).toMatchObject({
      params: { key: "approvals.mode", value: "off" },
    });
    socket.replyTo("config.set", { key: "approvals.mode", value: "off" });
    await writing;
  });

  it("returns the model inventory", async () => {
    const { controller, socket } = await connectAndOpen();
    const listing = controller.listModels();
    await tick();
    socket.replyTo("model.options", {
      providers: [{ slug: "openai", name: "OpenAI", models: ["gpt-4"] }],
      model: "gpt-4",
      provider: "openai",
    });
    const result = await listing;
    expect(result.providers).toHaveLength(1);
    expect(result.model).toBe("gpt-4");
  });
});

describe("attachments", () => {
  it("stages a file through file.attach with a data URL", async () => {
    const { controller, socket } = await connectAndOpen();
    const staging = controller.attachFile(
      { name: "notes.txt", type: "text/plain", size: 10, dataUrl: async () => "data:text/plain;base64,aGk=" },
      "att-1",
    );
    await tick();
    const frame = socket.frames().find((f) => f.method === "file.attach");
    expect(frame).toMatchObject({ params: { data_url: "data:text/plain;base64,aGk=", name: "notes.txt" } });
    socket.replyTo("file.attach", { attached: true, name: "notes.txt", ref_text: "@file:notes.txt" });
    const result = await staging;
    expect(result).toMatchObject({ status: "ready", refText: "@file:notes.txt" });
  });

  it("stages an image through image.attach_bytes with the base64 body only", async () => {
    const { controller, socket } = await connectAndOpen();
    const staging = controller.attachFile(
      { name: "shot.png", type: "image/png", size: 10, dataUrl: async () => "data:image/png;base64,QUJD" },
      "att-2",
    );
    await tick();
    const frame = socket.frames().find((f) => f.method === "image.attach_bytes");
    expect(frame).toMatchObject({ params: { content_base64: "QUJD", filename: "shot.png" } });
    socket.replyTo("image.attach_bytes", { attached: true, name: "shot.png", path: "/tmp/shot.png" });
    const result = await staging;
    expect(result.kind).toBe("image");
  });

  it("routes a PDF to pdf.attach", async () => {
    const { controller, socket } = await connectAndOpen();
    const staging = controller.attachFile(
      { name: "doc.pdf", type: "application/pdf", size: 10, dataUrl: async () => "data:application/pdf;base64,QUJD" },
      "att-3",
    );
    await tick();
    expect(socket.frames().some((f) => f.method === "pdf.attach")).toBe(true);
    socket.replyTo("pdf.attach", { attached: true, name: "doc.pdf" });
    await staging;
  });

  it("throws when the backend rejects the attachment", async () => {
    const { controller, socket } = await connectAndOpen();
    const staging = controller.attachFile(
      { name: "x.txt", type: "text/plain", size: 1, dataUrl: async () => "data:text/plain;base64,QQ==" },
      "att-4",
    );
    await tick();
    socket.replyTo("file.attach", { attached: false });
    await expect(staging).rejects.toThrow(messagesFor("en").attachmentNotAccepted);
  });
});

describe("completions", () => {
  it("returns slash completions", async () => {
    const { controller, socket } = await connectAndOpen();
    const asking = controller.completeSlash("/he");
    await tick();
    expect(socket.frames().find((f) => f.method === "complete.slash")).toMatchObject({
      params: { text: "/he", session_id: "runtime-1" },
    });
    socket.replyTo("complete.slash", { items: [{ text: "/help", display: "帮助", kind: "command" }], replace_from: 0 });
    const result = await asking;
    expect(result.items).toHaveLength(1);
  });

  it("returns path completions", async () => {
    const { controller, socket } = await connectAndOpen();
    const asking = controller.completePath("src/");
    await tick();
    socket.replyTo("complete.path", { items: [{ text: "src/main.ts", display: "main.ts", meta: "" }] });
    expect((await asking)[0]).toMatchObject({ text: "src/main.ts" });
  });

  it("returns the command catalog", async () => {
    const { controller, socket } = await connectAndOpen();
    const asking = controller.commandsCatalog();
    await tick();
    socket.replyTo("commands.catalog", { pairs: [["help", "帮助"]] });
    expect(await asking).toMatchObject({ pairs: [["help", "帮助"]] });
  });
});

describe("server requests", () => {
  it("hands approval cards to the page and answers through the request", async () => {
    const cards: { method: string; respond: (r: Record<string, unknown>) => void }[] = [];
    const { socket } = await connectAndOpen({ onServerRequest: (card) => cards.push(card) });

    socket.deliver({
      jsonrpc: "2.0",
      id: "req-1",
      method: "approval",
      params: { session_id: "s", request_id: "r", command: "rm -rf /", choices: ["once", "deny"] },
    });

    expect(cards).toHaveLength(1);
    cards[0]?.respond({ choice: "deny" });
    expect(socket.frames().at(-1)).toEqual({ jsonrpc: "2.0", id: "req-1", result: { choice: "deny" } });
  });

  it("declines requests the page cannot render, so the backend fails fast", async () => {
    const { socket } = await connectAndOpen();
    socket.deliver({ jsonrpc: "2.0", id: "req-2", method: "vault.unlock_prompt", params: {} });
    expect(socket.frames().at(-1)).toMatchObject({ id: "req-2", error: { code: -32601 } });
  });
});

describe("resync", () => {
  it("replaces the transcript with the durable one when no turn is live", async () => {
    const { controller, socket } = await connectAndOpen();
    socket.event("message.delta", { text: "本地" }, { session_id: "runtime-1", seq: 1 });
    socket.event("message.complete", { text: "", status: "complete" }, { session_id: "runtime-1", seq: 2 });

    const resyncing = controller.resync();
    await tick();
    socket.replyTo("session.history", {
      count: 2,
      messages: [
        { role: "user", text: "历史提问" },
        { role: "assistant", text: "历史回答" },
      ],
    });
    await resyncing;

    expect(activeTimeline(controller.getSnapshot()).items.map((i) => (i as { text: string }).text)).toEqual([
      "历史提问",
      "历史回答",
    ]);
  });
});

describe("subscription", () => {
  it("notifies subscribers on change and stops after unsubscribe", async () => {
    const { controller, socket } = await connectAndOpen();
    const listener = vi.fn();
    const unsubscribe = controller.subscribe(listener);
    socket.event("message.delta", { text: "x" }, { session_id: "runtime-1", seq: 1 });
    expect(listener).toHaveBeenCalled();
    unsubscribe();
    const before = listener.mock.calls.length;
    socket.event("message.delta", { text: "y" }, { session_id: "runtime-1", seq: 2 });
    expect(listener.mock.calls.length).toBe(before);
  });

  it("returns a stable snapshot between changes (React requirement)", async () => {
    const { controller } = await connectAndOpen();
    expect(controller.getSnapshot()).toBe(controller.getSnapshot());
  });
});

describe("per-message actions", () => {
  /** Seed a finished turn: one user row plus the reply that answered it. */
  async function withFinishedTurn() {
    const { controller, socket } = await connectAndOpen();
    // Not awaited: `send` resolves only once prompt.submit is answered.
    const sent = controller.send("原始问题");
    await tick();
    socket.replyTo("prompt.submit", { user_row_id: 7 });
    await sent;
    socket.event("message.delta", { text: "第一版回复" });
    socket.event("message.complete", { status: "ok", text: "第一版回复" });
    await tick();
    return { controller, socket };
  }

  const assistantId = (controller: ChatController) =>
    activeTimeline(controller.getSnapshot()).items.find((i) => i.kind === "assistant" && !i.streaming)?.id ?? "";

  it("regenerate rewinds the turn and re-submits the ORIGINAL user text", async () => {
    const { controller, socket } = await withFinishedTurn();
    const target = assistantId(controller);

    const done = controller.regenerateAssistant(target);
    await tick();
    // The undo must land before the resend, or the backend sees a second turn.
    socket.replyTo("session.undo", { removed: 2 });
    await tick();
    await tick();
    socket.replyTo("prompt.submit", { user_row_id: 8 });
    await done;

    const methods = socket.frames().map((f) => f.method);
    expect(methods).toContain("session.undo");
    expect(methods.indexOf("session.undo")).toBeLessThan(methods.lastIndexOf("prompt.submit"));

    const undo = socket.frames().find((f) => f.method === "session.undo");
    // `retry` is what makes this a regenerate rather than a destructive undo.
    expect((undo?.params as Record<string, unknown>).intent).toBe("retry");

    const resend = socket.frames().filter((f) => f.method === "prompt.submit").at(-1);
    expect((resend?.params as Record<string, unknown>).text).toBe("原始问题");
  });

  it("regenerate drops the old reply from the transcript", async () => {
    const { controller, socket } = await withFinishedTurn();
    const target = assistantId(controller);
    const before = activeTimeline(controller.getSnapshot()).items.length;

    const done = controller.regenerateAssistant(target);
    await tick();
    socket.replyTo("session.undo", { removed: 2 });
    await tick();
    await tick();
    socket.replyTo("prompt.submit", { user_row_id: 8 });
    await done;

    const after = activeTimeline(controller.getSnapshot());
    expect(after.items.length).toBeLessThan(before);
    expect(after.items.some((i) => i.kind === "assistant")).toBe(false);
    expect(after.meta.running).toBe(true);
  });

  it("regenerate restores the transcript when the rewind fails", async () => {
    const { controller, socket } = await withFinishedTurn();
    const target = assistantId(controller);
    const snapshot = activeTimeline(controller.getSnapshot()).items.map((i) => i.id);

    const promise = controller.regenerateAssistant(target);
    await tick();
    // Reject the undo: nothing was rewound server-side, so nothing may be lost.
    const frame = socket.frames().filter((f) => f.method === "session.undo").at(-1);
    socket.deliver({ jsonrpc: "2.0", id: frame?.id, error: { code: -1, message: "no such turn" } });

    await expect(promise).rejects.toBeTruthy();
    expect(activeTimeline(controller.getSnapshot()).items.map((i) => i.id)).toEqual(snapshot);
  });

  it("regenerate refuses a turn with no user message to resend", async () => {
    const { controller } = await connectAndOpen();
    // An item id that does not exist cannot be traced back to a prompt.
    await expect(controller.regenerateAssistant("assistant-does-not-exist")).rejects.toThrow();
  });

  it("branch forks the live session and opens the child as a new tab", async () => {
    const { controller, socket } = await withFinishedTurn();
    const target = assistantId(controller);
    const tabsBefore = controller.getSnapshot().tabs.length;

    const done = controller.branchSession(target);
    await tick();
    socket.replyTo("session.branch", {
      session_id: "runtime-2",
      stored_session_id: "20261017_000000_child",
      title: "分叉",
    });
    await tick();
    await tick();
    // openStoredSession resumes the child, which mints its own live session.
    if (socket.frames().some((f) => f.method === "session.resume")) {
      socket.replyTo("session.resume", {
        session_id: "runtime-2b",
        stored_session_id: "20261017_000000_child",
        messages: [],
        info: { model: "m", provider: "p", running: false },
      });
    }
    await tick();
    await done;

    const branch = socket.frames().find((f) => f.method === "session.branch");
    expect(branch).toBeTruthy();
    // A stable idempotency key is what stops a retried branch forking twice.
    expect(typeof (branch?.params as Record<string, unknown>).idempotency_key).toBe("string");
    expect(controller.getSnapshot().tabs.length).toBeGreaterThanOrEqual(tabsBefore);
  });

  it("branch carries a message count so the child stops at that reply", async () => {
    const { controller, socket } = await withFinishedTurn();
    const target = assistantId(controller);
    const done = controller.branchSession(target);
    await tick();
    socket.replyTo("session.branch", { session_id: "r2", stored_session_id: "s2", title: "t" });
    await tick();
    await tick();
    if (socket.frames().some((f) => f.method === "session.resume")) {
      socket.replyTo("session.resume", {
        session_id: "r2b",
        stored_session_id: "s2",
        messages: [],
        info: { model: "m", provider: "p", running: false },
      });
    }
    await tick();
    await done;
    const branch = socket.frames().find((f) => f.method === "session.branch");
    expect((branch?.params as Record<string, unknown>).count).toBeGreaterThan(0);
  });
});

describe("locale", () => {
  it("localizes controller-emitted notices", async () => {
    const { controller, socket } = await connectAndOpen();
    controller.setLocale("en");
    // The steering notice is about a MID-TURN send, so a turn must be running.
    socket.event("message.start", {});
    await tick();
    const sent = controller.send("hi");
    await tick();
    socket.replyTo("prompt.submit", { status: "steered", user_row_id: 1 });
    await sent;

    const notice = activeTimeline(controller.getSnapshot()).items.filter((i) => i.kind === "notice").at(-1);
    expect(notice?.kind === "notice" ? notice.text : "").toMatch(/Inserted/);
  });

  it("switches the notice language with the locale", async () => {
    const { controller, socket } = await connectAndOpen();
    controller.setLocale("zh");
    socket.event("message.start", {});
    await tick();
    const sent = controller.send("你好");
    await tick();
    socket.replyTo("prompt.submit", { status: "steered", user_row_id: 1 });
    await sent;

    const notice = activeTimeline(controller.getSnapshot()).items.filter((i) => i.kind === "notice").at(-1);
    expect(notice?.kind === "notice" ? notice.text : "").toMatch(/插入/);
  });
});

describe("stored-session management", () => {
  /** Record REST calls so the verbs and paths can be asserted. */
  function withRest(controller: ChatController) {
    const calls: { path: string; method: string; body?: unknown }[] = [];
    controller.setHttpFetcher((path, init) => {
      const body = init.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ path, method: String(init.method), body });
      if (init.method === "PATCH") return Promise.resolve({ ok: true, title: (body as { title: string }).title });
      return Promise.resolve({ ok: true });
    });
    return calls;
  }

  it("renames through REST PATCH, not the session.title RPC", async () => {
    const { controller, socket } = await connectAndOpen();
    const calls = withRest(controller);
    const storedId = controller.getSnapshot().tabs[0]?.storedId ?? "";

    await controller.renameStoredSession(storedId, "新名字");

    expect(calls).toEqual([
      { path: `/api/sessions/${storedId}`, method: "PATCH", body: { title: "新名字" } },
    ]);
    // `session.title` needs a LIVE session, which means resuming the row — and a
    // resumed row is then refused by delete with 4023. It must not be used here.
    const methods = socket.frames().map((f) => f.method);
    expect(methods).not.toContain("session.title");
    expect(methods).not.toContain("session.resume");
  });

  it("retitles the open tab so the strip and the list agree", async () => {
    const { controller } = await connectAndOpen();
    withRest(controller);
    const storedId = controller.getSnapshot().tabs[0]?.storedId ?? "";

    await controller.renameStoredSession(storedId, "改过的");
    expect(controller.getSnapshot().tabs[0]?.title).toBe("改过的");
  });

  it("refuses an empty title without touching the network", async () => {
    const { controller } = await connectAndOpen();
    const calls = withRest(controller);
    await expect(controller.renameStoredSession("any", "   ")).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  it("deletes through REST DELETE and closes the tab holding it", async () => {
    const { controller, socket } = await connectAndOpen();
    const calls = withRest(controller);
    const storedId = controller.getSnapshot().tabs[0]?.storedId ?? "";
    const tabsBefore = controller.getSnapshot().tabs.length;

    // The row is gone by definition once REST deleted it; the confirming
    // `session.list` must report it missing, or the delete throws.
    controller.listSessions = async () => [];

    // `session.close` is awaited before the DELETE, so answer it as it arrives.
    const done = controller.deleteStoredSession(storedId);
    await tick();
    socket.replyTo("session.close", {});
    await done;

    const methods = socket.frames().map((f) => f.method);
    expect(methods).toContain("session.close");
    expect(calls).toEqual([
      { path: `/api/sessions/${storedId}`, method: "DELETE", body: undefined },
    ]);
    expect(controller.getSnapshot().tabs.length).toBeLessThan(tabsBefore);
    expect(controller.getSnapshot().tabs.some((t) => t.storedId === storedId)).toBe(false);
  });

  it("reports a delete that silently failed, instead of trusting REST's ok", async () => {
    const { controller } = await connectAndOpen();
    withRest(controller);
    // REST answered ok, but the row is still there — that is what an ACTIVE
    // session does, and the user must not be told it worked.
    controller.listSessions = async () => [{ id: "s1", title: "", preview: "", started_at: 0, message_count: 1 }];
    await expect(controller.deleteStoredSession("s1")).rejects.toThrow();
  });

  it("surfaces a REST failure instead of claiming success", async () => {
    const { controller } = await connectAndOpen();
    controller.setHttpFetcher(() => Promise.reject(new Error("403 Forbidden")));
    await expect(controller.deleteStoredSession("s1")).rejects.toThrow(/403/);
  });
});

describe("session context", () => {
  it("reads a stored transcript over REST, resuming nothing", async () => {
    const { controller, socket } = await connectAndOpen();
    const calls: { path: string; method: string }[] = [];
    controller.setHttpFetcher((path, init) => {
      calls.push({ path, method: String(init.method) });
      return Promise.resolve({
        messages: [
          { role: "user", content: "why does it fail" },
          { role: "tool", content: '{"output":"raw"}' },
          { role: "assistant", content: "because the socket was not open yet" },
          { role: "assistant", content: "hidden bit", display_kind: "hidden" },
        ],
      });
    });

    const block = await controller.contextForStoredSession("20261018_100000_zzz", "Older work");

    expect(calls).toEqual([
      { path: "/api/sessions/20261018_100000_zzz/messages?limit=200&order=latest", method: "GET" },
    ]);
    // `session.history` is live-only (4001 for a stored id) and `resume` would
    // make the pointed-at row the backend's active session. Neither belongs here.
    const methods = socket.frames().map((frame) => frame.method);
    expect(methods).not.toContain("session.resume");
    expect(methods).not.toContain("session.history");
    expect(block.text).toContain("Older work");
    expect(block.text).toContain("why does it fail");
    expect(block.text).toContain("socket was not open yet");
    expect(block.text).not.toContain("raw");
    expect(block.text).not.toContain("hidden bit");
    expect(block.included).toBe(2);
  });

  it("reports an empty block for a session with nothing reusable", async () => {
    const { controller } = await connectAndOpen();
    controller.setHttpFetcher(() => Promise.resolve({ messages: [] }));
    expect((await controller.contextForStoredSession("20261018_110000_empty")).text).toBe("");
  });

  it("surfaces a REST failure instead of inserting a placeholder", async () => {
    const { controller } = await connectAndOpen();
    controller.setHttpFetcher(() => Promise.reject(new Error("404 Not Found")));
    await expect(controller.contextForStoredSession("missing")).rejects.toThrow(/404/);
  });
});

describe("edit a sent message", () => {
  /** A finished turn whose user row carries a durable id. */
  async function withDurableTurn() {
    const { controller, socket } = await connectAndOpen();
    const sent = controller.send("原始问题");
    await tick();
    socket.replyTo("prompt.submit", { user_row_id: 42 });
    await sent;
    socket.event("message.delta", { text: "第一版" });
    socket.event("message.complete", { status: "ok", text: "第一版" });
    await tick();
    const user = activeTimeline(controller.getSnapshot()).items.find((i) => i.kind === "user");
    return { controller, socket, userId: user?.id ?? "" };
  }

  it("submits the corrected text with the durable row as the cut point", async () => {
    const { controller, socket, userId } = await withDurableTurn();
    const done = controller.editAndResend(userId, "改过的问题");
    await tick();
    socket.replyTo("prompt.submit", { user_row_id: 43 });
    await done;

    const submit = socket.frames().filter((f) => f.method === "prompt.submit").at(-1);
    const params = submit?.params as Record<string, unknown>;
    expect(params.text).toBe("改过的问题");
    expect(params.truncate_before_row_id).toBe(42);
    expect(params.confirm_truncate).toBe(true);
    // The cut is addressed by row id, so no divergent ordinal may be sent.
    expect(params.truncate_before_user_ordinal).toBeUndefined();
    expect(params.truncate_before_message_id).toBeUndefined();
  });

  it("drops the edited turn and everything after it locally", async () => {
    const { controller, socket, userId } = await withDurableTurn();
    const done = controller.editAndResend(userId, "改过的问题");
    await tick();
    socket.replyTo("prompt.submit", { user_row_id: 43 });
    await done;

    const items = activeTimeline(controller.getSnapshot()).items;
    // The old reply is gone; the corrected user turn is the last thing.
    const texts = items.map((i) => ("text" in i ? i.text : ""));
    expect(texts).not.toContain("第一版");
    expect(texts.at(-1)).toBe("改过的问题");
  });

  it("refuses a turn with no durable row id rather than sending a cut the gateway rejects", async () => {
    const { controller, socket } = await connectAndOpen();
    // A locally appended turn never learned a row id.
    const sent = controller.send("还没落库");
    await tick();
    // Reply WITHOUT user_row_id: no durable anchor.
    socket.replyTo("prompt.submit", {});
    await sent;
    const user = activeTimeline(controller.getSnapshot()).items.find((i) => i.kind === "user");

    const before = socket.frames().length;
    await expect(controller.editAndResend(user?.id ?? "", "改")).rejects.toThrow();
    expect(socket.frames().length).toBe(before);
  });

  it("interrupts a running turn before rewriting it", async () => {
    const { controller, socket, userId } = await withDurableTurn();
    socket.event("message.start", {});
    await tick();

    const done = controller.editAndResend(userId, "改过的问题");
    await tick();
    socket.replyTo("session.interrupt", {});
    await tick();
    await tick();
    socket.replyTo("prompt.submit", { user_row_id: 44 });
    await done;

    const methods = socket.frames().map((f) => f.method);
    expect(methods).toContain("session.interrupt");
    expect(methods.indexOf("session.interrupt")).toBeLessThan(methods.lastIndexOf("prompt.submit"));
  });

  it("restores the transcript when the resubmit fails", async () => {
    const { controller, socket, userId } = await withDurableTurn();
    const before = activeTimeline(controller.getSnapshot()).items.map((i) => i.id);

    const promise = controller.editAndResend(userId, "改过的问题");
    await tick();
    const frame = socket.frames().filter((f) => f.method === "prompt.submit").at(-1);
    socket.deliver({ jsonrpc: "2.0", id: frame?.id, error: { code: -1, message: "truncate refused" } });

    await expect(promise).rejects.toBeTruthy();
    expect(activeTimeline(controller.getSnapshot()).items.map((i) => i.id)).toEqual(before);
  });
});

describe("sending with no tabs open", () => {
  it("mints a session and submits when every tab was closed", async () => {
    const { controller, socket } = await connectAndOpen();

    // Close the only tab: the dashboard now has no active session.
    const key = controller.getSnapshot().activeKey as string;
    controller.closeSession(key);
    expect(controller.getSnapshot().activeKey).toBeNull();
    expect(controller.getSnapshot().tabs).toHaveLength(0);

    const before = socket.frames().filter((f) => f.method === "session.create").length;
    const sent = controller.send("关掉标签后发的话");
    await tick();

    // A session must be minted before anything is submitted.
    const created = socket.frames().filter((f) => f.method === "session.create").length;
    expect(created).toBeGreaterThan(before);
    socket.replyTo("session.create", {
      session_id: "runtime-new",
      stored_session_id: "20261017_130000_new",
      messages: [],
      info: { model: "m", provider: "p", running: false },
    });
    await tick();
    await tick();
    socket.replyTo("prompt.submit", { user_row_id: 99 });
    await sent;

    const submit = socket.frames().filter((f) => f.method === "prompt.submit").at(-1);
    expect((submit?.params as Record<string, unknown>).text).toBe("关掉标签后发的话");
    expect((submit?.params as Record<string, unknown>).session_id).toBe("runtime-new");
  });

  it("does not mint a session for an empty send", async () => {
    const { controller, socket } = await connectAndOpen();
    controller.closeSession(controller.getSnapshot().activeKey as string);

    await controller.send("   ");
    expect(socket.frames().some((f) => f.method === "session.create")).toBe(true); // only the initial one
    expect(socket.frames().filter((f) => f.method === "session.create")).toHaveLength(1);
  });
});

describe("server requests across a route change", () => {
  it("parks a request that arrives while the page is unmounted instead of refusing it", async () => {
    const { controller, socket } = await connectAndOpen();

    // The page unmounts (user switched dashboard tabs): no sink.
    controller.setServerRequestSink(null);

    socket.deliver({
      jsonrpc: "2.0",
      id: "srv-1",
      method: "clarify",
      params: { questions: [{ qid: "a", question: "?" }] },
    });
    await tick();

    // Nothing was answered with -32601; the request is waiting for the remount.
    const parked = controller.takeParkedCards();
    expect(parked).toHaveLength(1);
    expect(parked[0]?.method).toBe("clarify");
    // Taking them clears the queue, so a second mount cannot double-render them.
    expect(controller.takeParkedCards()).toHaveLength(0);
  });

  it("delivers straight to the sink once the page is mounted again", async () => {
    const { controller, socket } = await connectAndOpen();
    const seen: string[] = [];
    controller.setServerRequestSink((card) => seen.push(card.method));

    socket.deliver({
      jsonrpc: "2.0",
      id: "srv-2",
      method: "approval",
      params: { request_id: "r", choices: ["once"] },
    });
    await tick();

    expect(seen).toEqual(["approval"]);
    expect(controller.takeParkedCards()).toHaveLength(0);
  });
});

describe("desktop notifications", () => {
  it("announces a finished turn with the reply's own text", async () => {
    const notices: TurnNotice[] = [];
    const { controller, socket } = await connectAndOpen();
    controller.setNoticeSink((notice) => notices.push(notice));

    socket.event("message.delta", { text: "答完了" }, { session_id: "runtime-1", seq: 1 });
    socket.event("message.complete", { text: "", status: "complete" }, { session_id: "runtime-1", seq: 2 });

    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ kind: "complete", sessionKey: "runtime-1", text: "答完了" });
    expect(notices[0]?.error).toBeUndefined();
  });

  it("carries the turn's failure reason so the notification can say it failed", async () => {
    const notices: TurnNotice[] = [];
    const { controller, socket } = await connectAndOpen();
    controller.setNoticeSink((notice) => notices.push(notice));

    socket.event("message.complete", { text: "", status: "error", error: "upstream 429" }, {
      session_id: "runtime-1",
      seq: 1,
    });

    expect(notices[0]).toMatchObject({ kind: "complete", error: "upstream 429" });
  });

  it("announces a pending approval even when the page will answer it", async () => {
    const notices: TurnNotice[] = [];
    const { controller, socket } = await connectAndOpen({ onServerRequest: () => undefined });
    controller.setNoticeSink((notice) => notices.push(notice));

    socket.deliver({
      jsonrpc: "2.0",
      id: "req-9",
      method: "approval",
      params: { session_id: "runtime-1", command: "rm -rf build" },
    });

    expect(notices[0]).toMatchObject({ kind: "request", method: "approval", requestId: "req-9" });
  });

  it("stays silent for turns of sessions no tab owns", async () => {
    const notices: TurnNotice[] = [];
    const { controller, socket } = await connectAndOpen();
    controller.setNoticeSink((notice) => notices.push(notice));

    socket.event("message.complete", { text: "别人的会话", status: "complete" }, { session_id: "other", seq: 1 });
    expect(notices).toHaveLength(0);
  });

  it("does not notify for a turn that was already delivered once", async () => {
    const notices: TurnNotice[] = [];
    const { controller, socket } = await connectAndOpen();
    controller.setNoticeSink((notice) => notices.push(notice));

    const frame = { text: "一次", status: "complete" };
    socket.event("message.complete", frame, { session_id: "runtime-1", seq: 7 });
    socket.event("message.complete", frame, { session_id: "runtime-1", seq: 7 });

    expect(notices).toHaveLength(1);
  });
});

describe("workspace", () => {
  it("sends the picked workspace on session.create", async () => {
    const persisted: string[] = [];
    const { controller, socket } = await connectAndOpen({
      initialWorkspace: "/home/me/code/daw",
      persistWorkspace: (cwd) => persisted.push(cwd),
    });

    const create = socket.frames().find((frame) => frame.method === "session.create");
    expect(create?.params).toMatchObject({
      source: "desktop",
      cwd: "/home/me/code/daw",
      cwd_explicit: true,
    });
    // The page-load session consumed the restored pick: it rode on this create,
    // and the preference is cleared so the NEXT chat starts at the default
    // directory instead of inheriting the choice forever.
    expect(persisted).toEqual([""]);
    expect(controller.getSnapshot().workspace).toBe("");
  });

  it("sends no cwd at all when nothing is picked", async () => {
    const { socket } = await connectAndOpen();
    const create = socket.frames().find((frame) => frame.method === "session.create");
    expect(create?.params).toEqual({ source: "desktop" });
  });

  it("applies a pick to the NEXT chat and persists it once", async () => {
    const persisted: string[] = [];
    const { controller, socket } = await connectAndOpen({
      persistWorkspace: (cwd) => persisted.push(cwd),
    });

    controller.setWorkspace("/home/me/code/daw");
    controller.setWorkspace("/home/me/code/daw");
    expect(persisted).toEqual(["/home/me/code/daw"]);

    const before = socket.frames().filter((frame) => frame.method === "session.create").length;
    void controller.newSession();
    await tick();
    const creates = socket.frames().filter((frame) => frame.method === "session.create");
    expect(creates.length).toBe(before + 1);
    expect(creates.at(-1)?.params).toMatchObject({ cwd: "/home/me/code/daw", cwd_explicit: true });
  });

  it("trims a pasted path before storing it", async () => {
    const persisted: string[] = [];
    const { controller } = await connectAndOpen({ persistWorkspace: (cwd) => persisted.push(cwd) });
    controller.setWorkspace("  /home/me/code/daw  ");
    expect(controller.getSnapshot().workspace).toBe("/home/me/code/daw");
    expect(persisted).toEqual(["/home/me/code/daw"]);
  });

  it("clears the pick when the default is chosen", async () => {
    const persisted: string[] = [];
    const { controller } = await connectAndOpen({
      initialWorkspace: "/home/me/code/daw",
      persistWorkspace: (cwd) => persisted.push(cwd),
    });
    controller.setWorkspace("");
    expect(controller.getSnapshot().workspace).toBe("");
    expect(persisted).toEqual([""]);
  });

  it("records the open session's own cwd from the snapshot", async () => {
    const { controller, socket } = await connectAndOpen();
    // A stored id the open tab does NOT already own: `openStored` would
    // otherwise just refocus the existing tab and no snapshot would be bound.
    const opened = controller.openStoredSession("20261015_090000_def", "old chat");
    await tick();
    socket.replyTo("session.resume", {
      session_id: "runtime-2",
      stored_session_id: "20261015_090000_def",
      messages: [],
      info: { cwd: "/home/me/code/dawview" },
    });
    await opened;
    expect(activeTimeline(controller.getSnapshot()).meta.cwd).toBe("/home/me/code/dawview");
  });
});

describe("projects", () => {
  it("asks for a shallow tree: two previews, no hydration", async () => {
    const { controller, socket } = await connectAndOpen();
    const pending = controller.projectsTree();
    await tick();
    const frame = socket.frames().filter((f) => f.method === "projects.tree").at(-1);
    expect(frame?.params).toEqual({ preview_limit: 2, session_limit: 2000 });
    socket.replyTo("projects.tree", { projects: [], active_id: null, scoped_session_ids: [] });
    expect(await pending).toEqual({ projects: [], active_id: null, scoped_session_ids: [] });
  });

  it("drills into one project by id", async () => {
    const { controller, socket } = await connectAndOpen();
    const pending = controller.projectSessions("p_1");
    await tick();
    const frame = socket.frames().filter((f) => f.method === "projects.project_sessions").at(-1);
    expect(frame?.params).toEqual({ project_id: "p_1", session_limit: 300 });
    socket.replyTo("projects.project_sessions", {
      project: { id: "p_1", label: "Hermes", repos: [], previewSessions: [] },
    });
    expect((await pending)?.id).toBe("p_1");
  });

  it("returns null when the drill-in has no project", async () => {
    const { controller, socket } = await connectAndOpen();
    const pending = controller.projectSessions("gone");
    await tick();
    socket.replyTo("projects.project_sessions", { project: null });
    expect(await pending).toBeNull();
  });

  it("renames a project through projects.update", async () => {
    // `projects.update` is the only writer for a project's display name; the
    // reply is the refreshed ProjectInfo (not the tree), so the caller re-reads.
    const { controller, socket } = await connectAndOpen();
    const pending = controller.renameProject("p_1", "New name");
    await tick();
    const frame = socket.frames().filter((f) => f.method === "projects.update").at(-1);
    expect(frame?.params).toEqual({ id: "p_1", name: "New name" });
    socket.replyTo("projects.update", { project: { id: "p_1", name: "New name" } });
    await expect(pending).resolves.toBeUndefined();
  });

  it("deletes a project through projects.delete", async () => {
    const { controller, socket } = await connectAndOpen();
    const pending = controller.deleteProject("p_1");
    await tick();
    const frame = socket.frames().filter((f) => f.method === "projects.delete").at(-1);
    expect(frame?.params).toEqual({ id: "p_1" });
    socket.replyTo("projects.delete", { projects: [], active_id: null });
    await expect(pending).resolves.toBeUndefined();
  });

  it("surfaces a refused project delete instead of swallowing it", async () => {
    // An auto project has no projects.db row, so the backend answers 5062; the
    // caller must be able to show that rather than think the row went away.
    const { controller, socket } = await connectAndOpen();
    const pending = controller.deleteProject("C:/repo/a");
    await tick();
    socket.replyError("projects.delete", 5062, "no such project");
    await expect(pending).rejects.toThrow(/no such project/);
  });
});

describe("git badge", () => {
  it("asks the plugin's host route for the directory, not the gateway", async () => {
    const { controller } = await connectAndOpen();
    const seen: string[] = [];
    controller.setHttpFetcher((path) => {
      seen.push(path);
      return Promise.resolve({
        ok: true,
        is_repo: true,
        root: "C:/work/repo",
        status: ["# branch.oid abc1234", "# branch.head main", "? a.txt"].join("\n"),
      });
    });

    const info = await controller.gitInfo("C:/work/repo");
    expect(seen).toEqual(["/api/plugins/hermes-bubbles/git?path=C%3A%2Fwork%2Frepo"]);
    expect(info?.branch).toBe("main");
    expect(info?.untracked).toBe(1);
  });

  it("answers null (no badge) outside a repository", async () => {
    const { controller } = await connectAndOpen();
    controller.setHttpFetcher(() => Promise.resolve({ ok: true, is_repo: false }));
    expect(await controller.gitInfo("C:/work/plain")).toBeNull();
  });

  it("answers null when the route is missing or the transport fails", async () => {
    const { controller } = await connectAndOpen();
    controller.setHttpFetcher(() => Promise.reject(new Error("404 Not Found")));
    expect(await controller.gitInfo("C:/work/repo")).toBeNull();
  });

  it("does not call the host for an empty directory", async () => {
    const { controller } = await connectAndOpen();
    let called = false;
    controller.setHttpFetcher(() => {
      called = true;
      return Promise.resolve({ ok: true, is_repo: true });
    });
    expect(await controller.gitInfo("   ")).toBeNull();
    expect(called).toBe(false);
  });
});

describe("picking a workspace", () => {
  it("replaces an untouched session so the pick is the one that takes effect", async () => {
    const { controller, socket } = await connectAndOpen();
    const createsBefore = socket.frames().filter((f) => f.method === "session.create").length;

    const pending = controller.pickWorkspace("C:/work/repo");
    await tick();
    const last = socket.frames().filter((f) => f.method === "session.create").at(-1);
    // The page-load session was minted in the default directory and can never be
    // moved, so the pick has to reach the backend through a NEW create.
    expect(socket.frames().filter((f) => f.method === "session.create")).toHaveLength(createsBefore + 1);
    expect(last?.params).toMatchObject({ source: "desktop", cwd: "C:/work/repo", cwd_explicit: true });

    socket.replyTo("session.create", {
      session_id: "runtime-2",
      stored_session_id: "20261019_101010_repo",
      messages: [],
      info: { model: "m", provider: "p", cwd: "C:/work/repo", running: false },
    });
    await pending;

    expect(activeTimeline(controller.getSnapshot()).meta.cwd).toBe("C:/work/repo");
    // The pick aimed this session and was spent: a new chat nobody aimed
    // anywhere must start at the default directory, not inherit the repo.
    expect(controller.getWorkspace()).toBe("");
  });

  it("does not replace a session that already has content", async () => {
    const { controller, socket } = await connectAndOpen();
    socket.event("message.start", {});
    socket.event("message.delta", { text: "已有内容" });
    socket.event("message.complete", { status: "ok", text: "已有内容" });
    await tick();

    const createsBefore = socket.frames().filter((f) => f.method === "session.create").length;
    await controller.pickWorkspace("C:/work/repo");
    await tick();

    expect(socket.frames().filter((f) => f.method === "session.create")).toHaveLength(createsBefore);
    // The pick still stands for the next new chat.
    expect(controller.getWorkspace()).toBe("C:/work/repo");
  });

  it("never re-homes a resumed session (its cwd is pinned by the backend)", async () => {
    const { controller, socket } = await connectAndOpen();
    const opening = controller.openStoredSession("20261015_old", "旧对话");
    await tick();
    socket.replyTo("session.resume", {
      session_id: "runtime-old",
      stored_session_id: "20261015_old",
      messages: [{ role: "user", text: "以前说的话" }],
      info: { model: "m", provider: "p", cwd: "C:/old/place", running: false },
    });
    await opening;

    const createsBefore = socket.frames().filter((f) => f.method === "session.create").length;
    await controller.pickWorkspace("C:/work/repo");
    await tick();

    expect(socket.frames().filter((f) => f.method === "session.create")).toHaveLength(createsBefore);
    expect(controller.getWorkspace()).toBe("C:/work/repo");
  });

  it("clears the pick after the session it aimed is created", async () => {
    const persisted: string[] = [];
    const { controller, socket } = await connectAndOpen({ persistWorkspace: (cwd) => persisted.push(cwd) });
    const pending = controller.pickWorkspace("C:/work/repo");
    await tick();
    socket.replyTo("session.create", {
      session_id: "runtime-3",
      stored_session_id: "20261019_101011_repo",
      messages: [],
      info: { model: "m", provider: "p", cwd: "C:/work/repo", running: false },
    });
    await pending;
    // Persisting "" removes the profile's stored key: the next chat that nobody
    // aimed anywhere starts at the default directory.
    expect(persisted).toEqual(["C:/work/repo", ""]);
    expect(controller.getWorkspace()).toBe("");
  });
});
