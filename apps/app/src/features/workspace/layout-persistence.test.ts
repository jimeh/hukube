import type { Setting } from "@hukube/engine-client";
import type { SerializedDockview } from "dockview-react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { persistLayout, type LayoutTarget } from "./layout-persistence.ts";

const layout = (name: string) => ({ grid: name }) as unknown as SerializedDockview;

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
    s.deliver({ key: "workspace/c", value: { version: 1, dockview: layout("stored") } });
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
    s.deliver({ key: "workspace/c", value: null });
    s.change("rearranged");
    s.dispose();
    expect(s.puts).toEqual([
      { key: "workspace/c", value: { version: 1, dockview: layout("rearranged") } },
    ]);

    vi.advanceTimersByTime(1000);
    expect(s.puts).toHaveLength(1);
  });
});
