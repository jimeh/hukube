import {
  EngineRequestError,
  type ConnectionState,
  type EngineClient,
  type EngineEndpoint,
  type Subscription,
  type SubscriptionListener,
} from "./client.ts";
import type { RequestMethod, Requests, TopicMethod, Topics } from "./methods.ts";
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
  readonly #listeners = new Map<number, SubscriptionListener<unknown>>();
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
    this.#listeners.set(id, listener as SubscriptionListener<unknown>);
    this.#post({ kind: "subscribe", id, method, params });
    return {
      update: (next) => {
        if (this.#listeners.has(id)) this.#post({ kind: "update", id, params: next });
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
      case "data":
        this.#listeners.get(msg.id)?.data(msg.data);
        break;
      case "error":
        this.#listeners.get(msg.id)?.error?.(msg.error);
        break;
    }
  }

  #post(msg: ToWorker): void {
    this.#worker.postMessage(msg);
  }
}
