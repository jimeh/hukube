// Runs the Engine connection off the main thread, so parsing bursts of
// socket messages does not block rendering (ADR-0004).
import { EngineRequestError, type Subscription } from "./client.ts";
import { EngineConnection } from "./connection.ts";
import type { FromWorker, ToWorker } from "./worker-protocol.ts";

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<ToWorker>) => void) | null;
  postMessage(message: FromWorker): void;
};

let connection: EngineConnection | undefined;
const subscriptions = new Map<number, { sub: Subscription<unknown>; count: number }>();

scope.onmessage = ({ data: msg }) => {
  switch (msg.kind) {
    case "connect": {
      const conn = new EngineConnection(msg.endpoint);
      connection = conn;
      conn.onStateChange(() => scope.postMessage({ kind: "state", state: conn.getState() }));
      break;
    }
    case "request":
      connection?.request(msg.method, msg.params as never).then(
        (data) => scope.postMessage({ kind: "result", id: msg.id, data }),
        (err: unknown) => {
          const code = err instanceof EngineRequestError ? err.code : "internal";
          scope.postMessage({
            kind: "failure",
            id: msg.id,
            code,
            message: err instanceof Error ? err.message : String(err),
          });
        },
      );
      break;
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
