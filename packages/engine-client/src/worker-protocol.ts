import type { ConnectionState, EngineEndpoint } from "./client.ts";
import type { RequestMethod, TopicMethod } from "./methods.gen.ts";
import type { ErrorDetail } from "./protocol.gen.ts";

/** Messages from the main thread to the connection Worker. */
export type ToWorker =
  | { kind: "connect"; endpoint: EngineEndpoint }
  | { kind: "request"; id: number; method: RequestMethod; params: unknown }
  | { kind: "subscribe"; id: number; method: TopicMethod; params: unknown }
  | { kind: "update"; id: number; count: number; params: unknown }
  | { kind: "unsubscribe"; id: number }
  | { kind: "close" };

/** Messages from the connection Worker to the main thread. */
export type FromWorker =
  | { kind: "state"; state: ConnectionState }
  | { kind: "result"; id: number; data: unknown }
  | { kind: "failure"; id: number; code: string; message: string }
  | { kind: "data"; id: number; count: number; data: unknown }
  | { kind: "error"; id: number; count: number; error: ErrorDetail };
