import { create } from "zustand";

export const useLogSettings = create<{
  timestamps: boolean;
  wrap: boolean;
  setTimestamps: (value: boolean) => void;
  setWrap: (value: boolean) => void;
}>((set) => ({
  timestamps: false,
  wrap: true,
  setTimestamps: (timestamps) => set({ timestamps }),
  setWrap: (wrap) => set({ wrap }),
}));
