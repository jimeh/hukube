import type { EngineClient, Setting } from "@hukube/engine-client";
import type { SerializedDockview } from "dockview-react";

interface StoredLayout {
  version: 1;
  dockview: SerializedDockview;
}

/** The parts of a dockview API that layout persistence uses. */
export interface LayoutTarget {
  fromJSON: (layout: SerializedDockview) => void;
  toJSON: () => SerializedDockview;
  clear: () => void;
  onDidLayoutChange: (listener: () => void) => { dispose: () => void };
}

const defaultSaveDelayMs = 400;

/**
 * Restores a Workspace layout from the Engine, then saves it back whenever it
 * changes (ADR-0009). Saves are debounced; the returned function stops
 * persisting and writes any pending change instead of dropping it, so closing
 * a Cluster tab right after rearranging it keeps the new layout.
 *
 * Layouts are read once on open, and the last save wins: changes another
 * client makes while this one is open are not applied here, and this
 * client's next save replaces them (ADR-0009).
 */
export function persistLayout(
  client: Pick<EngineClient, "subscribe" | "request">,
  target: LayoutTarget,
  key: string,
  saveDelayMs = defaultSaveDelayMs,
): () => void {
  let restored = false;
  let saveTimer: ReturnType<typeof setTimeout> | undefined;

  const save = () => {
    saveTimer = undefined;
    const value: StoredLayout = { version: 1, dockview: target.toJSON() };
    client.request("settings.put", { key, value }).catch((err: unknown) => {
      console.warn("Could not save the Workspace layout", err);
    });
  };

  const watch = client.subscribe(
    "settings.watch",
    { key },
    {
      data: (setting: Setting) => {
        if (restored) return;
        restored = true;
        watch.close();
        const stored = setting.value as StoredLayout | null;
        if (stored?.version !== 1) return;
        try {
          target.fromJSON(stored.dockview);
        } catch (err) {
          console.warn("Discarding unreadable Workspace layout", err);
          target.clear();
        }
      },
    },
  );

  const changes = target.onDidLayoutChange(() => {
    if (!restored) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(save, saveDelayMs);
  });

  return () => {
    watch.close();
    changes.dispose();
    if (saveTimer !== undefined) {
      clearTimeout(saveTimer);
      save();
    }
  };
}
