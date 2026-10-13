import type { EngineStream, StreamData, StreamListener, StreamState } from "./client.ts";
import type { ConnectionOptions, SocketLike } from "./connection.ts";
import { LogCodec } from "./log-codec.ts";
import type { StreamMethod, Streams } from "./methods.gen.ts";
import {
  Hash,
  StreamSubprotocol,
  TokenSubprotocolPrefix,
  type StreamEnd,
  type StreamServerMessage,
} from "./protocol.gen.ts";

/**
 * What a stream method's events and frames pass through before they reach a
 * listener. A codec lives as long as its stream, across sockets, so it can
 * hold what opening the stream again needs.
 */
export interface StreamCodec<M extends StreamMethod> {
  /** Called before each socket opens. */
  beginSocket(params: Streams[M]["params"]): void;
  /** The params to open a socket with, including what resumes the stream. */
  params(params: Streams[M]["params"]): Streams[M]["params"];
  event(event: Streams[M]["event"]): Streams[M]["event"];
  decode(frame: ArrayBuffer): StreamData[M];
}

const codecs: { [M in StreamMethod]: () => StreamCodec<M> } = {
  "resource.logs": () => new LogCodec(),
};

/** The Worker defers consumption until its main-thread listener returns. */
export type StreamDelivery<M extends StreamMethod> = (
  data: StreamData[M],
  bytes: number,
  acknowledge: () => void,
) => void;

export class StreamPool {
  readonly #active = new Set<SocketStream>();
  readonly #waiting: SocketStream[] = [];
  readonly #all = new Set<SocketStream>();
  #closed = false;
  constructor(
    readonly options: ConnectionOptions,
    readonly outdated: () => void,
  ) {}

