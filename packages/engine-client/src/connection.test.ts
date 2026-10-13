import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EngineConnection, type SocketLike } from "./connection.ts";
import { Hash, type ClientMessage, type ServerMessage } from "./protocol.gen.ts";

class FakeSocket implements SocketLike {
  sent: ClientMessage[] = [];
  onopen: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;

  constructor(
    readonly url: string,
    readonly protocols: string[],
  ) {}

  send(data: string) {
    this.sent.push(JSON.parse(data) as ClientMessage);
  }
  close() {
    this.onclose?.(new CloseEvent("close"));
  }
  open(hello = true) {
    this.onopen?.(new Event("open"));
    if (hello) this.receive({ id: 0, type: "hello", hello: { protocol: Hash } });
  }
  receive(msg: ServerMessage) {
    this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(msg) }));
  }
}

let sockets: FakeSocket[];
const latest = () => sockets.at(-1)!;

function connect() {
  return new EngineConnection({
    url: "http://127.0.0.1:7443",
    token: "t0k",
    retryDelaysMs: [100, 1000],
    createSocket: (url, protocols) => {
      const s = new FakeSocket(url, protocols);
      sockets.push(s);
      return s;
    },
  });
}

beforeEach(() => {
  sockets = [];
  vi.useFakeTimers();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("EngineConnection", () => {
  it("authenticates with the token subprotocol on the control socket URL", () => {
    connect();
    expect(latest().url).toBe("ws://127.0.0.1:7443/ws");
    expect(latest().protocols).toEqual(["hukube.v1", "hukube.token.t0k"]);
  });

  it("resolves and rejects requests by id", async () => {
    const conn = connect();
    latest().open();

    const ok = conn.request("clusters.list", undefined);
    const bad = conn.request("settings.put", { key: "k", value: 1 });
    const [okMsg, badMsg] = latest().sent;
    latest().receive({
      id: badMsg!.id,
      type: "error",
      error: { code: "bad_request", message: "nope" },
    });
    latest().receive({ id: okMsg!.id, type: "result", data: [{ id: "kind-dev" }] });

    await expect(ok).resolves.toEqual([{ id: "kind-dev" }]);
    await expect(bad).rejects.toMatchObject({ code: "bad_request", message: "nope" });
  });

  it("delivers subscription data, updates in place, and ignores data after close", () => {
    const conn = connect();
    latest().open();
    const data = vi.fn<(value: unknown) => void>();
    const sub = conn.subscribe("settings.watch", { key: "a" }, { data });
    const id = latest().sent[0]!.id;

    latest().receive({ id, type: "data", data: { key: "a", value: 1 } });
    sub.update({ key: "b" });
    sub.close();
    latest().receive({ id, type: "data", data: { key: "a", value: 2 } });

    expect(data.mock.calls).toEqual([[{ key: "a", value: 1 }]]);
    expect(latest().sent.map((m) => [m.type, m.id, m.params])).toEqual([
      ["subscribe", id, { key: "a" }],
      ["update", id, { key: "b" }],
      ["unsubscribe", id, undefined],
    ]);
  });

  it("reconnects after losing the socket and restores subscriptions with their latest params", async () => {
    const conn = connect();
    const states: string[] = [];
    conn.onStateChange(() => states.push(conn.getState()));
    latest().open();
    const sub = conn.subscribe(
      "resources.query",
      { cluster: "c", sort: { field: "name" }, offset: 0, limit: 50 },
      { data: vi.fn<(value: unknown) => void>() },
    );
    const inFlight = conn.request("clusters.list", undefined);

    latest().close();
    await expect(inFlight).rejects.toMatchObject({ code: "disconnected" });
    // Updates while disconnected are kept for the resubscribe, not sent.
    sub.update({ cluster: "c", sort: { field: "name" }, offset: 100, limit: 50 });

    expect(sockets).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(sockets).toHaveLength(2);
    latest().open();

    expect(states).toEqual(["open", "reconnecting", "open"]);
    expect(latest().sent).toEqual([
      expect.objectContaining({
        type: "subscribe",
        method: "resources.query",
        params: expect.objectContaining({ offset: 100 }),
        rev: 1,
      }),
    ]);
  });

  it("backs off between failed attempts and resets after connecting", async () => {
    connect();
    latest().close(); // first attempt fails
    await vi.advanceTimersByTimeAsync(100);
    latest().close(); // second attempt fails
    await vi.advanceTimersByTimeAsync(999);
    expect(sockets).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(sockets).toHaveLength(3);

    latest().open();
    latest().close();
    await vi.advanceTimersByTimeAsync(100);
    expect(sockets).toHaveLength(4);
  });

  it("rejects requests while disconnected instead of queueing them", async () => {
    const conn = connect();
    await expect(conn.request("clusters.list", undefined)).rejects.toMatchObject({
      code: "disconnected",
    });
  });
});

describe("hello verification", () => {
  it("sends nothing and stays connecting until a matching hello", async () => {
    const conn = connect();
    conn.subscribe("settings.watch", { key: "a" }, { data: vi.fn<(value: unknown) => void>() });
    latest().open(false);
    expect(conn.getState()).toBe("connecting");
    expect(latest().sent).toEqual([]);
    await expect(conn.request("clusters.list", undefined)).rejects.toMatchObject({
      code: "disconnected",
    });
    latest().receive({ id: 0, type: "hello", hello: { protocol: Hash } });
    expect(conn.getState()).toBe("open");
    expect(latest().sent).toEqual([
      { id: 1, type: "subscribe", method: "settings.watch", params: { key: "a" }, rev: 0 },
    ]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(conn.getState()).toBe("open");
  });

  it.each([
    ["another hash", { id: 0, type: "hello", hello: { protocol: "other" } }],
    ["a first message other than hello", { id: 1, type: "data", data: 1 }],
    ["a hello without its protocol", { id: 0, type: "hello" }],
  ] as const)("becomes outdated for %s and never reconnects", async (_, message) => {
    const conn = connect();
    const data = vi.fn<(value: unknown) => void>();
    conn.subscribe("settings.watch", { key: "a" }, { data });
    latest().open(false);
    latest().receive(message);
    expect(conn.getState()).toBe("outdated");
    expect(latest().sent).toEqual([]);
    expect(data).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledWith("Engine protocol mismatch", {
      client: Hash,
      engine: message.type === "hello" && "hello" in message ? message.hello.protocol : undefined,
    });
    await expect(conn.request("clusters.list", undefined)).rejects.toMatchObject({
      code: "disconnected",
    });
    await vi.advanceTimersByTimeAsync(60000);
    expect(sockets).toHaveLength(1);
    expect(conn.getState()).toBe("outdated");
    conn.close();
    expect(conn.getState()).toBe("closed");
  });

  it("becomes outdated when no hello arrives within the timeout", async () => {
    const conn = connect();
    conn.subscribe("settings.watch", { key: "a" }, { data: vi.fn<(value: unknown) => void>() });
    latest().open(false);
    await vi.advanceTimersByTimeAsync(4999);
    expect(conn.getState()).toBe("connecting");
    await vi.advanceTimersByTimeAsync(1);
    expect(conn.getState()).toBe("outdated");
    expect(console.warn).toHaveBeenCalledWith("Engine protocol mismatch", {
      client: Hash,
      engine: undefined,
    });
    expect(latest().sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(60000);
    expect(sockets).toHaveLength(1);
  });

  it("reconnects with backoff when sockets close before hello", async () => {
    const conn = connect();
    latest().open(false);
    latest().close();
    await vi.advanceTimersByTimeAsync(100);
    latest().open(false);
    expect(conn.getState()).toBe("reconnecting");
    expect(latest().sent).toEqual([]);
    latest().close();
    await vi.advanceTimersByTimeAsync(999);
    expect(sockets).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(sockets).toHaveLength(3);
    latest().open();
    latest().close();
    await vi.advanceTimersByTimeAsync(100);
    expect(sockets).toHaveLength(4);
  });

  it("cancels the hello timeout on close", async () => {
    const conn = connect();
    latest().open(false);
    conn.close();
    await vi.advanceTimersByTimeAsync(60000);
    expect(conn.getState()).toBe("closed");
    expect(sockets).toHaveLength(1);
    expect(console.warn).not.toHaveBeenCalled();
  });
});

describe("subscription revisions", () => {
  it("drops data and errors for replaced params and delivers the current revision", () => {
    const conn = connect();
    latest().open();
    const data = vi.fn<(value: unknown) => void>(),
      error = vi.fn<(value: unknown) => void>();
    const sub = conn.subscribe("settings.watch", { key: "a" }, { data, error });
    const id = latest().sent[0]!.id;
    sub.update({ key: "b" });
    latest().receive({ id, type: "data", rev: 0, data: { key: "a", value: 1 } });
    latest().receive({ id, type: "error", rev: 0, error: { code: "internal", message: "old" } });
    expect(data).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    latest().receive({ id, type: "data", rev: 1, data: { key: "b", value: 2 } });
    latest().receive({
      id,
      type: "error",
      rev: 1,
      error: { code: "internal", message: "current" },
    });
    expect(data).toHaveBeenCalledWith({ key: "b", value: 2 });
    expect(error).toHaveBeenCalledWith({ code: "internal", message: "current" });
    expect(latest().sent[1]).toMatchObject({ type: "update", rev: 1 });
  });
});
