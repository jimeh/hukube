import type { Setting } from "@hukube/engine-client";
import { useEngine } from "@hukube/engine-client/react";
import type { DockviewApi, SerializedDockview } from "dockview-react";
import { useEffect } from "react";

interface StoredLayout {
  version: 1;
  dockview: SerializedDockview;
}

const saveDelayMs = 400;

/**
 * Restores a Cluster's Workspace layout from the Engine, then saves it back
 * whenever it changes (ADR-0009). Layouts are read once on open; changes made
 * later by another window are not applied live.
 */
export function useLayoutPersistence(api: DockviewApi | undefined, cluster: string): void {
  const client = useEngine();

  useEffect(() => {
    if (!api) return;
    const key = `workspace/${cluster}`;
    let restored = false;
    let saveTimer: ReturnType<typeof setTimeout> | undefined;

    const watch = client.subscribe(
      "settings.watch",
      { key },
      {
        data: (setting: Setting) => {
          if (restored) return;
          restored = true;
          watch.close();
          const stored = setting.value as StoredLayout | null;
          if (stored?.version === 1) {
            try {
              api.fromJSON(stored.dockview);
            } catch (err) {
              console.warn("Discarding unreadable Workspace layout", err);
              api.clear();
            }
          }
        },
      },
    );

    const changes = api.onDidLayoutChange(() => {
      if (!restored) return;
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        const value: StoredLayout = { version: 1, dockview: api.toJSON() };
        client.request("settings.put", { key, value }).catch((err: unknown) => {
          console.warn("Could not save the Workspace layout", err);
        });
      }, saveDelayMs);
    });

    return () => {
      watch.close();
      changes.dispose();
      clearTimeout(saveTimer);
    };
  }, [api, client, cluster]);
}
