// @vitest-environment jsdom
import { expect, it } from "vitest";
import {
  HotkeyRecorder,
  parseHotkey,
  normalizeHotkey,
  matchesKeyboardEvent,
  formatForDisplay,
  createSequenceMatcher,
} from "@tanstack/hotkeys";
it("installed 0.18 logical, physical, aliases, punctuation and platform seam", () => {
  expect(normalizeHotkey("cmd+shift+p", "mac")).toBe("Mod+Shift+P");
  expect(parseHotkey("Mod+K", "linux").ctrl).toBe(true);
  expect(
    matchesKeyboardEvent(
      new KeyboardEvent("keydown", { key: "ж", code: "KeyK", ctrlKey: true }),
      "Mod+K",
      "linux",
    ),
  ).toBe(true);
  expect(
    matchesKeyboardEvent(
      new KeyboardEvent("keydown", { key: "x", code: "KeyK", ctrlKey: true }),
      parseHotkey("Mod+[KeyK]", "linux"),
      "linux",
    ),
  ).toBe(true);
  expect(formatForDisplay("Mod+Shift+P", { platform: "windows" })).toBe("Ctrl+Shift+P");
  expect(normalizeHotkey("Mod+;", "linux")).toBe("Mod+;");
  const sequence = createSequenceMatcher(["G", "H"], { platform: "linux" });
  sequence.match(new KeyboardEvent("keydown", { key: "g" }));
  sequence.reset();
  expect(sequence.match(new KeyboardEvent("keydown", { key: "h" }))).toBe(false);
});
it("installed recorder records logical steps, Enter, edits and Escape without callbacks", () => {
  let recorded: unknown;
  let cancelled = false;
  const recorder = new HotkeyRecorder({
    platform: "linux",
    recordBy: "key",
    ignoreInputs: false,
    maxSteps: 2,
    onRecord: (value) => (recorded = value),
    onCancel: () => (cancelled = true),
  });
  recorder.start();
  document.dispatchEvent(
    new KeyboardEvent("keydown", { key: "k", code: "KeyK", ctrlKey: true, bubbles: true }),
  );
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  expect(recorded).toBe("Mod+K");
  recorder.start();
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "g", code: "KeyG", bubbles: true }));
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Backspace", bubbles: true }));
  expect(recorder.store.state.steps).toEqual([]);
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  expect(cancelled).toBe(true);
  recorder.destroy();
});
