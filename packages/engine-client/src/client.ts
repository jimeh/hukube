import type {
  RequestMethod,
  Requests,
  TopicMethod,
  Topics,
  StreamMethod,
  Streams,
} from "./methods.gen.ts";
import type { LogLine } from "./log-codec.ts";
import type { ErrorDetail, StreamGap, StreamEnd } from "./protocol.gen.ts";

/** The state of the connection to the Engine. */
export type ConnectionState = "connecting" | "open" | "reconnecting" | "outdated" | "closed";

export interface SubscriptionListener<T> {
  data: (value: T) => void;
  error?: (error: ErrorDetail) => void;
}

export interface Subscription<P> {
  /** Replaces the params in place, such as when a list scrolls. */
  update: (params: P) => void;
  close: () => void;
}

export type StreamState = "waiting" | "connecting" | "open" | "reconnecting" | "paused" | "ended";
export interface StreamData {
  "resource.logs": LogLine[];
}
export interface StreamListener<M extends StreamMethod> {
  state?: (state: StreamState) => void;
  event: (event: Streams[M]["event"]) => void;
  data: (data: StreamData[M]) => void;
  gap: (gap: StreamGap) => void;
  end: (end: StreamEnd) => void;
}
export interface EngineStream {
  pause(): void;
  resume(): void;
  close(): void;
}

/** A client of the Engine's control and stream methods. */
export interface EngineClient {
  openStream<M extends StreamMethod>(
    method: M,
    params: Streams[M]["params"],
    listener: StreamListener<M>,
  ): EngineStream;
  request<M extends RequestMethod>(
    method: M,
    params: Requests[M]["params"],
  ): Promise<Requests[M]["result"]>;
  subscribe<M extends TopicMethod>(
    method: M,
    params: Topics[M]["params"],
    listener: SubscriptionListener<Topics[M]["data"]>,
  ): Subscription<Topics[M]["params"]>;
  getState(): ConnectionState;
  /** Calls fn after the state changes; returns a function that stops it. */
  onStateChange(fn: () => void): () => void;
  close: () => void;
}

/** Where the Engine listens and the token it requires. */
export interface EngineEndpoint {
  url: string;
  token: string;
}

export class EngineRequestError extends Error {
  readonly code: ErrorDetail["code"] | "disconnected";

  constructor(detail: ErrorDetail | { code: "disconnected"; message: string }) {
    super(detail.message);
    this.name = "EngineRequestError";
    this.code = detail.code;
  }
}
