import type { ExecParams, ExecSync } from "./protocol.gen.ts";
import { StreamChannelStdout } from "./protocol.gen.ts";

/** Exec output keeps the container's bytes for the terminal to parse. */
export class ExecCodec {
  readonly input = true;
  readonly pausable = false;
  #offset?: number;
  beginSocket(): void {}
  params(params: ExecParams): ExecParams {
    if (this.#offset === undefined) return params;
    const { start: _start, takeover: _takeover, ...rest } = params;
    return { ...rest, resume: this.#offset };
  }
  event(event: ExecSync): ExecSync {
    this.#offset = event.offset;
    return event;
  }
  decode(frame: ArrayBuffer): Uint8Array {
    const data = new Uint8Array(frame);
    if (data[0] !== StreamChannelStdout) throw new Error("Unknown Exec Session channel");
    if (this.#offset !== undefined) this.#offset += data.byteLength - 1;
    return data.subarray(1);
  }
}
