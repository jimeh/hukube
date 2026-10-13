import { useLayoutEffect } from "react";

const roots = new Map<HTMLElement, { count: number; wasInert: boolean }>();

/** Native inert also blocks Tab while Base UI's focus guards await a frame. */
export function useModalInert(open: boolean): void {
  useLayoutEffect(() => {
    const root = document.getElementById("root");
    if (!open || !root) return;
    const entry = roots.get(root) ?? { count: 0, wasInert: root.inert };
    entry.count++;
    roots.set(root, entry);
    root.inert = true;
    return () => {
      if (--entry.count) return;
      root.inert = entry.wasInert;
      roots.delete(root);
    };
  }, [open]);
}
