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
  type StreamGap,
  type StreamGapSource,
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

  beginSocket(_params?: Pick<LogStreamParams, "previous">): void {
    this.#sources.clear();
  }

  event(status: LogStreamStatus): LogStreamStatus {
    const engineIds = new Set(status.sources.map((source) => source.id));
    for (const id of this.#sources.keys()) if (!engineIds.has(id)) this.#sources.delete(id);
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
      for (const id of this.#cursors.keys()) if (!current.has(id)) this.#cursors.delete(id);
      for (const [key, id] of this.#identities)
        if (!current.has(id) && !this.#cursors.has(id)) {
          this.#identities.delete(key);
          this.#exited.delete(id);
        }
    }
    return { ...status, sources };
  }

  params(params: LogStreamParams): LogStreamParams {
    return { ...params, resume: [...this.#cursors.values()] };
  }

  gap(gap: StreamGap): StreamGap {
    if (!Number.isSafeInteger(gap.records) || gap.records <= 0)
      throw new Error("Invalid Log Stream gap record count");
    if (!Array.isArray(gap.sources) || gap.sources.length === 0)
      throw new Error("Log Stream gap has no source totals");
    const engineIds = new Set<number>();
    const stableIds = new Set<number>();
    const sources: StreamGapSource[] = [];
    let total = 0;
    for (const source of gap.sources) {
      if (!Number.isSafeInteger(source.id) || source.id < 0 || engineIds.has(source.id))
        throw new Error("Log Stream gap has a duplicate or invalid source ID");
      if (!Number.isSafeInteger(source.records) || source.records <= 0)
        throw new Error("Log Stream gap has an invalid source total");
      const current = this.#sources.get(source.id);
      if (!current) throw new Error("Log Stream gap has an unknown source");
      if (stableIds.has(current.id)) throw new Error("Log Stream gap maps duplicate sources");
      engineIds.add(source.id);
      stableIds.add(current.id);
      total += source.records;
      if (!Number.isSafeInteger(total)) throw new Error("Log Stream gap source total is unsafe");
      sources.push({ id: current.id, records: source.records });
    }
    if (total !== gap.records) throw new Error("Log Stream gap source totals do not match records");
    sources.sort((a, b) => a.id - b.id);
    return { ...gap, sources };
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
      const instance = source.instance ?? "";
      if (this.#exited.get(source.id) === instance) continue;
      if (flags & LogRecordFlagExited) {
        this.#exited.set(source.id, instance);
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

  /** Narrow diagnostics for source/cursor liveness tests; not sent to the main thread. */
  diagnostics(): {
    identities: number;
    socketSources: number;
    cursors: number;
    exited: number;
    nextStableId: number;
  } {
    return {
      identities: this.#identities.size,
      socketSources: this.#sources.size,
      cursors: this.#cursors.size,
      exited: this.#exited.size,
      nextStableId: this.#nextId,
    };
  }
}
