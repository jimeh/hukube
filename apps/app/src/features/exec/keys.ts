export type ExecKeyAction =
  | "terminal"
  | "copy"
  | "paste"
  | "find"
  | "selectAll"
  | "goToResource"
  | "leave";

type KeyFields = Pick<
  KeyboardEvent,
  "key" | "code" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey"
>;

/**
 * What a key does while an Exec Session's terminal has focus (ADR-0023). An
 * ended session's process takes no keys, so they go back to the window and
 * Tab moves focus again.
 */
export function execKey(
  mac: boolean,
  event: KeyFields,
  selection: boolean,
  live = true,
): ExecKeyAction {
  const action = liveKey(mac, event, selection);
  return !live && action === "terminal" ? "leave" : action;
}

/**
 * Whether a key pressed in a session's terminal opens Go to Resource.
 * windowRule is what the key means outside a terminal, which an ended
 * session's terminal goes back to.
 */
export function opensGoToResource(
  mac: boolean,
  event: KeyFields,
  selection: boolean,
  live: boolean,
  windowRule: boolean,
): boolean {
  return execKey(mac, event, selection, live) === "goToResource" || (!live && windowRule);
}

/** How the keys read in a menu or a tooltip. */
export function execKeyLabels(mac: boolean) {
  return mac
    ? { copy: "⌘C", paste: "⌘V", selectAll: "⌘A", find: "⌘F", goToResource: "⌘K" }
    : {
        copy: "Ctrl+Shift+C",
        paste: "Ctrl+V",
        selectAll: undefined,
        find: "Ctrl+Shift+F",
        goToResource: "Ctrl+Shift+K",
      };
}

function liveKey(mac: boolean, event: KeyFields, selection: boolean): ExecKeyAction {
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
