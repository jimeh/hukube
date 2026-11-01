import { useLayoutEffect, useSyncExternalStore } from "react";

const roots = new Map<HTMLElement, { count: number; wasInert: boolean }>();

const listeners = new Set<() => void>();
let modalCount = 0;
const notify = () => {
  for (const fn of listeners) fn();
};
/** Window command arbitration observes every modal while retaining inert restoration. */
export function useModalCount() {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => modalCount,
  );
}

/** Native inert also blocks Tab while Base UI's focus guards await a frame. */
export function useModalInert(open: boolean): void {
  useLayoutEffect(() => {
    const root = document.getElementById("root");
    if (!open || !root) return;
    const entry = roots.get(root) ?? { count: 0, wasInert: root.inert };
    entry.count++;
    modalCount++;
    notify();
    roots.set(root, entry);
    root.inert = true;
    return () => {
      modalCount--;
      notify();
      if (--entry.count) return;
      root.inert = entry.wasInert;
      roots.delete(root);
    };
  }, [open]);
}
