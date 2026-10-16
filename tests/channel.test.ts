import { describe, expect, it, vi } from "vitest";

import { Channel, GatewayError, type ServerRequest, type Transport } from "../src/gateway/channel";

class FakeTransport implements Transport {
  readonly sent: string[] = [];
  closed = false;

  send(text: string): void {
    this.sent.push(text);
  }

  close(): void {
    this.closed = true;
  }

  /** Decoded frames this side sent, most recent last. */
  frames(): Record<string, unknown>[] {
    return this.sent.map((line) => JSON.parse(line) as Record<string, unknown>);
  }
}

function bind(): { channel: Channel; transport: FakeTransport } {
  const channel = new Channel({ requestTimeoutMs: 0, heartbeatIntervalMs: 0 });
  const transport = new FakeTransport();
  channel.bind(transport);
  return { channel, transport };
}

describe("Channel requests", () => {
  it("sends a numeric-id JSON-RPC request and resolves on the matching result", async () => {
    const { channel, transport } = bind();
    const promise = channel.request<{ session_id: string }>("session.create", { source: "desktop" });
    const sent = transport.frames()[0];
    expect(sent).toMatchObject({ jsonrpc: "2.0", id: 1, method: "session.create", params: { source: "desktop" } });

    channel.handleFrame(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { session_id: "s1" } }));
    await expect(promise).resolves.toEqual({ session_id: "s1" });
  });

  it("rejects with the server's message and code on an error frame", async () => {
    const { channel, transport } = bind();
    const promise = channel.request("nope.method");
    const id = transport.frames()[0]?.id;
    channel.handleFrame(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32601, message: "method not found" } }));
    await expect(promise).rejects.toBeInstanceOf(GatewayError);
    await expect(promise).rejects.toMatchObject({ code: -32601, message: "method not found" });
  });

  it("refuses to send when no socket is bound", async () => {
    const channel = new Channel();
    await expect(channel.request("session.list")).rejects.toThrow(/not connected/);
  });

  it("rejects in-flight calls when the socket is unbound", async () => {
    const { channel } = bind();
    const promise = channel.request("session.list");
    channel.unbind(new GatewayError("socket closed"));
    await expect(promise).rejects.toThrow("socket closed");
  });

  it("times out a request that never gets a reply", async () => {
    vi.useFakeTimers();
    try {
      const channel = new Channel({ requestTimeoutMs: 50, heartbeatIntervalMs: 0 });
      channel.bind(new FakeTransport());
      const promise = channel.request("session.list");
      const assertion = expect(promise).rejects.toThrow(/timed out: session.list/);
      vi.advanceTimersByTime(60);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not settle a call twice when a duplicate response arrives", async () => {
    const { channel, transport } = bind();
    const promise = channel.request<{ n: number }>("x");
    const id = transport.frames()[0]?.id;
    channel.handleFrame(JSON.stringify({ jsonrpc: "2.0", id, result: { n: 1 } }));
    // A second frame for a settled id is ignored rather than throwing.
    expect(() => channel.handleFrame(JSON.stringify({ jsonrpc: "2.0", id, result: { n: 2 } }))).not.toThrow();
    await expect(promise).resolves.toEqual({ n: 1 });
  });

  it("keeps concurrent calls apart by id", async () => {
    const { channel, transport } = bind();
    const a = channel.request<string>("a");
    const b = channel.request<string>("b");
    const [idA, idB] = transport.frames().map((f) => f.id);
    channel.handleFrame(JSON.stringify({ jsonrpc: "2.0", id: idB, result: "B" }));
    channel.handleFrame(JSON.stringify({ jsonrpc: "2.0", id: idA, result: "A" }));
    await expect(a).resolves.toBe("A");
    await expect(b).resolves.toBe("B");
  });
});

describe("Channel events", () => {
  it("dispatches event notifications to onEvent", () => {
    const seen: unknown[] = [];
    const channel = new Channel({ onEvent: (event) => seen.push(event), heartbeatIntervalMs: 0 });
    channel.bind(new FakeTransport());
    channel.handleFrame(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "event",
        params: { type: "message.delta", session_id: "s1", seq: 3, payload: { text: "hi" } },
      }),
    );
    expect(seen).toEqual([{ type: "message.delta", session_id: "s1", seq: 3, payload: { text: "hi" } }]);
  });

  it("advertises server-request capability once gateway.ready arrives", async () => {
    const { channel, transport } = bind();
    channel.handleFrame(
      JSON.stringify({ jsonrpc: "2.0", method: "event", params: { type: "gateway.ready", payload: { heartbeat: false } } }),
    );
    await Promise.resolve();
    expect(transport.frames()[0]).toMatchObject({
      method: "client.capabilities",
      params: { server_requests: true },
    });
  });

  it("ignores non-JSON and non-object frames without throwing", () => {
    const { channel } = bind();
    expect(channel.handleFrame("not json")).toBeNull();
    expect(channel.handleFrame("null")).toBeNull();
    expect(channel.handleFrame("[1,2]")).toBeNull();
    expect(channel.handleFrame("123")).toBeNull();
  });
});

