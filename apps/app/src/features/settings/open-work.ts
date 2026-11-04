import { create } from "zustand";
/** Overview import drafts belong to the window, alongside app preference drafts. */
export const useSettingsOpenWork = create<{
  keybindings: boolean;
  setKeybindings(value: boolean): void;
  overview: boolean;
  preferences: boolean;
  setPreferences(value: boolean): void;
  setOverview(value: boolean): void;
}>((set) => ({
  keybindings: false,
  setKeybindings: (keybindings) => set({ keybindings }),
  preferences: false,
  setPreferences: (preferences) => set({ preferences }),
  overview: false,
  setOverview: (overview) => set({ overview }),
}));
