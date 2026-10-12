import type { EngineClient } from "@hukube/engine-client";

import { readColumnLayout, type StoredColumnLayout } from "./column-layout.ts";

/**
 * Watches a Resource Type's layout and shows local edits before they are saved.
 * A snapshot of undefined awaits the first setting; null uses the default.
 * Subscriptions share one watch, closed when the last listener leaves.
 *
 * An edit shows at once and stays until the Engine confirms what it holds.
 * Edits are written one at a time, because the Engine may apply two writes in
 * flight in either order. A value the watch delivers during a write is not
 * shown: it may be older than the write or newer, and nothing in it says
 * which. When the writes have settled the store replaces its watch with a new
 * one. The Engine computes a new watch's first value after every write it has
 * already answered, so that value, and any after it, is what the list shows.
 */
export function createColumnLayoutStore(
  client: Pick<EngineClient, "subscribe" | "request">,
  type: string,
) {
  const key = `columns/${type}`;
  let stored: StoredColumnLayout | null | undefined;
  /** The latest local edit, until a watch opened after its write reports. */
  let edit: StoredColumnLayout | null | undefined;
  let snapshot: StoredColumnLayout | null | undefined;
  let writing = false;
  /** The latest edit made during a write, wrapped so that null can wait too. */
  let waiting: { value: StoredColumnLayout | null } | undefined;
  const listeners = new Set<() => void>();
  let watch: { close: () => void } | undefined;

  const notify = () => {
    snapshot = edit === undefined ? stored : edit;
    for (const listener of listeners) listener();
  };

  const show = (value: StoredColumnLayout | null) => {
    stored = value;
    edit = undefined;
    notify();
  };

  const openWatch = () => {
    const opened = client.subscribe(
      "settings.watch",
      { key },
      {
        data: ({ value }) => {
          // A replaced watch can still deliver a value that was in flight.
          if (watch === opened && !writing) show(readColumnLayout(value));
        },
        error: (error) => {
          if (watch !== opened) return;
          console.warn("Could not read the column layout", error);
          if (!writing) show(null);
        },
      },
    );
    watch = opened;
  };

  const write = async (value: StoredColumnLayout | null): Promise<void> => {
    writing = true;
    try {
      await client.request("settings.put", { key, value });
    } catch (error) {
      console.warn("Could not save the column layout", error);
    }
    const next = waiting;
    waiting = undefined;
    if (next) return write(next.value);
    writing = false;
    // Without a listener there is no watch; the next listener opens one.
    if (watch) {
      watch.close();
      openWatch();
    }
  };
  let settled: Promise<void> = Promise.resolve();

  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      if (!watch) openWatch();
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          watch?.close();
          watch = undefined;
        }
      };
    },
    /** Shows value at once and saves it. Resolves when every write has settled. */
    put: (value: StoredColumnLayout | null): Promise<void> => {
      edit = value;
      notify();
      if (writing) waiting = { value };
      else settled = write(value);
      return settled;
    },
  };
}
