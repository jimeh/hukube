import { useSyncExternalStore } from "react";

export type Theme = "dark" | "light";

const storageKey = "hukube.theme";
const listeners = new Set<() => void>();

export function readCachedTheme(): Theme | undefined {
  const value = localStorage.getItem(storageKey);
  return value === "light" || value === "dark" ? value : undefined;
}

function read(): Theme {
  return readCachedTheme() ?? "dark";
}

function applyTheme(theme: Theme): void {
  document.documentElement.classList.toggle("dark", theme === "dark");
  document.documentElement.style.colorScheme = theme;
}

/** Applies the stored theme to the document. Dark is the default. */
export function applyStoredTheme() {
  applyTheme(read());
}

export function setTheme(theme: Theme) {
  localStorage.setItem(storageKey, theme);
  applyTheme(theme);
  for (const l of listeners) l();
}

export function useTheme(): Theme {
  return useSyncExternalStore((l) => {
    listeners.add(l);
    return () => listeners.delete(l);
  }, read);
}
