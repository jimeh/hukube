import type { ExecParams } from "./protocol.gen.ts";
import { StreamChannelStdout } from "./protocol.gen.ts";

/** Exec output keeps the container's bytes for the terminal to parse. */
export class ExecCodec {
  readonly resumable = false;
  beginSocket(): void {}
  params(params: ExecParams): ExecParams {
    return params;
  }
  event(event: undefined): undefined {
    return event;
  }
  decode(frame: ArrayBuffer): Uint8Array {
    const data = new Uint8Array(frame);
    if (data[0] !== StreamChannelStdout) throw new Error("Unknown Exec Session channel");
    return data.subarray(1);
  }
}
