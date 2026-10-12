import type { EngineClient } from "@hukube/engine-client";

import { readColumnLayout, type StoredColumnLayout } from "./column-layout.ts";

/** Compares sanitized layouts by column identity, order, and effective visibility. */
function sameLayout(left: StoredColumnLayout | null, right: StoredColumnLayout | null) {
  return (
    left === right ||
    (left !== null &&
      right !== null &&
      left.columns.length === right.columns.length &&
      left.columns.every((column, index) => {
        const other = right.columns[index]!;
        return (
          column.source === other.source &&
          column.name === other.name &&
          Boolean(column.hidden) === Boolean(other.hidden)
        );
      }))
  );
}

/**
 * Watches a Resource Type's layout and overlays local edits until they converge.
 * A snapshot of undefined awaits the first setting; null uses the default.
 * Subscriptions share one watch, closed when the last listener leaves.
 */
export function createColumnLayoutStore(
  client: Pick<EngineClient, "subscribe" | "request">,
  type: string,
) {
  const key = `columns/${type}`;
  let stored: StoredColumnLayout | null | undefined;
  let optimistic: StoredColumnLayout | null | undefined;
  let snapshot: StoredColumnLayout | null | undefined;
  let writes = 0;
  let differentValue = false;
  let revision = 0;
  const listeners = new Set<() => void>();
  let watch: { close: () => void } | undefined;
  const notify = () => {
    snapshot = optimistic === undefined ? stored : optimistic;
    for (const listener of listeners) listener();
  };
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      watch ??= client.subscribe(
        "settings.watch",
        { key },
        {
          data: ({ value }) => {
            const incoming = readColumnLayout(value);
            stored = incoming;
            if (optimistic !== undefined) {
              if (sameLayout(incoming, readColumnLayout(optimistic)) || writes === 0)
                optimistic = undefined;
              else differentValue = true;
            }
            notify();
          },
          error: (error) => {
            console.warn("Could not read the column layout", error);
            stored = null;
            optimistic = undefined;
            notify();
          },
        },
      );
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          watch?.close();
          watch = undefined;
        }
      };
    },
    put: (value: StoredColumnLayout | null) => {
      const current = ++revision;
      optimistic = value;
      differentValue = false;
      writes++;
      notify();
      return client
        .request("settings.put", { key, value })
        .catch((error: unknown) => {
          console.warn("Could not save the column layout", error);
          if (current === revision) {
            optimistic = undefined;
          }
        })
        .finally(() => {
          writes--;
          if (writes === 0 && differentValue) optimistic = undefined;
          notify();
        });
    },
  };
}
