import { mkdtempSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { _electron as electron, expect, test } from "@playwright/test";

import { clusterId, kubeconfig } from "./env.ts";

const desktopDir = resolve(import.meta.dirname, "../../apps/desktop");
// The electron package exports the path to its binary.
const electronBinary = createRequire(resolve(desktopDir, "package.json"))("electron") as string;

test("starts its own Engine and lists the kubeconfig's clusters", async () => {
  const app = await electron.launch({
    executablePath: electronBinary,
    // Test machines, like Ubuntu 24.04 CI runners, block Chromium's sandbox.
    args: [desktopDir, "--no-sandbox"],
    env: {
      ...process.env,
      KUBECONFIG: kubeconfig,
      HUKUBE_USER_DATA_DIR: mkdtempSync(join(tmpdir(), "hukube-e2e-")),
    },
  });
  try {
    const window = await app.firstWindow();
    await expect(window.getByRole("heading", { name: "Open a cluster" })).toBeVisible();
    await window.getByRole("button", { name: new RegExp(clusterId) }).click();
    await expect(window.getByText(/Kubernetes v\d/)).toBeVisible();
    await window.screenshot({ path: "test-results/desktop-workspace.png" });
  } finally {
    await app.close();
  }
});
