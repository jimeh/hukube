// @vitest-environment jsdom
import type * as Monaco from "monaco-editor/editor/editor.api";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { applyEditorTheme } from "./editor-theme.ts";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it("waits for its element to be attached before reading the theme's colors", () => {
  const defineTheme = vi.fn<typeof Monaco.editor.defineTheme>();
  const monaco = {
    editor: { defineTheme, setTheme: vi.fn<typeof Monaco.editor.setTheme>() },
  } as unknown as typeof Monaco;
  const element = document.createElement("div");
  applyEditorTheme(monaco, element, true);
  vi.advanceTimersToNextFrame();
  expect(defineTheme).not.toHaveBeenCalled();
  document.body.append(element);
  vi.advanceTimersToNextFrame();
  expect(defineTheme).toHaveBeenCalledOnce();

  const detached = document.createElement("div");
  const cancel = applyEditorTheme(monaco, detached, true);
  cancel();
  document.body.append(detached);
  vi.advanceTimersToNextFrame();
  expect(defineTheme).toHaveBeenCalledOnce();
});
