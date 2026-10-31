import type { Setting } from "@hukube/engine-client";
import type { SerializedDockview } from "dockview-react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { persistLayout, type LayoutTarget } from "./layout-persistence.ts";

const layout = (name: string) => ({ grid: { name } }) as unknown as SerializedDockview;

function setup() {
  let deliver: ((setting: Setting) => void) | undefined;
  const puts: unknown[] = [];
  const client = {
    subscribe: (_method: string, _params: unknown, listener: { data: (s: Setting) => void }) => {
      deliver = listener.data;
      return { update: () => {}, close: () => {} };
    },
    request: (_method: string, params: unknown) => {
      puts.push(params);
      return Promise.resolve(undefined);
    },
  } as unknown as Parameters<typeof persistLayout>[0];

  let current = layout("initial");
  let onChange: (() => void) | undefined;
  const target: LayoutTarget = {
    fromJSON: (l) => {
      current = l;
    },
    toJSON: () => current,
    clear: () => {},
    onDidLayoutChange: (listener) => {
      onChange = listener;
      return { dispose: () => {} };
    },
  };
  const change = (name: string) => {
    current = layout(name);
    onChange?.();
  };
  const dispose = persistLayout(client, target, "workspace/c", 400);
  return {
    deliver: (setting: Setting) => deliver?.(setting),
    puts,
    change,
    dispose,
    current: () => current,
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("persistLayout", () => {
  it("restores the stored layout and saves later changes after a pause", () => {
    const s = setup();
    s.deliver({
      revision: "",
      key: "workspace/c",
      value: { version: 1, dockview: layout("stored") },
    });
    expect(s.current()).toEqual(layout("stored"));

    s.change("a");
    s.change("b");
    vi.advanceTimersByTime(399);
    expect(s.puts).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(s.puts).toEqual([{ key: "workspace/c", value: { version: 1, dockview: layout("b") } }]);
  });

  it("does not save before the stored layout has been restored", () => {
    const s = setup();
    s.change("too-early");
    vi.advanceTimersByTime(1000);
    expect(s.puts).toEqual([]);
  });

  it("writes a pending change when stopped instead of dropping it", () => {
    const s = setup();
    s.deliver({ revision: "", key: "workspace/c", value: null });
    s.change("rearranged");
    s.dispose();
    expect(s.puts).toEqual([
      { key: "workspace/c", value: { version: 1, dockview: layout("rearranged") } },
    ]);

    vi.advanceTimersByTime(1000);
    expect(s.puts).toHaveLength(1);
  });
});

it("immutably strips only native zoom metadata on restore and save", () => {
  const grid = Object.freeze({
    root: { size: 123 },
    width: 1200,
    height: 800,
    orientation: "HORIZONTAL",
    maximizedNode: { location: [0] },
  });
  const original = Object.freeze({
    grid,
    panels: { a: { params: { uri: "a/yaml", preview: true } } },
    activeGroup: "one",
    floatingGroups: [],
  }) as unknown as SerializedDockview;
  const fromJSON = vi.fn<LayoutTarget["fromJSON"]>();
  const request = vi.fn<(...args: unknown[]) => Promise<void>>(() => Promise.resolve());
  let deliver!: (setting: Setting) => void;
  let changed!: () => void;
  const target: LayoutTarget = {
    fromJSON,
    toJSON: () => original,
    clear: vi.fn<() => void>(),
    onDidLayoutChange: (listener) => {
      changed = listener;
      return { dispose() {} };
    },
  };
  const client = {
    request,
    subscribe: (_method: unknown, _params: unknown, listener: { data: typeof deliver }) => {
      deliver = listener.data;
      return { close() {} };
    },
  } as unknown as Parameters<typeof persistLayout>[0];
  const dispose = persistLayout(client, target, "workspace/c");
  deliver({ revision: "", key: "workspace/c", value: { version: 1, dockview: original } });
  const normalized = {
    ...original,
    grid: { root: grid.root, width: 1200, height: 800, orientation: "HORIZONTAL" },
  };
  expect(fromJSON).toHaveBeenCalledWith(normalized);
  expect(fromJSON.mock.calls[0]![0]).not.toBe(original);
  expect(fromJSON.mock.calls[0]![0].grid).not.toBe(grid);
  changed();
  vi.advanceTimersByTime(400);
  expect(request).toHaveBeenCalledWith("settings.put", {
    key: "workspace/c",
    value: { version: 1, dockview: normalized },
  });
  expect(original.grid).toHaveProperty("maximizedNode", { location: [0] });
  expect(original.panels).toBe(normalized.panels);
  dispose();
});

it("keeps malformed layout recovery inside the existing restore boundary", () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  let deliver!: (setting: Setting) => void;
  const clear = vi.fn<() => void>();
  const restored = vi.fn<() => void>();
  const fromJSON = vi.fn<LayoutTarget["fromJSON"]>();
  const dispose = persistLayout(
    {
      subscribe: (_method: unknown, _params: unknown, listener: { data: typeof deliver }) => {
        deliver = listener.data;
        return { close() {} };
      },
    } as unknown as Parameters<typeof persistLayout>[0],
    {
      fromJSON,
      clear,
      toJSON: () => layout("empty"),
      onDidLayoutChange: () => ({ dispose() {} }),
    },
    "workspace/c",
    400,
    restored,
  );
  deliver({ revision: "", key: "workspace/c", value: { version: 1, dockview: null } });
  expect(clear).toHaveBeenCalledOnce();
  expect(fromJSON).not.toHaveBeenCalled();
  expect(restored).toHaveBeenCalledOnce();
  expect(warn).toHaveBeenCalledWith("Discarding unreadable Workspace layout", expect.any(Error));
  dispose();
  warn.mockRestore();
});
