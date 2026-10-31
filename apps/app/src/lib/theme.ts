import { useSyncExternalStore } from "react";
export type Theme = "dark" | "light";
let current: Theme = "dark";
const listeners = new Set<() => void>();
function paint(theme: Theme) {
  current = theme;
  document.documentElement.classList.toggle("dark", theme === "dark");
  document.documentElement.style.colorScheme = theme;
  for (const listener of listeners) listener();
}
/** The bootstrap cache is deliberately separate from the legacy migration candidate. */
export function applyStoredTheme() {
  let value: string | null = null;
  try {
    value = localStorage.getItem("hukube.theme-cache") ?? localStorage.getItem("hukube.theme");
  } catch {
    /* Storage is optional. */
  }
  paint(value === "light" ? "light" : "dark");
}
export function applyConfirmedTheme(theme: Theme) {
  paint(theme);
  try {
    localStorage.setItem("hukube.theme-cache", theme);
  } catch {
    /* Engine persistence is independent. */
  }
}
export function useTheme(): Theme {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => current,
  );
}
