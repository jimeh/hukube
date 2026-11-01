import { defineConfig } from "@playwright/test";

import { readEnvironment, readyPattern } from "./harness.ts";

readEnvironment();

// Needs the k3d cluster and built Engine, UI, and desktop Host:
// `mise run e2e` prepares all of them.
export default defineConfig({
  testDir: "tests",
  fullyParallel: false,
  forbidOnly: !!process.env["CI"],
  retries: process.env["CI"] ? 1 : 0,
  reporter: process.env["CI"] ? [["github"], ["html", { open: "never" }]] : "list",
  use: {
    trace: "retain-on-failure",
    viewport: { width: 1440, height: 900 },
  },
  projects: [
    { name: "web", testMatch: "web.spec.ts" },
    { name: "desktop", testMatch: "desktop.spec.ts" },
  ],
  webServer: {
    command: "bun harness-cli.ts engine",
    // Port zero plus this process's ready record prevents reuse. Workers read
    // the named capture at fixture runtime, after Playwright starts the Engine.
    wait: { stdout: readyPattern },
    reuseExistingServer: false,
    stdout: "pipe",
  },
});
