import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ChatController } from "../src/app/controller";

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

  /** Reply to the Nth outbound request (0-based) as the backend would. */
  reply(index: number, result: unknown): void {
    const frame = this.frames()[index];
    this.deliver({ jsonrpc: "2.0", id: frame?.id, result });
  }

  event(type: string, payload?: Record<string, unknown>, extra: Record<string, unknown> = {}): void {
    this.deliver({ jsonrpc: "2.0", method: "event", params: { type, payload, ...extra } });
  }
}

function makeController(overrides: Partial<ConstructorParameters<typeof ChatController>[0]> = {}) {
  const controller = new ChatController({
    urlProvider: async () => "ws://127.0.0.1:9119/api/ws?token=t",
    socketFactory: (url) => new FakeSocket(url) as unknown as WebSocket,
    ...overrides,
  });
  return controller;
}

/** `connect()` awaits the async URL provider before it builds a socket. */
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

async function connectAndOpen(
  overrides: Partial<ConstructorParameters<typeof ChatController>[0]> = {},
): Promise<{ controller: ChatController; socket: FakeSocket }> {
  const controller = makeController(overrides);
  controller.connect();
  await tick();
  const socket = FakeSocket.instances.at(-1) as FakeSocket;
  socket.open();
  socket.event("gateway.ready", { heartbeat: false, replay_epoch: "epoch-1" });
  return { controller, socket };
}

/** Bring a controller to the "connected, session open" state. */
async function boot(storedId?: string) {
  const { controller, socket } = await connectAndOpen();

  const opening = controller.openSession(storedId);
  await tick();
  const frames = socket.frames();
  const index = frames.findIndex((f) => f.method === (storedId ? "session.resume" : "session.create"));
  socket.reply(index, {
    session_id: "runtime-1",
    stored_session_id: "20261016_120000_abc",
    messages: [],
    info: { model: "m", provider: "p", running: false },
  });
  await opening;
  return { controller, socket };
}

beforeEach(() => {
  FakeSocket.instances = [];
});

afterEach(() => {
  vi.useRealTimers();
});