describe("Channel server requests", () => {
  it("routes a string-id request to the handler and sends back its result", () => {
    const cards: ServerRequest[] = [];
    const channel = new Channel({
      onServerRequest: (request) => {
        cards.push(request);
        request.respond({ choice: "once" });
        return true;
      },
      heartbeatIntervalMs: 0,
    });
    const transport = new FakeTransport();
    channel.bind(transport);

    channel.handleFrame(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "req-1",
        method: "approval",
        params: { session_id: "s1", request_id: "r1", command: "rm -rf /" },
      }),
    );

    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ id: "req-1", method: "approval" });
    expect(transport.frames()[0]).toEqual({ jsonrpc: "2.0", id: "req-1", result: { choice: "once" } });
  });

  it("fails fast with -32601 for a request nobody handles", () => {
    const unhandled: { id: string; method: string }[] = [];
    const channel = new Channel({ onUnhandledRequest: (r) => unhandled.push(r), heartbeatIntervalMs: 0 });
    const transport = new FakeTransport();
    channel.bind(transport);

    channel.handleFrame(JSON.stringify({ jsonrpc: "2.0", id: "req-9", method: "vault.unlock_prompt", params: {} }));

    expect(unhandled).toEqual([{ id: "req-9", method: "vault.unlock_prompt" }]);
    expect(transport.frames()[0]).toEqual({
      jsonrpc: "2.0",
      id: "req-9",
      error: { code: -32601, message: "client does not handle vault.unlock_prompt" },
    });
  });

  it("honours a handler returning false, letting the next one try", () => {
    const second = vi.fn((request: ServerRequest) => {
      request.respond({ value: "ok" });
      return true;
    });
    const channel = new Channel({
      onServerRequest: (request) => {
        if (request.method === "clarify") return false;
        return second(request);
      },
      heartbeatIntervalMs: 0,
    });
    const transport = new FakeTransport();
    channel.bind(transport);
    channel.handleFrame(JSON.stringify({ jsonrpc: "2.0", id: "r", method: "clarify", params: {} }));
    expect(second).not.toHaveBeenCalled();
  });

  it("makes the first answer win, so a stale card answering twice is a no-op", () => {
    let captured: ServerRequest | null = null;
    const channel = new Channel({
      onServerRequest: (request) => {
        captured = request;
        return true;
      },
      heartbeatIntervalMs: 0,
    });
    const transport = new FakeTransport();
    channel.bind(transport);
    channel.handleFrame(JSON.stringify({ jsonrpc: "2.0", id: "r", method: "approval", params: {} }));

    const request = captured as unknown as ServerRequest;
    request.respond({ choice: "once" });
    request.respond({ choice: "deny" });
    expect(transport.frames()).toHaveLength(1);
    expect(transport.frames()[0]).toMatchObject({ result: { choice: "once" } });
  });

  it("tells a response and a question apart by id type", () => {
    const handled: string[] = [];
    const channel = new Channel({
      onServerRequest: (request) => {
        handled.push(request.method);
        return true;
      },
      onEvent: () => undefined,
      heartbeatIntervalMs: 0,
    });
    channel.bind(new FakeTransport());
    // numeric id + result → response, not a request
    channel.handleFrame(JSON.stringify({ jsonrpc: "2.0", id: 7, result: {} }));
    expect(handled).toEqual([]);
  });
});

describe("Channel heartbeat", () => {
  it("pings on an interval and counts any inbound frame as liveness", () => {
    vi.useFakeTimers();
    try {
      const channel = new Channel({ heartbeatIntervalMs: 1_000, heartbeatDeadlineMs: 5_000 });
      const transport = new FakeTransport();
      channel.bind(transport);
      channel.startHeartbeat();

      vi.advanceTimersByTime(1_000);
      expect(transport.frames()[0]).toMatchObject({ method: "gateway.ping" });

      // A pong for the ping we sent keeps the socket alive past the deadline.
      const pingId = transport.frames()[0]?.id;
      vi.advanceTimersByTime(4_000);
      channel.handleFrame(JSON.stringify({ jsonrpc: "2.0", id: pingId, result: { ok: true } }));
      vi.advanceTimersByTime(4_000);
      expect(transport.frames().filter((f) => f.method === "gateway.ping").length).toBeGreaterThan(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports a failure when the socket goes silent past the deadline", () => {
    vi.useFakeTimers();
    try {
      const failures: Error[] = [];
      const channel = new Channel({
        heartbeatIntervalMs: 1_000,
        heartbeatDeadlineMs: 2_000,
        onHeartbeatFailure: (error) => failures.push(error),
      });
      channel.bind(new FakeTransport());
      channel.startHeartbeat();
      vi.advanceTimersByTime(1_000); // first ping
      vi.advanceTimersByTime(5_000); // nothing came back
      expect(failures).toHaveLength(1);
      expect(failures[0]?.message).toMatch(/heartbeat/);
    } finally {
      vi.useRealTimers();
    }
  });
});
