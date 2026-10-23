// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import YamlEditor from "./yaml-editor.tsx";

const decorations = vi.hoisted(() => ({
  set: vi.fn<(value: unknown[]) => void>(),
  clear: vi.fn<() => void>(),
}));
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
    getModel: () => ({
      getLineCount: () => 100,
      getPositionAt: (offset: number) => ({
        lineNumber: text.slice(0, offset).split("\n").length,
        column: offset - text.lastIndexOf("\n", offset - 1),
      }),
    }),
    createDecorationsCollection: () => decorations,
    getDomNode: () => null,
    pushUndoStop: vi.fn<() => void>(),
    executeEdits: vi.fn<(source: string, edits: unknown[]) => void>(),
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

it("installs current draft markers on a late mount and clears them on revert", () => {
  Object.defineProperty(document, "fonts", {
    configurable: true,
    value: { load: () => Promise.resolve() },
  });
  const view = render(<YamlEditor editing baseText={"a: 1\n"} value={"a: 2\n"} />);
  expect(decorations.set).toHaveBeenLastCalledWith([
    expect.objectContaining({
      options: expect.objectContaining({ linesDecorationsClassName: "yaml-change-modified" }),
    }),
  ]);
  view.rerender(<YamlEditor editing baseText={"a: 1\n"} value={"a: 1\n"} />);
  expect(decorations.set).toHaveBeenLastCalledWith([]);
});
it("uses minimal replacement edits after editable entry, with undo stops for a field", () => {
  Object.defineProperty(document, "fonts", {
    configurable: true,
    value: { load: () => Promise.resolve() },
  });
  const view = render(<YamlEditor editing baseText={"a: 1\n"} value={"a: 1\n"} />);
  view.rerender(<YamlEditor editing editGroup="field" baseText={"a: 1\n"} value={"a: 2\n"} />);
  expect(fake.executeEdits).toHaveBeenLastCalledWith("hukube.overview", [
    expect.objectContaining({
      text: "2",
      range: { startLineNumber: 1, startColumn: 4, endLineNumber: 1, endColumn: 5 },
    }),
  ]);
  expect(fake.pushUndoStop).toHaveBeenCalled();
});