describe("connection", () => {
  it("connects and opens a session", async () => {
    const { controller } = await boot();
    expect(controller.getSnapshot().meta.runtimeId).toBe("runtime-1");
    expect(controller.getConnection().state).toBe("open");
  });

  it("resumes a stored session when given an id", async () => {
    const { controller, socket } = await boot("20261015_000000_xyz");
    expect(socket.frames().some((f) => f.method === "session.resume")).toBe(true);
    expect(controller.getSnapshot().meta.storedId).toBe("20261016_120000_abc");
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

  it("reconnects after an ordinary drop and re-syncs", async () => {
    const { controller, socket } = await boot();
    vi.useFakeTimers();
    try {
      socket.onclose?.({ code: 1006 });
      expect(controller.getSnapshot().meta.connected).toBe(false);

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
    const { controller, socket } = await boot();
    const sending = controller.send("你好");
    const frames = socket.frames();
    const index = frames.findIndex((f) => f.method === "prompt.submit");
    expect(frames[index]).toMatchObject({ params: { session_id: "runtime-1", text: "你好" } });

    socket.reply(index, { status: "streaming", user_row_id: 12 });
    await sending;

    expect(controller.getSnapshot().items[0]).toMatchObject({
      kind: "user",
      text: "你好",
      pending: false,
      rowId: 12,
    });
  });

  it("ignores an empty or whitespace-only send", async () => {
    const { controller, socket } = await boot();
    await controller.send("   ");
    expect(socket.frames().some((f) => f.method === "prompt.submit")).toBe(false);
    expect(controller.getSnapshot().items).toHaveLength(0);
  });

  it("opens a session first when a send arrives with none", async () => {
    const { controller, socket } = await connectAndOpen();

    const sending = controller.send("第一条");
    await vi.waitFor(() => {
      expect(socket.frames().some((f) => f.method === "session.create")).toBe(true);
    });
    const createIndex = socket.frames().findIndex((f) => f.method === "session.create");
    socket.reply(createIndex, { session_id: "runtime-9", messages: [], info: {} });
    await vi.waitFor(() => {
      expect(socket.frames().some((f) => f.method === "prompt.submit")).toBe(true);
    });
    const submitIndex = socket.frames().findIndex((f) => f.method === "prompt.submit");
    expect(socket.frames()[submitIndex]).toMatchObject({ params: { session_id: "runtime-9" } });
    socket.reply(submitIndex, { status: "streaming" });
    await sending;
  });

  it("settles the timeline when interrupted even if the RPC fails", async () => {
    const { controller, socket } = await boot();
    const sending = controller.send("跑个长任务");
    socket.reply(socket.frames().findIndex((f) => f.method === "prompt.submit"), { status: "streaming" });
    await sending;
    socket.event("message.start");
    socket.event("message.delta", { text: "开始" });

    const stopping = controller.interrupt();
    socket.deliver({ jsonrpc: "2.0", id: socket.frames().at(-1)?.id, error: { code: -32000, message: "nope" } });
    await stopping;

    expect(controller.getSnapshot().meta.running).toBe(false);
    expect(controller.getSnapshot().items.at(-1)).toMatchObject({ streaming: false, text: "开始" });
  });
});

describe("event routing", () => {
  it("renders a streamed reply end to end", async () => {
    const { controller, socket } = await boot();
    socket.event("message.start", undefined, { session_id: "runtime-1", seq: 1 });
    socket.event("message.delta", { text: "你" }, { session_id: "runtime-1", seq: 2 });
    socket.event("message.delta", { text: "好" }, { session_id: "runtime-1", seq: 3 });
    socket.event("message.complete", { text: "", status: "complete" }, { session_id: "runtime-1", seq: 4 });

    const items = controller.getSnapshot().items;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "assistant", text: "你好", streaming: false });
    expect(controller.getSnapshot().meta.running).toBe(false);
  });

  it("drops the fan-out copy of a delta (same epoch + session + seq)", async () => {
    const { controller, socket } = await boot();
    const extra = { session_id: "runtime-1", seq: 5 };
    socket.event("message.delta", { text: "只出现一次" }, extra);
    socket.event("message.delta", { text: "只出现一次" }, extra);
    expect(controller.getSnapshot().items[0]).toMatchObject({ text: "只出现一次" });
  });

  it("ignores events belonging to another session", async () => {
    const { controller, socket } = await boot();
    socket.event("message.delta", { text: "别的会话" }, { session_id: "runtime-other", seq: 1 });
    expect(controller.getSnapshot().items).toHaveLength(0);
  });

  it("renders session-less broadcasts", async () => {
    const { controller, socket } = await boot();
    socket.event("status.update", { kind: "compacting", text: "压缩中…" });
    expect(controller.getSnapshot().meta.status).toBe("压缩中…");
  });

  it("adopts a new epoch so a backend restart does not look like a replay", async () => {
    const { controller, socket } = await boot();
    socket.event("message.delta", { text: "a" }, { session_id: "runtime-1", seq: 9 });
    // Backend restarted: same session, counters reset, new epoch.
    socket.event("gateway.ready", { heartbeat: false, replay_epoch: "epoch-2" });
    socket.event("message.delta", { text: "b" }, { session_id: "runtime-1", seq: 9 });
    expect(controller.getSnapshot().items[0]).toMatchObject({ text: "ab" });
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
    expect(cards[0]?.method).toBe("approval");
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
    const { controller, socket } = await boot();
    socket.event("message.delta", { text: "本地" }, { session_id: "runtime-1", seq: 1 });
    socket.event("message.complete", { text: "", status: "complete" }, { session_id: "runtime-1", seq: 2 });

    const resyncing = controller.resync();
    const index = socket.frames().findIndex((f) => f.method === "session.history");
    socket.reply(index, {
      count: 2,
      messages: [
        { role: "user", text: "历史提问" },
        { role: "assistant", text: "历史回答" },
      ],
    });
    await resyncing;

    const items = controller.getSnapshot().items;
    expect(items.map((i) => (i as { text: string }).text)).toEqual(["历史提问", "历史回答"]);
  });

  it("keeps the live tail when a turn is still running", async () => {
    const { controller, socket } = await boot();
    socket.event("message.start", undefined, { session_id: "runtime-1", seq: 1 });
    socket.event("message.delta", { text: "正在写" }, { session_id: "runtime-1", seq: 2 });

    const resyncing = controller.resync();
    const index = socket.frames().findIndex((f) => f.method === "session.history");
    socket.reply(index, { count: 1, messages: [{ role: "user", text: "问题" }] });
    await resyncing;

    const items = controller.getSnapshot().items;
    expect(items[0]).toMatchObject({ text: "问题" });
    expect(items.at(-1)).toMatchObject({ text: "正在写", streaming: true });
  });

  it("leaves the streamed view intact when the history read fails", async () => {
    const { controller, socket } = await boot();
    socket.event("message.delta", { text: "别丢我" }, { session_id: "runtime-1", seq: 1 });
    const resyncing = controller.resync();
    const index = socket.frames().findIndex((f) => f.method === "session.history");
    socket.deliver({ jsonrpc: "2.0", id: socket.frames()[index]?.id, error: { code: -32000, message: "boom" } });
    await resyncing;
    expect(controller.getSnapshot().items[0]).toMatchObject({ text: "别丢我" });
  });
});

describe("subscription", () => {
  it("notifies subscribers on every timeline change and stops after unsubscribe", async () => {
    const { controller, socket } = await boot();
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
    const { controller } = await boot();
    expect(controller.getSnapshot()).toBe(controller.getSnapshot());
  });
});
