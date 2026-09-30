import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EngineConnection, type SocketLike } from "./connection.ts";
import type { ClientMessage, ServerMessage } from "./protocol.gen.ts";

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
  open() {
    this.onopen?.(new Event("open"));
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
});
afterEach(() => {
  vi.useRealTimers();
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
