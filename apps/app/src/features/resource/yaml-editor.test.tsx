// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import YamlEditor from "./yaml-editor.tsx";

const fake = vi.hoisted(() => {
  let text = "";
  let position = { lineNumber: 1, column: 1 };
  return {
    getValue: () => text,
    setValue: (value: string) => {
      text = value;
    },
    getPosition: () => position,
    setPosition: vi.fn<(value: typeof position) => void>((value) => {
      position = value;
    }),
    focus: vi.fn<() => void>(),
    revealLineInCenterIfOutsideViewport: () => {},
    saveViewState: () => null,
    restoreViewState: () => {},
    updateOptions: () => {},
    getModel: () => ({}),
    onDidChangeModelContent: () => ({ dispose: () => {} }),
    addAction: () => {},
    createContextKey: () => ({ set: () => {} }),
    dispose: () => {},
  };
});
vi.mock("@/lib/monaco.ts", () => ({
  monaco: {
    editor: { create: () => fake, setModelMarkers: () => {}, remeasureFonts: () => {} },
    KeyMod: { CtrlCmd: 1 },
    KeyCode: { KeyS: 1 },
    MarkerSeverity: { Error: 1 },
  },
}));
vi.mock("./editor-theme.ts", () => ({ applyEditorTheme: () => {} }));
vi.mock("@/lib/theme.ts", () => ({ useTheme: () => "light" }));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
it("focuses the editor when Edit starts, at its remapped content line", () => {
  Object.defineProperty(document, "fonts", {
    configurable: true,
    value: { load: () => Promise.resolve() },
  });
  const view = render(
    <YamlEditor value={"metadata:\n  uid: u\n  name: web\ndata:\n  greeting: hello\n"} />,
  );
  fake.setPosition({ lineNumber: 5, column: 8 });
  view.rerender(
    <YamlEditor editing value={"metadata:\n  name: web\ndata:\n  greeting: hello\n"} />,
  );
  expect(fake.setPosition).toHaveBeenLastCalledWith({ lineNumber: 4, column: 8 });
  expect(fake.focus).toHaveBeenCalledOnce();
});
