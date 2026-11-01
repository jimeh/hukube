type KeyFields = Pick<KeyboardEvent, "key" | "code" | "metaKey" | "ctrlKey">;
/** Logical Mod+J, including the existing non-Latin code fallback, stays reserved. */
export function isReservedKey(mac: boolean, event: KeyFields): boolean {
  const key = event.key.toLowerCase();
  const letter = /^[a-z]$/.test(key) ? key : event.code.replace(/^Key/, "").toLowerCase();
  return (mac ? event.metaKey : event.ctrlKey) && letter === "j";
}
/** Byte policy after the window command arbiter has decided. No command executes here. */
export function terminalTakesKey(
  mac: boolean,
  event: Pick<KeyboardEvent, "key" | "code" | "metaKey" | "ctrlKey">,
  live: boolean,
  verdict?: "handled" | "paste",
): boolean {
  if (verdict) return false;
  if (isReservedKey(mac, event)) return false;
  if (mac && event.metaKey) return false;
  return live;
}
