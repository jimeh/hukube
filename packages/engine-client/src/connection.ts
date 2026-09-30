import {
  EngineRequestError,
  type ConnectionState,
  type EngineClient,
  type EngineEndpoint,
  type Subscription,
  type SubscriptionListener,
} from "./client.ts";
import type { RequestMethod, Requests, TopicMethod, Topics } from "./methods.ts";
import {
  Subprotocol,
  TokenSubprotocolPrefix,
  type ClientMessage,
  type ServerMessage,
} from "./protocol.gen.ts";

/** The subset of WebSocket that EngineConnection uses. */
export interface SocketLike {
  send(data: string): void;
  close(): void;
  onopen: ((event: Event) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
}

export type SocketFactory = (url: string, protocols: string[]) => SocketLike;

export interface ConnectionOptions extends EngineEndpoint {
  createSocket?: SocketFactory;
  /** Delays before successive reconnection attempts; the last one repeats. */
  retryDelaysMs?: number[];
}

interface ActiveSubscription {
  method: TopicMethod;
  params: unknown;
  listener: SubscriptionListener<unknown>;
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
}

const defaultRetryDelays = [250, 500, 1000, 2000, 5000];

/**
 * A control socket connection to the Engine. It reconnects after losing the
 * socket and restores every subscription with its latest params. Requests in
 * flight when the socket drops are rejected.
 */
export class EngineConnection implements EngineClient {
  readonly #url: string;
  readonly #protocols: string[];
  readonly #createSocket: SocketFactory;
  readonly #retryDelays: number[];

  #socket: SocketLike | undefined;
  #state: ConnectionState = "connecting";
  #attempt = 0;
  #retryTimer: ReturnType<typeof setTimeout> | undefined;
  #nextId = 1;
  readonly #pending = new Map<number, PendingRequest>();
  readonly #subscriptions = new Map<number, ActiveSubscription>();
  readonly #stateListeners = new Set<() => void>();

  constructor(options: ConnectionOptions) {
    this.#url = `${options.url.replace(/^http/, "ws")}/ws`;
    this.#protocols = [Subprotocol, TokenSubprotocolPrefix + options.token];
    this.#createSocket =
      options.createSocket ?? ((url, protocols) => new WebSocket(url, protocols));
    this.#retryDelays = options.retryDelaysMs ?? defaultRetryDelays;
    this.#connect();
  }

  request<M extends RequestMethod>(
    method: M,
    params: Requests[M]["params"],
  ): Promise<Requests[M]["result"]> {
    if (this.#state !== "open") {
      return Promise.reject(
        new EngineRequestError({ code: "disconnected", message: "not connected to the Engine" }),
      );
    }
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#send({ id, type: "request", method, params });
    });
  }

  subscribe<M extends TopicMethod>(
    method: M,
    params: Topics[M]["params"],
    listener: SubscriptionListener<Topics[M]["data"]>,
  ): Subscription<Topics[M]["params"]> {
    const id = this.#nextId++;
    const sub: ActiveSubscription = {
      method,
      params,
      listener: listener as SubscriptionListener<unknown>,
    };
    this.#subscriptions.set(id, sub);
    if (this.#state === "open") {
      this.#send({ id, type: "subscribe", method, params });
    }
    return {
      update: (next) => {
        if (!this.#subscriptions.has(id)) return;
        sub.params = next;
        if (this.#state === "open") this.#send({ id, type: "update", params: next });
      },
      close: () => {
        if (!this.#subscriptions.delete(id)) return;
        if (this.#state === "open") this.#send({ id, type: "unsubscribe" });
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
    clearTimeout(this.#retryTimer);
    const socket = this.#socket;
    this.#socket = undefined;
    socket?.close();
    this.#failPending();
    this.#setState("closed");
  }

  #connect(): void {
    const socket = this.#createSocket(this.#url, this.#protocols);
    this.#socket = socket;
    socket.onopen = () => {
      if (this.#socket !== socket) return;
      this.#attempt = 0;
      this.#setState("open");
      for (const [id, sub] of this.#subscriptions) {
        this.#send({ id, type: "subscribe", method: sub.method, params: sub.params });
      }
    };
    socket.onmessage = (event) => {
      if (this.#socket === socket && typeof event.data === "string") {
        this.#receive(JSON.parse(event.data) as ServerMessage);
      }
    };
    socket.onclose = () => {
      if (this.#socket !== socket) return;
      this.#socket = undefined;
      this.#failPending();
      this.#setState("reconnecting");
      const delay =
        this.#retryDelays[Math.min(this.#attempt, this.#retryDelays.length - 1)] ?? 1000;
      this.#attempt++;
      this.#retryTimer = setTimeout(() => this.#connect(), delay);
    };
  }

  #receive(msg: ServerMessage): void {
    const pending = this.#pending.get(msg.id);
    if (pending) {
      this.#pending.delete(msg.id);
      if (msg.type === "error" && msg.error) {
        pending.reject(new EngineRequestError(msg.error));
      } else {
        pending.resolve(msg.data);
      }
      return;
    }
    // Data for a closed subscription can still be in flight; ignore it.
    const sub = this.#subscriptions.get(msg.id);
    if (!sub) return;
    if (msg.type === "error" && msg.error) {
      sub.listener.error?.(msg.error);
    } else if (msg.type === "data") {
      sub.listener.data(msg.data);
    }
  }

  #send(msg: ClientMessage): void {
    this.#socket?.send(JSON.stringify(msg));
  }

  #failPending(): void {
    const error = new EngineRequestError({
      code: "disconnected",
      message: "lost connection to the Engine",
    });
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }

  #setState(state: ConnectionState): void {
    if (this.#state === state) return;
    this.#state = state;
    for (const fn of this.#stateListeners) fn();
  }
}
