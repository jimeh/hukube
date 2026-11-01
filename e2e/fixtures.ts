import { test as base } from "@playwright/test";

import { healthyURL } from "./harness.ts";

export { expect } from "@playwright/test";
export const test = base.extend<{ spawnedEngineURL: string }>({
  spawnedEngineURL: [
    // Playwright requires an explicit dependency pattern even with no dependencies.
    // oxlint-disable-next-line no-empty-pattern
    async ({}, provide) => {
      await provide(await healthyURL());
    },
    { auto: true },
  ],
  baseURL: async ({ spawnedEngineURL }, provide) => {
    await provide(spawnedEngineURL);
  },
});
