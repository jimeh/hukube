import { StreamPool, type StreamDelivery } from "./streams.ts";
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
} from "./client.ts";
import type {
  RequestMethod,
  Requests,
  TopicMethod,
  Topics,
  StreamMethod,
  Streams,
} from "./methods.gen.ts";
import {
  Hash,
  MaxClientMessageBytes,
  Subprotocol,
  TokenSubprotocolPrefix,
  type ClientMessage,
  type ServerMessage,
} from "./protocol.gen.ts";

/** The subset of WebSocket that EngineConnection uses. */
export interface SocketLike {
  binaryType?: string;
  send(data: string | Uint8Array<ArrayBuffer>): void;
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
  /** Maximum wait for the Engine's first hello message. */
  helloTimeoutMs?: number;
}

interface ActiveSubscription {
  rev: number;
  method: TopicMethod;
  params: unknown;
  listener: SubscriptionListener<unknown>;
}

interface PendingRequest {
  cleanup(): void;
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
  readonly #streams: StreamPool;
  readonly #url: string;
  readonly #protocols: string[];
  readonly #createSocket: SocketFactory;
  readonly #retryDelays: number[];
  readonly #helloTimeoutMs: number;

  #socket: SocketLike | undefined;
  #state: ConnectionState = "connecting";
  #attempt = 0;
  #retryTimer: ReturnType<typeof setTimeout> | undefined;
  #helloTimer: ReturnType<typeof setTimeout> | undefined;
  #nextId = 1;
  readonly #pending = new Map<number, PendingRequest>();
  readonly #subscriptions = new Map<number, ActiveSubscription>();
  readonly #stateListeners = new Set<() => void>();

  constructor(options: ConnectionOptions) {
    this.#streams = new StreamPool(options, () => this.#outdated(undefined));
    this.#url = `${options.url.replace(/^http/, "ws")}/ws`;
    this.#protocols = [Subprotocol, TokenSubprotocolPrefix + options.token];
    this.#createSocket =
      options.createSocket ?? ((url, protocols) => new WebSocket(url, protocols));
    this.#retryDelays = options.retryDelaysMs ?? defaultRetryDelays;
    this.#helloTimeoutMs = options.helloTimeoutMs ?? 5000;
    this.#connect();
  }

  openStream<M extends StreamMethod>(
    method: M,
    params: Streams[M]["params"],
    listener: StreamListener<M>,
    delivery?: StreamDelivery<M>,
  ): EngineStream {
    return this.#streams.open(method, params, listener, delivery);
  }

