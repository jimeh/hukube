import { defaults } from "../settings/preferences.ts";
import { create } from "zustand";

export const useLogSettings = create<{
  loaded: boolean;
  saveStatus: string;
  saveError?: string;
  retrySave: () => void;
  maxLines: number;
  maxCharacters: number;
  maxDecorations: number;
  timestamps: boolean;
  wrap: boolean;
  setTimestamps: (value: boolean) => void;
  setWrap: (value: boolean) => void;
}>((set) => ({
  ...defaults,
  loaded: false,
  saveStatus: "",
  retrySave: () => {},
  timestamps: false,
  wrap: true,
  setTimestamps: (timestamps) => set({ timestamps }),
  setWrap: (wrap) => set({ wrap }),
}));
