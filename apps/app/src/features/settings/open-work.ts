import { create } from "zustand";
/** Overview import drafts belong to the window, alongside app preference drafts. */
export const useSettingsOpenWork = create<{
  overview: boolean;
  preferences: boolean;
  setPreferences(value: boolean): void;
  setOverview(value: boolean): void;
}>((set) => ({
  preferences: false,
  setPreferences: (preferences) => set({ preferences }),
  overview: false,
  setOverview: (overview) => set({ overview }),
}));
