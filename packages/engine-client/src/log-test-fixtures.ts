import type { LogSource, LogStreamStatus } from "./protocol.gen.ts";
export const source: LogSource = {
  id: 7,
  pod: "web-a",
  podUid: "uid",
  container: "constructor",
  instance: "run1",
  state: "running",
};
export const status: LogStreamStatus = {
  ready: true,
  sources: [source],
  containers: [{ name: "constructor", kind: "container" }],
  pods: 1,
  followed: 1,
  loaded: 1,
};
export function frame(
  id = 7,
  flags = 0,
  time = 1234567890n,
  content: string | Uint8Array = "line",
): ArrayBuffer {
  const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
  const buffer = new ArrayBuffer(16 + bytes.length);
  const view = new DataView(buffer);
  view.setUint8(0, 1);
  view.setUint16(1, id);
  view.setUint8(3, flags);
  view.setBigInt64(4, time);
  view.setUint32(12, bytes.length);
  new Uint8Array(buffer, 16).set(bytes);
  return buffer;
}
