import {
  EngineRequestError,
  type ConnectionState,
  type EngineClient,
  type EngineEndpoint,
  type Subscription,
  type SubscriptionListener,
} from "./client.ts";
import type { RequestMethod, Requests, TopicMethod, Topics } from "./methods.gen.ts";
import type { ErrorDetail } from "./protocol.gen.ts";
import type { FromWorker, ToWorker } from "./worker-protocol.ts";

/**
 * An EngineClient whose connection runs in a Web Worker. It mirrors the
 * Worker's connection state and relays requests and subscriptions.
 */
export class WorkerEngineClient implements EngineClient {
  readonly #worker: Worker;
  #state: ConnectionState = "connecting";
  #nextId = 1;
  readonly #pending = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>();
  readonly #listeners = new Map<
    number,
    { listener: SubscriptionListener<unknown>; count: number }
  >();
  readonly #stateListeners = new Set<() => void>();

  constructor(endpoint: EngineEndpoint) {
    this.#worker = new Worker(new URL("./worker.ts", import.meta.url), {
      type: "module",
      name: "engine-connection",
    });
    this.#worker.onmessage = (event: MessageEvent<FromWorker>) => this.#receive(event.data);
    this.#post({ kind: "connect", endpoint });
  }

  request<M extends RequestMethod>(
    method: M,
    params: Requests[M]["params"],
  ): Promise<Requests[M]["result"]> {
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
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
    this.#state = "closed";
    for (const fn of this.#stateListeners) fn();
  }

  #receive(msg: FromWorker): void {
    switch (msg.kind) {
      case "state":
        this.#state = msg.state;
        for (const fn of this.#stateListeners) fn();
        break;
      case "result":
      case "failure": {
        const pending = this.#pending.get(msg.id);
        this.#pending.delete(msg.id);
        if (msg.kind === "result") pending?.resolve(msg.data);
        else
          pending?.reject(
            new EngineRequestError({ code: msg.code, message: msg.message } as ErrorDetail),
          );
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

  #post(msg: ToWorker): void {
    this.#worker.postMessage(msg);
  }
}
