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
  let write: Promise<void> | undefined;
  let waiting: StoredColumnLayout | null | undefined;
  const sent: (StoredColumnLayout | null)[] = [];
  let externalValue = false;
  const listeners = new Set<() => void>();
  let watch: { close: () => void } | undefined;
  const notify = () => {
    snapshot = optimistic === undefined ? stored : optimistic;
    for (const listener of listeners) listener();
  };
  const send = (value: StoredColumnLayout | null) => {
    sent.push(readColumnLayout(value));
    let failed = false;
    write = client
      .request("settings.put", { key, value })
      .then(() => {})
      .catch((error: unknown) => {
        console.warn("Could not save the column layout", error);
        failed = true;
      })
      .finally(() => {
        write = undefined;
        if (waiting !== undefined) {
          const next = waiting;
          waiting = undefined;
          void send(next);
        } else {
          sent.length = 0;
          if (failed || externalValue) optimistic = undefined;
        }
        notify();
      });
    return write;
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
              if (write === undefined) optimistic = undefined;
              else if (!sent.some((sentValue) => sameLayout(incoming, sentValue)))
                externalValue = true;
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
      optimistic = value;
      externalValue = false;
      notify();
      if (write === undefined) return send(value);
      waiting = value;
      return write.then(() => write);
    },
  };
}
