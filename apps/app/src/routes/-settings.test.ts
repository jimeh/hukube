import { expect, it } from "vitest";

import { validateSettingsSearch } from "./settings.tsx";

it("validates linkable Settings categories and ignores invalid return targets", () => {
  expect(validateSettingsSearch({})).toEqual({ category: "appearance" });
  expect(validateSettingsSearch({ category: "invalid", fromCluster: "" })).toEqual({
    category: "appearance",
  });
  expect(validateSettingsSearch({ category: "logs", fromCluster: "dev" })).toEqual({
    category: "logs",
    fromCluster: "dev",
  });
});
