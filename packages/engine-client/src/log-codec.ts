import { parseLogContent, type LogSpan } from "./log-content.ts";
import {
  LogRecordHeaderSize,
  LogRecordFlagCut,
  LogRecordFlagGap,
  LogRecordFlagExited,
  StreamChannelStdout,
  type LogCursor,
  type LogSource,
  type LogStreamParams,
  type LogStreamStatus,
} from "./protocol.gen.ts";

export interface LogLine {
  source: number;
  /** Milliseconds since the epoch, or 0. */
  time: number;
  text: string;
  spans?: LogSpan[];
  cut?: true;
  gap?: true;
  exited?: true;
}

/** Source identities and cursors belong to the stream, rather than a socket. */
export class LogCodec {
  readonly input = false;
  readonly pausable = true;
  readonly #identities = new Map<string, number>();
  readonly #sources = new Map<number, LogSource>();
  readonly #cursors = new Map<number, LogCursor>();
  readonly #exited = new Map<number, string>();
  #nextId = 0;
  #current = new Set<number>();
  #retained = new Set<number>();
  #pins = new Map<number, number>();
  #reporting = false;
  retainSources(ids: readonly number[]): void {
    this.#reporting = true;
    this.#retained = new Set(ids);
    this.#prune();
  }
  pin(ids: readonly number[]): () => void {
    for (const id of new Set(ids)) this.#pins.set(id, (this.#pins.get(id) ?? 0) + 1);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      for (const id of new Set(ids)) {
        const count = (this.#pins.get(id) ?? 1) - 1;
        if (count) this.#pins.set(id, count);
        else this.#pins.delete(id);
      }
      this.#prune();
    };
  }
  #prune(): void {
    if (!this.#reporting) return;
    for (const [key, id] of this.#identities)
      if (
        !this.#current.has(id) &&
        !this.#retained.has(id) &&
        !this.#pins.has(id) &&
        !this.#cursors.has(id)
      ) {
        this.#identities.delete(key);
        this.#exited.delete(id);
      }
  }
  end(): void {
    this.#current.clear();
    this.#cursors.clear();
    this.#sources.clear();
    this.#prune();
  }
  dispose(): void {
    this.#identities.clear();
    this.#sources.clear();
    this.#cursors.clear();
    this.#exited.clear();
    this.#pins.clear();
    this.#retained.clear();
    this.#current.clear();
  }
  metadataSnapshot() {
    return {
      identities: this.#identities.size,
      wireSources: this.#sources.size,
      cursors: this.#cursors.size,
      exited: this.#exited.size,
      pins: this.#pins.size,
    };
  }

  beginSocket(params?: Pick<LogStreamParams, "previous">): void {
    this.#sources.clear();
    // A previous run is sent again from its start, exited record included.
    if (params?.previous) this.#exited.clear();
  }

  event(status: LogStreamStatus): LogStreamStatus {
    const sources = status.sources.map((source) => {
      const key = JSON.stringify([source.podUid, source.container]);
      let id = this.#identities.get(key);
      if (id === undefined) {
        id = this.#nextId++;
        this.#identities.set(key, id);
      }
      const mapped = { ...source, id };
      this.#sources.set(source.id, mapped);
      return mapped;
    });
    // A Pod that is gone cannot be resumed, so its cursors would only grow the
    // next open. A status that is not ready lists nothing and proves nothing.
    // Nor does one that is ready before a slow Pod's containers are known.
    if (status.ready && status.loaded >= status.followed) {
      const current = new Set(sources.map((source) => source.id));
      this.#current = current;
      const wire = new Set(status.sources.map((source) => source.id));
      for (const id of this.#sources.keys()) if (!wire.has(id)) this.#sources.delete(id);
      for (const id of this.#cursors.keys()) if (!current.has(id)) this.#cursors.delete(id);
    } else for (const source of sources) this.#current.add(source.id);
    return { ...status, sources };
  }

  params(params: LogStreamParams): LogStreamParams {
    return { ...params, resume: [...this.#cursors.values()] };
  }

  decode(buffer: ArrayBuffer): LogLine[] {
    const view = new DataView(buffer);
    if (!view.byteLength || view.getUint8(0) !== StreamChannelStdout)
      throw new Error("Unknown Log Stream channel");
    const lines: LogLine[] = [];
    const decoder = new TextDecoder();
    for (let offset = 1; offset < view.byteLength;) {
      if (offset + LogRecordHeaderSize > view.byteLength)
        throw new Error("Incomplete log record header");
      const source = this.#sources.get(view.getUint16(offset));
      if (!source) throw new Error("Unknown log source");
      const flags = view.getUint8(offset + 2);
      const time = view.getBigInt64(offset + 3);
      const length = view.getUint32(offset + 11);
      offset += LogRecordHeaderSize;
      if (offset + length > view.byteLength) throw new Error("Incomplete log record content");
      const content = decoder.decode(new Uint8Array(buffer, offset, length));
      offset += length;
      if (flags & LogRecordFlagExited) {
        if (this.#exited.has(source.id) && this.#exited.get(source.id) === (source.instance ?? ""))
          continue;
        this.#exited.set(source.id, source.instance ?? "");
      } else if (!(flags & LogRecordFlagGap) && time !== 0n && source.instance) {
        const cursor = this.#cursors.get(source.id);
        if (!cursor || cursor.instance !== source.instance || time > BigInt(cursor.time))
          this.#cursors.set(source.id, {
            podUid: source.podUid,
            container: source.container,
            instance: source.instance,
            time: time.toString(),
          });
      }
      lines.push({
        source: source.id,
        time: Number(time / 1_000_000n),
        ...parseLogContent(content),
        ...(flags & LogRecordFlagCut ? { cut: true as const } : {}),
        ...(flags & LogRecordFlagGap ? { gap: true as const } : {}),
        ...(flags & LogRecordFlagExited ? { exited: true as const } : {}),
      });
    }
    return lines;
  }
}
