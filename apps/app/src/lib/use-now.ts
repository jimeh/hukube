import { useSyncExternalStore } from "react";

// One shared clock so every age column ticks together with a single timer.
let now = Date.now();
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | undefined;

function subscribe(listener: () => void) {
  listeners.add(listener);
  timer ??= setInterval(() => {
    now = Date.now();
    for (const l of listeners) l();
  }, 1000);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      clearInterval(timer);
      timer = undefined;
    }
  };
}

/** The current time in milliseconds, updated every second. */
export function useNow(): number {
  return useSyncExternalStore(subscribe, () => now);
}
