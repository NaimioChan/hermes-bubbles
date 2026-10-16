import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ChatController } from "../src/app/controller";
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
    expect(controller.getConnection().detail).toMatch(/鉴权/);
  });

  it("stops retrying when chat is disabled on this dashboard (4403)", async () => {
    const { controller, socket } = await connectAndOpen();
    socket.onclose?.({ code: 4403 });
    expect(controller.getConnection().detail).toMatch(/未启用/);
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
    await expect(staging).rejects.toThrow(/未接受/);
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
