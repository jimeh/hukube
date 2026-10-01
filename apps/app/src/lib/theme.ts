import { useSyncExternalStore } from "react";

export type Theme = "dark" | "light";

const storageKey = "hukube.theme";
const listeners = new Set<() => void>();

function read(): Theme {
  return localStorage.getItem(storageKey) === "light" ? "light" : "dark";
}

/** Applies the stored theme to the document. Dark is the default. */
export function applyStoredTheme() {
  const theme = read();
  document.documentElement.classList.toggle("dark", theme === "dark");
  document.documentElement.style.colorScheme = theme;
}

export function setTheme(theme: Theme) {
  localStorage.setItem(storageKey, theme);
  applyStoredTheme();
  for (const l of listeners) l();
}

export function useTheme(): Theme {
  return useSyncExternalStore((l) => {
    listeners.add(l);
    return () => listeners.delete(l);
  }, read);
}
