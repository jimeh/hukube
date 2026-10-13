import { vi } from "vitest";
import type { ExecTerminal } from "./sessions.ts";

const noop = () => {};

export function fakeTerminal() {
  let data: (text: string) => void = noop;
  let binary: (text: string) => void = noop;
  let resize: (size: { cols: number; rows: number }) => void = noop;
  let find: () => void = noop;
  let results: (result: { resultIndex: number; resultCount: number }) => void = noop;
  const element = document.createElement("div");
  const terminal = {
    element,
    ready: Promise.resolve(),
    cols: 80,
    rows: 24,
    write: vi.fn<(bytes: Uint8Array | string, done?: () => void) => void>(),
    reset: vi.fn<() => void | Promise<void>>(),
    dispose: vi.fn<() => void>(),
    setEnded: vi.fn<(ended: boolean) => void>(),
    focus: vi.fn<() => void>(),
    theme: vi.fn<() => void>(),
    attach: vi.fn<(body: HTMLElement, visible: boolean) => () => void>((body, _visible) => {
      body.append(element);
      return () => element.remove();
    }),
    onData: (fn: typeof data) => {
      data = fn;
      return () => {
        data = noop;
      };
    },
    onBinary: (fn: typeof binary) => {
      binary = fn;
      return () => {
        binary = noop;
      };
    },
    onResize: (fn: typeof resize) => {
      resize = fn;
      return () => {
        resize = noop;
      };
    },
    onFind: (fn: typeof find) => {
      find = fn;
      return () => {
        find = noop;
      };
    },
    onSearchResults: (fn: typeof results) => {
      results = fn;
      return () => {
        results = noop;
      };
    },
    hasSelection: () => false,
    copy: vi.fn<() => void>(),
    paste: vi.fn<(text: string) => void>(),
    selectAll: vi.fn<() => void>(),
    clear: vi.fn<() => void>(),
    find: vi.fn<(text: string, previous?: boolean, incremental?: boolean) => void>(),
    clearSearch: vi.fn<() => void>(),
  } satisfies ExecTerminal;
  return {
    terminal,
    data: (text: string) => data(text),
    binary: (text: string) => binary(text),
    resize: (cols: number, rows: number) => resize({ cols, rows }),
    find: () => find(),
    results: (resultIndex: number, resultCount: number) => results({ resultIndex, resultCount }),
  };
}
