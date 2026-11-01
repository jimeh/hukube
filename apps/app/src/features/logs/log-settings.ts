import { useMemo } from "react";

import { usePreferences } from "../settings/preferences.ts";

/** Adapts Engine-shared app preferences to the Log Stream viewer. */
export function useLogSettings() {
  const { snapshot, store } = usePreferences();
  const { maxLines, maxCharacters, maxStyledRanges } = snapshot.effective.logStreams;
  const budgets = useMemo(
    () => ({
      lines: maxLines,
      characters: maxCharacters,
      decorations: maxStyledRanges,
    }),
    [maxLines, maxCharacters, maxStyledRanges],
  );
  return {
    budgets,
    timestamps: snapshot.display.logStreams.timestamps,
    wrap: snapshot.display.logStreams.wrap,
    save: snapshot.saves.display,
    setTimestamps: (timestamps: boolean) => {
      void store.save("display", [{ path: "logStreams.timestamps", value: timestamps }]);
    },
    setWrap: (wrap: boolean) => {
      void store.save("display", [{ path: "logStreams.wrap", value: wrap }]);
    },
    retry: (overwriteCurrent = false) => store.retry("display", overwriteCurrent),
    acceptCurrent: () => store.acceptCurrent("display"),
  };
}
