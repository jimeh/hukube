import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

interface OpenClusters {
  /** Cluster IDs with a tab in this window, in tab order. */
  ids: string[];
  open: (id: string) => void;
  /** Removes a tab and returns the ID of the tab to show next, if any. */
  close: (id: string) => string | undefined;
}

/**
 * The Cluster tabs of this window. Each window keeps its own tabs, surviving
 * reloads, while Workspace layouts are shared through the Engine.
 */
export const useOpenClusters = create<OpenClusters>()(
  persist(
    (set, get) => ({
      ids: [],
      open: (id) => set(({ ids }) => (ids.includes(id) ? {} : { ids: [...ids, id] })),
      close: (id) => {
        const { ids } = get();
        const index = ids.indexOf(id);
        if (index === -1) return undefined;
        const next = ids.filter((other) => other !== id);
        set({ ids: next });
        return next[Math.min(index, next.length - 1)];
      },
    }),
    { name: "hukube.openClusters", storage: createJSONStorage(() => sessionStorage) },
  ),
);