  open<M extends StreamMethod>(
    method: M,
    params: Streams[M]["params"],
    listener: StreamListener<M>,
    delivery?: StreamDelivery<M>,
  ): EngineStream {
    const stream = new SocketStream(
      this,
      method,
      params,
      listener as StreamListener<StreamMethod>,
      delivery as StreamDelivery<StreamMethod> | undefined,
    );
    this.#all.add(stream);
    queueMicrotask(() => {
      if (this.#closed) stream.close();
      else stream.start();
    });
    return stream;
  }
  acquire(stream: SocketStream): void {
    if (this.#closed) return;
    if (this.#active.has(stream) || this.#waiting.includes(stream)) return;
    if (this.#active.size >= 8) {
      this.#waiting.push(stream);
      stream.state("waiting");
      return;
    }
    this.#active.add(stream);
    stream.connect();
  }
  release(stream: SocketStream): void {
    this.#active.delete(stream);
    const index = this.#waiting.indexOf(stream);
    if (index !== -1) this.#waiting.splice(index, 1);
    const next = this.#closed || this.#active.size >= 8 ? undefined : this.#waiting.shift();
    if (next) {
      this.#active.add(next);
      next.connect();
    }
  }
  forget(stream: SocketStream): void {
    this.#all.delete(stream);
  }
  close(): void {
    this.#closed = true;
    for (const stream of this.#all) stream.close();
  }
}

class SocketStream implements EngineStream {
  readonly #codec: StreamCodec<StreamMethod>;
  #socket?: SocketLike;
  #timer?: ReturnType<typeof setTimeout>;
  #helloTimer?: ReturnType<typeof setTimeout>;
  #attempt = 0;
  #paused = true;
  #started = false;
  #heldBack = false;
  #ended = false;
  #closed = false;
  constructor(
    readonly pool: StreamPool,
    readonly method: StreamMethod,
    readonly params: Streams[StreamMethod]["params"],
    readonly listener: StreamListener<StreamMethod>,
    readonly delivery?: StreamDelivery<StreamMethod>,
  ) {
    this.#codec = codecs[method]();
  }

  state(state: StreamState): void {
    if (!this.#closed) this.listener.state?.(state);
  }
  /** Opens the first socket, unless the stream was paused before it could. */
  start(): void {
    this.#started = true;
    if (!this.#heldBack) this.resume();
  }
  pause(): void {
    if (!this.#started) this.#heldBack = true;
    if (this.#closed || this.#ended || this.#paused) return;
    this.#paused = true;
    this.#disconnect();
    this.pool.release(this);
    this.state("paused");
  }
  resume(): void {
    this.#heldBack = false;
    if (!this.#started || this.#closed || this.#ended || !this.#paused) return;
    this.#paused = false;
    this.pool.acquire(this);
  }
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#disconnect();
    this.pool.release(this);
    this.pool.forget(this);
  }
  #disconnect(): void {
    clearTimeout(this.#timer);
    clearTimeout(this.#helloTimer);
    const socket = this.#socket;
    this.#socket = undefined;
    socket?.close();
  }
  #end(end: StreamEnd): void {
    this.#ended = true;
    this.#disconnect();
    this.pool.release(this);
    this.state("ended");
    this.listener.end(end);
  }
  connect(): void {
    if (this.#closed || this.#paused || this.#ended) return;
    this.state(this.#attempt ? "reconnecting" : "connecting");
    const options = this.pool.options;
    const create = options.createSocket ?? ((url, protocols) => new WebSocket(url, protocols));
    const socket = create(`${options.url.replace(/^http/, "ws")}/ws/stream`, [
      StreamSubprotocol,
      TokenSubprotocolPrefix + options.token,
    ]);
    socket.binaryType = "arraybuffer";
    this.#socket = socket;
    this.#codec.beginSocket(this.params);
    let verified = false;
    let received = 0;
    let consumed = 0;
    const mismatch = () => {
      this.#end({
        reason: "error",
        error: {
          code: "internal",
          message: "The window is out of date. Reload to use this Engine.",
        },
      });
      this.pool.outdated();
    };
    socket.onopen = () => {
      if (this.#socket === socket)
        this.#helloTimer = setTimeout(mismatch, options.helloTimeoutMs ?? 5000);
    };
    socket.onmessage = ({ data }) => {
      if (this.#socket !== socket) return;
      let message: StreamServerMessage | undefined;
      try {
        if (typeof data === "string") message = JSON.parse(data) as StreamServerMessage;
      } catch {
        if (!verified) mismatch();
        else
          this.#end({
            reason: "error",
            error: { code: "internal", message: "Invalid stream message" },
          });
        return;
      }
      if (!verified) {
        if (message?.type !== "hello" || message.hello?.protocol !== Hash) {
          mismatch();
          return;
        }
        verified = true;
        clearTimeout(this.#helloTimer);
        this.#attempt = 0;
        socket.send(
          JSON.stringify({
            type: "open",
            method: this.method,
            params: this.#codec.params(this.params),
          }),
        );
        this.state("open");
        return;
      }
      if (data instanceof ArrayBuffer) {
        let lines: StreamData[StreamMethod];
        try {
          lines = this.#codec.decode(data);
        } catch (error) {
          this.#end({ reason: "error", error: { code: "internal", message: String(error) } });
          return;
        }
        received += data.byteLength;
        const total = received;
        const acknowledge = () => {
          if (this.#socket !== socket || total <= consumed) return;
          consumed = total;
          socket.send(JSON.stringify({ type: "ack", bytes: consumed }));
        };
        if (this.delivery) this.delivery(lines, data.byteLength, acknowledge);
        else {
          this.listener.data(lines);
          acknowledge();
        }
      } else if (message?.type === "event")
        this.listener.event(this.#codec.event(message.event as Streams[StreamMethod]["event"]));
      else if (message?.type === "gap" && message.gap) this.listener.gap(message.gap);
      else if (message?.type === "end" && message.end) this.#end(message.end);
    };
    socket.onclose = () => {
      if (this.#socket !== socket) return;
      this.#socket = undefined;
      clearTimeout(this.#helloTimer);
      this.state("reconnecting");
      const delays = options.retryDelaysMs ?? [250, 500, 1000, 2000, 5000];
      const delay = delays[Math.min(this.#attempt++, delays.length - 1)] ?? 1000;
      // A retry keeps its place in the cap, so waiting streams cannot starve it.
      this.#timer = setTimeout(() => this.connect(), delay);
    };
  }
}