  request<M extends RequestMethod>(
    method: M,
    params: Requests[M]["params"],
    options?: RequestOptions,
  ): Promise<Requests[M]["result"]> {
    if (options?.signal?.aborted) {
      return Promise.reject(
        new EngineRequestError({ code: "cancelled", message: "Request cancelled" }),
      );
    }
    if (this.#state !== "open") {
      return Promise.reject(
        new EngineRequestError({ code: "not_connected", message: "not connected to the Engine" }),
      );
    }
    const id = this.#nextId++;
    const encoded = JSON.stringify({ id, type: "request", method, params });
    // A character is at most three bytes of UTF-8, so most messages need no measuring.
    if (
      encoded.length * 3 > MaxClientMessageBytes &&
      new TextEncoder().encode(encoded).byteLength > MaxClientMessageBytes
    ) {
      // Sending it would close the socket, and every subscription with it.
      return Promise.reject(
        new EngineRequestError({
          code: "too_large",
          message: "The request is larger than the Engine accepts.",
        }),
      );
    }
    return new Promise((resolve, reject) => {
      const signal = options?.signal;
      const abort = () => {
        if (!this.#pending.delete(id)) return;
        cleanup();
        this.#send({ id, type: "cancel" });
        reject(new EngineRequestError({ code: "cancelled", message: "Request cancelled" }));
      };
      const cleanup = () => signal?.removeEventListener("abort", abort);
      this.#pending.set(id, { resolve, reject, cleanup });
      signal?.addEventListener("abort", abort, { once: true });
      this.#socket?.send(encoded);
    });
  }

  subscribe<M extends TopicMethod>(
    method: M,
    params: Topics[M]["params"],
    listener: SubscriptionListener<Topics[M]["data"]>,
  ): Subscription<Topics[M]["params"]> {
    const id = this.#nextId++;
    const sub: ActiveSubscription = {
      rev: 0,
      method,
      params,
      listener: listener as SubscriptionListener<unknown>,
    };
    this.#subscriptions.set(id, sub);
    if (this.#state === "open") {
      this.#send({ id, type: "subscribe", method, params, rev: sub.rev });
    }
    return {
      update: (next) => {
        if (!this.#subscriptions.has(id)) return;
        sub.params = next;
        sub.rev++;
        if (this.#state === "open") this.#send({ id, type: "update", params: next, rev: sub.rev });
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
    this.#streams.close();
    clearTimeout(this.#retryTimer);
    clearTimeout(this.#helloTimer);
    const socket = this.#socket;
    this.#socket = undefined;
    socket?.close();
    this.#failPending();
    this.#setState("closed");
  }

  #connect(): void {
    if (this.#state === "outdated" || this.#state === "closed") return;
    const socket = this.#createSocket(this.#url, this.#protocols);
    this.#socket = socket;
    let verified = false;
    socket.onopen = () => {
      if (this.#socket !== socket) return;
      this.#helloTimer = setTimeout(() => this.#outdated(undefined), this.#helloTimeoutMs);
    };
    socket.onmessage = (event) => {
      if (this.#socket !== socket) return;
      if (!verified) {
        let msg: ServerMessage | undefined;
        try {
          if (typeof event.data === "string") msg = JSON.parse(event.data) as ServerMessage;
        } catch {
          // An Engine without this protocol cannot be used.
        }
        if (msg?.type !== "hello" || msg.hello?.protocol !== Hash) {
          this.#outdated(msg?.hello?.protocol);
          return;
        }
        verified = true;
        clearTimeout(this.#helloTimer);
        this.#attempt = 0;
        this.#setState("open");
        for (const [id, sub] of this.#subscriptions) {
          this.#send({
            id,
            type: "subscribe",
            method: sub.method,
            params: sub.params,
            rev: sub.rev,
          });
        }
      } else if (typeof event.data === "string") {
        this.#receive(JSON.parse(event.data) as ServerMessage);
      }
    };
    socket.onclose = () => {
      if (this.#socket !== socket) return;
      this.#socket = undefined;
      clearTimeout(this.#helloTimer);
      this.#failPending();
      this.#setState("reconnecting");
      const delay =
        this.#retryDelays[Math.min(this.#attempt, this.#retryDelays.length - 1)] ?? 1000;
      this.#attempt++;
      this.#retryTimer = setTimeout(() => this.#connect(), delay);
    };
  }

  #outdated(protocol: string | undefined): void {
    this.#streams.close();
    clearTimeout(this.#retryTimer);
    clearTimeout(this.#helloTimer);
    const socket = this.#socket;
    this.#socket = undefined;
    socket?.close();
    this.#failPending();
    console.warn("Engine protocol mismatch", { client: Hash, engine: protocol });
    this.#setState("outdated");
  }

  #receive(msg: ServerMessage): void {
    const pending = this.#pending.get(msg.id);
    if (pending) {
      this.#pending.delete(msg.id);
      pending.cleanup();
      if (msg.type === "error" && msg.error) {
        pending.reject(new EngineRequestError(msg.error));
      } else {
        pending.resolve(msg.data);
      }
      return;
    }
    // Data for a closed subscription can still be in flight; ignore it.
    const sub = this.#subscriptions.get(msg.id);
    if (!sub || (msg.rev ?? 0) !== sub.rev) return;
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
    for (const pending of this.#pending.values()) {
      pending.cleanup();
      pending.reject(error);
    }
    this.#pending.clear();
  }

  #setState(state: ConnectionState): void {
    if (this.#state === state) return;
    this.#state = state;
    for (const fn of this.#stateListeners) fn();
  }
}
