import {
  EngineRequestError,
  type ConnectionState,
  type EngineClient,
  type RequestOptions,
  type EngineEndpoint,
  type Subscription,
  type SubscriptionListener,
  type EngineStream,
  type StreamListener,
  type StreamData,
} from "./client.ts";
import type {
  RequestMethod,
  Requests,
  TopicMethod,
  Topics,
  StreamMethod,
  Streams,
} from "./methods.gen.ts";
import type { FromWorker, ToWorker } from "./worker-protocol.ts";

/**
 * An EngineClient whose connection runs in a Web Worker. It mirrors the
 * Worker's connection state and relays requests and subscriptions.
 */
export class WorkerEngineClient implements EngineClient {
  readonly #worker: Worker;
  #state: ConnectionState = "connecting";
  #nextId = 1;
  readonly #pending = new Map<
    number,
    { resolve(v: unknown): void; reject(e: Error): void; cleanup(): void }
  >();
  readonly #listeners = new Map<
    number,
    { listener: SubscriptionListener<unknown>; count: number }
  >();
  readonly #streams = new Map<number, { listener: StreamListener<StreamMethod>; bytes: number }>();
  readonly #stateListeners = new Set<() => void>();

  constructor(endpoint: EngineEndpoint) {
    this.#worker = new Worker(new URL("./worker.ts", import.meta.url), {
      type: "module",
      name: "engine-connection",
    });
    this.#worker.onmessage = (event: MessageEvent<FromWorker>) => this.#receive(event.data);
    this.#post({ kind: "connect", endpoint });
  }

  openStream<M extends StreamMethod>(
    method: M,
    params: Streams[M]["params"],
    listener: StreamListener<M>,
  ): EngineStream {
    const id = this.#nextId++;
    this.#streams.set(id, { listener: listener as StreamListener<StreamMethod>, bytes: 0 });
    this.#post({ kind: "stream-open", id, method, params });
    return {
      write: (data) => {
        if (method !== "pod.exec" || !this.#streams.has(id)) return;
        const bytes = data.buffer instanceof ArrayBuffer ? data : data.slice();
        this.#post({ kind: "stream-write", id, data: bytes }, [bytes.buffer as ArrayBuffer]);
      },
      resize: (cols, rows) => {
        if (method === "pod.exec" && this.#streams.has(id))
          this.#post({ kind: "stream-resize", id, cols, rows });
      },
      pause: () => {
        if (this.#streams.has(id)) this.#post({ kind: "stream-pause", id });
      },
      resume: () => {
        if (this.#streams.has(id)) this.#post({ kind: "stream-resume", id });
      },
      close: () => {
        if (this.#streams.delete(id)) this.#post({ kind: "stream-close", id });
      },
    };
  }

  request<M extends RequestMethod>(
    method: M,
    params: Requests[M]["params"],
    options?: RequestOptions,
  ): Promise<Requests[M]["result"]> {
    if (options?.signal?.aborted)
      return Promise.reject(
        new EngineRequestError({ code: "cancelled", message: "Request cancelled" }),
      );
    if (this.#state !== "open")
      return Promise.reject(
        new EngineRequestError({ code: "not_connected", message: "not connected to the Engine" }),
      );
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const signal = options?.signal;
      const abort = () => {
        if (!this.#pending.delete(id)) return;
        cleanup();
        this.#post({ kind: "cancel", id });
        reject(new EngineRequestError({ code: "cancelled", message: "Request cancelled" }));
      };
      const cleanup = () => signal?.removeEventListener("abort", abort);
      this.#pending.set(id, { resolve, reject, cleanup });
      signal?.addEventListener("abort", abort, { once: true });
      this.#post({ kind: "request", id, method, params });
    });
  }

  subscribe<M extends TopicMethod>(
    method: M,
    params: Topics[M]["params"],
    listener: SubscriptionListener<Topics[M]["data"]>,
  ): Subscription<Topics[M]["params"]> {
    const id = this.#nextId++;
    const active = { listener: listener as SubscriptionListener<unknown>, count: 0 };
    this.#listeners.set(id, active);
    this.#post({ kind: "subscribe", id, method, params });
    return {
      update: (next) => {
        if (!this.#listeners.has(id)) return;
        active.count++;
        this.#post({ kind: "update", id, count: active.count, params: next });
      },
      close: () => {
        if (this.#listeners.delete(id)) this.#post({ kind: "unsubscribe", id });
      },
    };
  }

  getState(): ConnectionState {
    return this.#state;
  }

  onStateChange(fn: () => void): () => void {
    this.#stateListeners.add(fn);
    return () => this.#stateListeners.delete(fn);
  }

  close(): void {
    this.#post({ kind: "close" });
    this.#worker.terminate();
    this.#streams.clear();
    for (const pending of this.#pending.values()) {
      pending.cleanup();
      pending.reject(
        new EngineRequestError({ code: "disconnected", message: "lost connection to the Engine" }),
      );
    }
    this.#pending.clear();
    this.#state = "closed";
    for (const fn of this.#stateListeners) fn();
  }

  #receive(msg: FromWorker): void {
    if (msg.kind.startsWith("stream-")) {
      if (!("id" in msg)) return;
      const active = this.#streams.get(msg.id);
      if (!active) return;
      switch (msg.kind) {
        case "stream-state":
          if (msg.state === "connecting" || msg.state === "reconnecting") active.bytes = 0;
          active.listener.state?.(msg.state);
          break;
        case "stream-event":
          active.listener.event(msg.event as Streams[StreamMethod]["event"]);
          break;
        case "stream-gap":
          active.listener.gap(msg.gap);
          break;
        case "stream-input-dropped":
          active.listener.inputDropped?.(msg.bytes);
          break;
        case "stream-end":
          active.listener.end(msg.end);
          break;
        case "stream-data": {
          active.bytes += msg.bytes;
          const bytes = active.bytes;
          const acknowledge = () => {
            if (this.#streams.get(msg.id) === active)
              this.#post({ kind: "stream-ack", id: msg.id, token: msg.token, bytes });
          };
          try {
            const result = active.listener.data(msg.data as StreamData[StreamMethod]);
            if (result) void Promise.resolve(result).then(acknowledge, acknowledge);
            else acknowledge();
          } catch {
            acknowledge();
          }
          break;
        }
      }
      return;
    }
    switch (msg.kind) {
      case "state":
        this.#state = msg.state;
        for (const fn of this.#stateListeners) fn();
        break;
      case "result":
      case "failure": {
        const pending = this.#pending.get(msg.id);
        this.#pending.delete(msg.id);
        pending?.cleanup();
        if (msg.kind === "result") pending?.resolve(msg.data);
        else pending?.reject(new EngineRequestError(msg.error));
        break;
      }
      case "data": {
        const active = this.#listeners.get(msg.id);
        if (active?.count === msg.count) active.listener.data(msg.data);
        break;
      }
      case "error": {
        const active = this.#listeners.get(msg.id);
        if (active?.count === msg.count) active.listener.error?.(msg.error);
        break;
      }
    }
  }

  #post(msg: ToWorker, transfer?: Transferable[]): void {
    if (transfer) this.#worker.postMessage(msg, transfer);
    else this.#worker.postMessage(msg);
  }
}
