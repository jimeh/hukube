import { useLayoutEffect, useRef, type RefObject } from "react";
import { commands, type Surface } from "./runtime.ts";
/** Stable registration token, current operations, including owners mounted after loading. */
export function useCommandSurface(element: RefObject<HTMLElement | null>, read: Surface["read"]) {
  const latest = useRef(read);
  const registration = useRef<{ element: HTMLElement; off(): void } | undefined>(undefined);
  useLayoutEffect(() => {
    latest.current = read;
    commands.refreshAvailability();
    if (registration.current?.element !== element.current) {
      registration.current?.off();
      registration.current = undefined;
      if (element.current)
        registration.current = {
          element: element.current,
          off: commands.registerSurface({ element: element.current, read: () => latest.current() }),
        };
    }
  });
  useLayoutEffect(() => () => registration.current?.off(), []);
}
