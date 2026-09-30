// Runs the Engine connection off the main thread, so parsing bursts of
// socket messages does not block rendering (ADR-0004).
import { EngineRequestError, type Subscription } from "./client.ts";
import { EngineConnection } from "./connection.ts";
import type { RequestMethod, TopicMethod } from "./methods.ts";
import type { FromWorker, ToWorker } from "./worker-protocol.ts";

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<ToWorker>) => void) | null;
  postMessage(message: FromWorker): void;
};

let connection: EngineConnection | undefined;
const subscriptions = new Map<number, Subscription<unknown>>();

scope.onmessage = ({ data: msg }) => {
  switch (msg.kind) {
    case "connect": {
      const conn = new EngineConnection(msg.endpoint);
      connection = conn;
      conn.onStateChange(() => scope.postMessage({ kind: "state", state: conn.getState() }));
      break;
    }
    case "request":
      connection?.request(msg.method as RequestMethod, msg.params as never).then(
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
      const sub = connection?.subscribe(msg.method as TopicMethod, msg.params as never, {
        data: (data) => scope.postMessage({ kind: "data", id: msg.id, data }),
        error: (error) => scope.postMessage({ kind: "error", id: msg.id, error }),
      });
      if (sub) subscriptions.set(msg.id, sub as Subscription<unknown>);
      break;
    }
    case "update":
      subscriptions.get(msg.id)?.update(msg.params);
      break;
    case "unsubscribe":
      subscriptions.get(msg.id)?.close();
      subscriptions.delete(msg.id);
      break;
    case "close":
      connection?.close();
      break;
  }
};
