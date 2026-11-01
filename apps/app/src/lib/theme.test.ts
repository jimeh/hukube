// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { applyConfirmedTheme, applyStoredTheme } from "./theme.ts";
afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});
it("paints the optional bootstrap cache with matching native colors and catches unavailable storage", () => {
  localStorage.setItem("hukube.theme", "light");
  applyStoredTheme();
  expect(document.documentElement.classList.contains("dark")).toBe(false);
  expect(document.documentElement.style.colorScheme).toBe("light");
  applyConfirmedTheme("dark");
  expect(localStorage.getItem("hukube.theme-cache")).toBe("dark");
  expect(localStorage.getItem("hukube.theme")).toBe("light");
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new Error("storage unavailable");
  });
  applyStoredTheme();
  expect(document.documentElement.style.colorScheme).toBe("dark");
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("storage unavailable");
  });
  expect(() => applyConfirmedTheme("light")).not.toThrow(/./);
  expect(document.documentElement.style.colorScheme).toBe("light");
});
