import type { ConnectionState, EngineEndpoint, StreamState } from "./client.ts";
import type { RequestMethod, TopicMethod, StreamMethod } from "./methods.gen.ts";
import type { ErrorDetail, StreamGap, StreamEnd } from "./protocol.gen.ts";

/** Messages from the main thread to the connection Worker. */
export type ToWorker =
  | { kind: "connect"; endpoint: EngineEndpoint }
  | { kind: "request"; id: number; method: RequestMethod; params: unknown }
  | { kind: "subscribe"; id: number; method: TopicMethod; params: unknown }
  | { kind: "update"; id: number; count: number; params: unknown }
  | { kind: "unsubscribe"; id: number }
  | { kind: "stream-open"; id: number; method: StreamMethod; params: unknown }
  | { kind: "stream-pause" | "stream-resume" | "stream-close"; id: number }
  | { kind: "stream-ack"; id: number; token: number; bytes: number }
  | { kind: "close" };

/** Messages from the connection Worker to the main thread. */
export type FromWorker =
  | { kind: "stream-state"; id: number; state: StreamState }
  | { kind: "stream-event"; id: number; event: unknown }
  | { kind: "stream-data"; id: number; data: unknown; bytes: number; token: number }
  | { kind: "stream-gap"; id: number; gap: StreamGap }
  | { kind: "stream-end"; id: number; end: StreamEnd }
  | { kind: "state"; state: ConnectionState }
  | { kind: "result"; id: number; data: unknown }
  | { kind: "failure"; id: number; code: string; message: string }
  | { kind: "data"; id: number; count: number; data: unknown }
  | { kind: "error"; id: number; count: number; error: ErrorDetail };
