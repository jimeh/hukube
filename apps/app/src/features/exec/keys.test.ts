import { describe, expect, it } from "vitest";
import { execKey, execKeyLabels, type ExecKeyAction } from "./keys.ts";

const event = (key: string, mac: boolean, shiftKey = false) => ({
  key,
  code: `Key${key.toUpperCase()}`,
  metaKey: mac,
  ctrlKey: !mac,
  altKey: false,
  shiftKey,
});
describe.each([true, false])("Exec Session keys, macOS=%s", (mac) => {
  const rows: [string, string, boolean, boolean, ExecKeyAction][] = [];
  for (const selected of [false, true])
    rows.push(
      ["Go to Resource", "k", !mac, selected, "goToResource"],
      ["Copy", "c", false, selected, mac || selected ? "copy" : "terminal"],
      ["Paste", "v", false, selected, "paste"],
      ["Find", "f", !mac, selected, "find"],
      ["Select all", "a", false, selected, mac ? "selectAll" : "terminal"],
      ["Mod+J", "j", false, selected, "leave"],
    );
  if (!mac)
    for (const selected of [false, true])
      rows.push(
        ["Ctrl+Shift+C", "c", true, selected, "copy"],
        ["Ctrl+Shift+V", "v", true, selected, "paste"],
        ["Ctrl+K", "k", false, selected, "terminal"],
        ["Ctrl+F", "f", false, selected, "terminal"],
      );
  it.each(rows)("%s, key=%s, shift=%s, selection=%s", (_label, key, shift, selection, action) => {
    expect(execKey(mac, event(key, mac, shift), selection)).toBe(action);
  });
  it("gives an ended session's keys back to the window, and keeps the Host's", () => {
    const tab = { ...event("x", false), key: "Tab", code: "Tab", ctrlKey: false };
    expect(execKey(mac, tab, false, false)).toBe("leave");
    expect(execKey(mac, event("x", false), false, false)).toBe("leave");
    expect(execKey(mac, event("f", mac, !mac), false, false)).toBe("find");
    expect(execKey(mac, event("k", mac, !mac), false, false)).toBe("goToResource");
    expect(execKey(mac, event("j", mac), false, false)).toBe("leave");
  });
  it("labels each key the table gives the Host", () => {
    const labels = execKeyLabels(mac);
    expect(labels.find).toBe(mac ? "⌘F" : "Ctrl+Shift+F");
    expect(labels.goToResource).toBe(mac ? "⌘K" : "Ctrl+Shift+K");
    expect(labels.copy).toBe(mac ? "⌘C" : "Ctrl+Shift+C");
    expect(labels.paste).toBe(mac ? "⌘V" : "Ctrl+V");
    expect(labels.selectAll).toBe(mac ? "⌘A" : undefined);
  });
  it("leaves Alt modifiers to the Host or process, and accepts a non-Latin key position", () => {
    expect(execKey(mac, { ...event("k", mac), altKey: true }, false)).toBe(
      mac ? "leave" : "terminal",
    );
    expect(execKey(mac, { ...event("ж", mac, !mac), code: "KeyK" }, false)).toBe("goToResource");
    expect(
      execKey(mac, { ...event("x", false), key: "Tab", code: "Tab", ctrlKey: false }, false),
    ).toBe("terminal");
  });
});
