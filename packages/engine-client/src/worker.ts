// Runs the Engine connection off the main thread, so parsing bursts of
// socket messages does not block rendering (ADR-0004).
import { EngineRequestError, type Subscription, type EngineStream } from "./client.ts";
import { EngineConnection } from "./connection.ts";
import type { FromWorker, ToWorker } from "./worker-protocol.ts";

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<ToWorker>) => void) | null;
  postMessage(message: FromWorker): void;
};

let connection: EngineConnection | undefined;
const requests = new Map<number, AbortController>();
const subscriptions = new Map<number, { sub: Subscription<unknown>; count: number }>();

const streams = new Map<number, EngineStream>();
const acknowledgements = new Map<number, { id: number; acknowledge: () => void }>();
let nextToken = 1;
scope.onmessage = ({ data: msg }) => {
  switch (msg.kind) {
    case "connect": {
      const conn = new EngineConnection(msg.endpoint);
      connection = conn;
      conn.onStateChange(() => scope.postMessage({ kind: "state", state: conn.getState() }));
      break;
    }
    case "stream-open": {
      const stream = connection?.openStream(
        msg.method,
        msg.params as never,
        {
          state: (state) => scope.postMessage({ kind: "stream-state", id: msg.id, state }),
          event: (event) => scope.postMessage({ kind: "stream-event", id: msg.id, event }),
          data: () => {},
          gap: (gap) => scope.postMessage({ kind: "stream-gap", id: msg.id, gap }),
          end: (end) => scope.postMessage({ kind: "stream-end", id: msg.id, end }),
        },
        (data, bytes, acknowledge) => {
          const token = nextToken++;
          acknowledgements.set(token, { id: msg.id, acknowledge });
          scope.postMessage({ kind: "stream-data", id: msg.id, data, bytes, token });
        },
      );
      if (stream) streams.set(msg.id, stream);
      break;
    }
    case "stream-ack": {
      const pending = acknowledgements.get(msg.token);
      if (pending?.id === msg.id) {
        pending.acknowledge();
        acknowledgements.delete(msg.token);
      }
      break;
    }
    case "stream-pause":
      streams.get(msg.id)?.pause();
      break;
    case "stream-resume":
      streams.get(msg.id)?.resume();
      break;
    case "stream-close":
      streams.get(msg.id)?.close();
      streams.delete(msg.id);
      for (const [token, pending] of acknowledgements)
        if (pending.id === msg.id) acknowledgements.delete(token);
      break;
    case "cancel":
      requests.get(msg.id)?.abort();
      break;
    case "request": {
      const controller = new AbortController();
      requests.set(msg.id, controller);
      connection?.request(msg.method, msg.params as never, { signal: controller.signal }).then(
        (data) => {
          requests.delete(msg.id);
          scope.postMessage({ kind: "result", id: msg.id, data });
        },
        (err: unknown) => {
          requests.delete(msg.id);
          const error =
            err instanceof EngineRequestError
              ? { code: err.code, message: err.message, reason: err.reason, causes: err.causes }
              : {
                  code: "internal" as const,
                  message: err instanceof Error ? err.message : String(err),
                };
          scope.postMessage({ kind: "failure", id: msg.id, error });
        },
      );
      break;
    }
    case "subscribe": {
      const active = { count: 0 };
      const sub = connection?.subscribe(msg.method, msg.params as never, {
        data: (data) => scope.postMessage({ kind: "data", id: msg.id, count: active.count, data }),
        error: (error) =>
          scope.postMessage({ kind: "error", id: msg.id, count: active.count, error }),
      });
      if (sub)
        subscriptions.set(msg.id, Object.assign(active, { sub: sub as Subscription<unknown> }));
      break;
    }
    case "update": {
      const active = subscriptions.get(msg.id);
      if (active) {
        active.count = msg.count;
        active.sub.update(msg.params);
      }
      break;
    }
    case "unsubscribe":
      subscriptions.get(msg.id)?.sub.close();
      subscriptions.delete(msg.id);
      break;
    case "close":
      connection?.close();
      break;
  }
};
