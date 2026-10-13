export type ExecKeyAction =
  | "terminal"
  | "copy"
  | "paste"
  | "find"
  | "selectAll"
  | "goToResource"
  | "leave";

/** The keys kept by the Host while an Exec Session has focus. */
export function execKey(
  mac: boolean,
  event: Pick<KeyboardEvent, "key" | "code" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">,
  selection: boolean,
): ExecKeyAction {
  const letter = event.key.toLowerCase();
  const key = /^[a-z]$/.test(letter) ? letter : event.code.replace(/^Key/, "").toLowerCase();
  if ((mac ? event.metaKey : event.ctrlKey) && key === "j" && !event.altKey && !event.shiftKey)
    return "leave";
  if (mac) {
    if (!event.metaKey) return "terminal";
    if (event.ctrlKey || event.altKey || event.shiftKey) return "leave";
    switch (key) {
      case "k":
        return "goToResource";
      case "c":
        return "copy";
      case "v":
        return "paste";
      case "f":
        return "find";
      case "a":
        return "selectAll";
      default:
        return "leave";
    }
  }
  if (!event.ctrlKey || event.metaKey || event.altKey) return "terminal";
  if (key === "v") return "paste";
  if (key === "c" && (event.shiftKey || selection)) return "copy";
  if (event.shiftKey && key === "k") return "goToResource";
  if (event.shiftKey && key === "f") return "find";
  return "terminal";
}
