import type { EngineStream, StreamData, StreamListener, StreamState } from "./client.ts";
import type { ConnectionOptions, SocketLike } from "./connection.ts";
import { ExecCodec } from "./exec-codec.ts";
import { LogCodec } from "./log-codec.ts";
import type { StreamMethod, Streams } from "./methods.gen.ts";
import {
  Hash,
  ExecInputFrame,
  ExecInputWindow,
  StreamChannelStdin,
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
  readonly input: boolean;
  readonly pausable: boolean;
  /** Called before each socket opens. */
  beginSocket(params: Streams[M]["params"]): void;
  /** The params to open a socket with, including what resumes the stream. */
  params(params: Streams[M]["params"]): Streams[M]["params"];
  event(event: Streams[M]["event"]): Streams[M]["event"];
  decode(frame: ArrayBuffer): StreamData[M];
}

const codecs: { [M in StreamMethod]: () => StreamCodec<M> } = {
  "resource.logs": () => new LogCodec(),
  "pod.exec": () => new ExecCodec(),
};

/**
 * The most input a stream holds for a process that is not reading it. A write
 * that would add to waiting input beyond this is refused and reported, so a
 * container that never reads cannot take the window's memory one paste at a
 * time. A write is always accepted when nothing is waiting, however large:
 * one paste is the user's to make.
 */
export const streamInputPendingLimit = 8 << 20;

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
  #opened = false;
  #attached = false;
  #input: { data: Uint8Array; offset: number }[] = [];
  #inputPending = 0;
  #inputSent = 0;
  #inputAcked = 0;
  #size?: { cols: number; rows: number };
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
    if (!this.#codec.pausable) return;
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
  write(data: Uint8Array): void {
    if (!this.#codec.input || !data.byteLength) return;
    // Input for a stream that is not attached is dropped without a report:
    // its terminal already shows that it takes none.
    if (this.#closed || this.#ended || !this.#opened || !this.#attached) return;
    if (this.#inputPending > 0 && this.#inputPending + data.byteLength > streamInputPendingLimit) {
      this.listener.inputDropped?.(data.byteLength);
      return;
    }
    this.#input.push({ data, offset: 0 });
    this.#inputPending += data.byteLength;
    this.#flushInput();
  }
  resize(cols: number, rows: number): void {
    if (!this.#codec.input || this.#closed || this.#ended) return;
    if (![cols, rows].every((size) => Number.isInteger(size) && size > 0 && size <= 65535)) return;
    this.#size = { cols, rows };
    if (this.#opened) this.#socket?.send(JSON.stringify({ type: "resize", cols, rows }));
  }
  #flushInput(): void {
    if (!this.#opened || !this.#socket || this.#closed || this.#ended) return;
    while (this.#input.length && this.#inputSent - this.#inputAcked < ExecInputWindow) {
      const pending = this.#input[0]!;
      const size = Math.min(
        ExecInputFrame,
        ExecInputWindow - (this.#inputSent - this.#inputAcked),
        pending.data.byteLength - pending.offset,
      );
      const frame = new Uint8Array(size + 1);
      frame[0] = StreamChannelStdin;
      frame.set(pending.data.subarray(pending.offset, pending.offset + size), 1);
      this.#socket.send(frame);
      this.#inputSent += size;
      this.#inputPending -= size;
      pending.offset += size;
      if (pending.offset === pending.data.byteLength) this.#input.shift();
    }
  }
  #disconnect(code?: number): void {
    clearTimeout(this.#timer);
    clearTimeout(this.#helloTimer);
    const socket = this.#socket;
    this.#socket = undefined;
    this.#dropInput();
    socket?.close(code);
  }
  #dropInput(): void {
    const dropped = this.#inputPending;
    this.#input = [];
    this.#inputPending = this.#inputSent = this.#inputAcked = 0;
    this.#opened = this.#attached = false;
    if (dropped) this.listener.inputDropped?.(dropped);
  }
  #end(end: StreamEnd): void {
    this.#ended = true;
    // A normal close confirms receipt of end to the Engine.
    this.#disconnect(1000);
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
    const pendingConsumption: { total: number; done: boolean }[] = [];
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
            params: this.#codec.params(
              this.#codec.input && this.#size ? { ...this.params, ...this.#size } : this.params,
            ),
          }),
        );
        this.#opened = true;
        this.#flushInput();
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
        const entry = { total: received, done: false };
        pendingConsumption.push(entry);
        const acknowledge = () => {
          if (this.#socket !== socket || entry.done) return;
          entry.done = true;
          while (pendingConsumption[0]?.done) consumed = pendingConsumption.shift()!.total;
          if (consumed) socket.send(JSON.stringify({ type: "ack", bytes: consumed }));
        };
        if (this.delivery) this.delivery(lines, data.byteLength, acknowledge);
        else {
          try {
            const result = this.listener.data(lines);
            if (result) void Promise.resolve(result).then(acknowledge, acknowledge);
            else acknowledge();
          } catch {
            acknowledge();
          }
        }
      } else if (message?.type === "ack" && this.#codec.input) {
        const bytes = message.bytes ?? 0;
        if (!Number.isSafeInteger(bytes) || bytes < this.#inputAcked || bytes > this.#inputSent) {
          this.#end({
            reason: "error",
            error: { code: "internal", message: "Invalid input acknowledgement" },
          });
          return;
        }
        this.#inputAcked = bytes;
        this.#flushInput();
      } else if (message?.type === "event") {
        if (this.#codec.input) this.#attached = true;
        this.listener.event(this.#codec.event(message.event as Streams[StreamMethod]["event"]));
      } else if (message?.type === "gap" && message.gap) this.listener.gap(message.gap);
      else if (message?.type === "end" && message.end) this.#end(message.end);
    };
    socket.onclose = () => {
      if (this.#socket !== socket) return;
      this.#socket = undefined;
      clearTimeout(this.#helloTimer);
      this.#dropInput();
      this.state("reconnecting");
      const delays = options.retryDelaysMs ?? [250, 500, 1000, 2000, 5000];
      const delay = delays[Math.min(this.#attempt++, delays.length - 1)] ?? 1000;
      // A retry keeps its place in the cap, so waiting streams cannot starve it.
      this.#timer = setTimeout(() => this.connect(), delay);
    };
  }
}
