import { useEffect } from "react";
import { applyConfirmedTheme } from "@/lib/theme.ts";
import { useLogSettings } from "../logs/log-settings.ts";
import { useSettingsOpenWork } from "./open-work.ts";
import { hasPreferenceOpenWork } from "./preferences.ts";
import { usePreferences } from "./store.ts";
/** Root-lifetime bridge. Consumers never apply optimistic drafts. */
export function PreferenceRuntime() {
  const { store, snapshot } = usePreferences();
  useEffect(() => {
    const sync = () => {
      const state = store.getSnapshot();
      useSettingsOpenWork.getState().setPreferences(hasPreferenceOpenWork(state));
      const draft = [state.drafts.wrap, state.drafts.timestamps].find(
        (value) => value && value.status !== "Saved",
      );
      useLogSettings.setState({
        loaded: state.loaded && !state.error,
        saveStatus:
          draft?.status ??
          (state.unconfirmed.some((field) => field === "wrap" || field === "timestamps") ||
          (state.loaded && state.connected && !state.fresh)
            ? "Checking preferences…"
            : state.connected
              ? ""
              : "Reconnecting"),
        saveError: draft?.error ?? state.error,
      });
      if (state.loaded) {
        applyConfirmedTheme(state.values.theme);
        useLogSettings.setState({ ...state.values });
      }
    };
    sync();
    const stop = store.subscribe(sync);
    useLogSettings.setState({
      retrySave: () => {
        store.retry();
        store.commit(["wrap", "timestamps"]);
      },
      setTimestamps: (value) => store.change("timestamps", value),
      setWrap: (value) => store.change("wrap", value),
    });
    return stop;
  }, [store]);
  return <span hidden data-preferences-loaded={snapshot.loaded} />;
}
