import { defineConfig } from "@playwright/test";

import { enginePort, engineToken, kubeconfig } from "./tests/env.ts";

// Needs the k3d cluster and built Engine, UI, and desktop Host:
// `mise run e2e` prepares all of them.
export default defineConfig({
  testDir: "tests",
  fullyParallel: false,
  forbidOnly: !!process.env["CI"],
  retries: process.env["CI"] ? 1 : 0,
  reporter: process.env["CI"] ? [["github"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: `http://127.0.0.1:${enginePort}`,
    trace: "retain-on-failure",
    viewport: { width: 1440, height: 900 },
  },
  projects: [
    { name: "web", testMatch: "web.spec.ts" },
    { name: "desktop", testMatch: "desktop.spec.ts" },
  ],
  webServer: {
    command: [
      "../engine/bin/hukube-engine",
      "--web",
      "--ui-dir=../apps/app/dist",
      `--listen=127.0.0.1:${enginePort}`,
      `--token=${engineToken}`,
      `--kubeconfig=${kubeconfig}`,
      "--data-dir=../.data/e2e/engine",
    ].join(" "),
    url: `http://127.0.0.1:${enginePort}/healthz`,
    reuseExistingServer: false,
    stdout: "pipe",
  },
});
