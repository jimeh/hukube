import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { clusterId, engineToken, kubectl, kubectlCreate } from "./env.ts";
import { openGoToResource } from "./exec.ts";

async function openResource(page: Page, namespace: string, type: string, name: string) {
  await expect(page.getByText(/Kubernetes v\d/)).toBeVisible();
  await openGoToResource(page);
  await page.getByRole("combobox", { name: "Go to Resource" }).fill(`${namespace}/${type}/${name}`);
  await page.getByRole("option", { name: new RegExp(` ${name} ${namespace}$`) }).click();
  return page.getByRole("tabpanel", { name, exact: true });
}
async function manager(page: Page) {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("menuitem", { name: "Overview definitions" }).click();
  return page.getByRole("dialog", { name: "Overview definitions", exact: true });
}
export function overviewTests(namespace: string) {
  test("Overview shares form and YAML edits, Undo, gutter, all-Facet review, and Engine apply", async ({
    page,
  }) => {
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    const name = "e2e-overview-deployment";
    kubectl("-n", namespace, "create", "deployment", name, "--image=rancher/mirrored-pause:3.6");
    await page.goto(`/#token=${engineToken}`);
    await page.getByRole("button", { name: new RegExp(clusterId) }).click();
    await page
      .getByRole("complementary", { name: "Resource types" })
      .getByRole("button", { name: /^Deployment \d+$/ })
      .click();
    const panel = await openResource(page, namespace, "deployments.apps", name);
    await expect(panel.getByRole("tab", { name: /^Overview/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    // Mount Monaco before form changes so its Undo history can record them.
    await panel.getByRole("tab", { name: /^YAML/ }).click();
    await expect(panel.locator(".monaco-editor:visible .view-lines")).toContainText("replicas: 1");
    await panel.getByRole("tab", { name: /^Overview/ }).click();
    await panel.getByRole("button", { name: "Edit Replicas", exact: true }).click();
    await panel.getByRole("textbox", { name: "Replicas", exact: true }).fill("2");
    await panel.getByRole("button", { name: "Done", exact: true }).click();
    await expect(panel.getByText("Unsaved changes", { exact: true })).toBeVisible();
    await panel.getByRole("tab", { name: /^YAML/ }).click();
    const editor = panel.locator(".monaco-editor:visible");
    await expect(editor.locator(".view-lines")).toContainText("replicas: 2");
    await expect(editor.locator(".yaml-change-modified")).toHaveCount(1);
    await editor.getByRole("textbox", { name: "Resource YAML", exact: true }).focus();
    await page.keyboard.press("ControlOrMeta+Z");
    await panel.getByRole("tab", { name: /^Overview/ }).click();
    await expect(panel.getByRole("button", { name: "Edit Replicas", exact: true })).toHaveText("1");
    // YAML-origin changes are reflected in the same Overview session.
    await panel.getByRole("tab", { name: /^YAML/ }).click();
    const manifest = `apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: ${name}\n  namespace: ${namespace}\nspec:\n  replicas: 2\n  selector:\n    matchLabels: {app: ${name}}\n  template:\n    metadata:\n      labels: {app: ${name}}\n    spec:\n      containers:\n        - name: mirrored-pause\n          image: rancher/mirrored-pause:3.6\n`;
    await page.evaluate((text) => navigator.clipboard.writeText(text), manifest);
    await editor.getByRole("textbox", { name: "Resource YAML", exact: true }).focus();
    await page.keyboard.press("ControlOrMeta+A");
    await page.keyboard.press("ControlOrMeta+V");
    await panel.getByRole("tab", { name: /^Overview/ }).click();
    await expect(panel.getByRole("button", { name: "Edit Replicas", exact: true })).toHaveText("2");
    await panel.getByRole("tab", { name: /^Events/ }).click();
    await expect(panel.getByText("Unsaved changes", { exact: true })).toBeVisible();
    await panel.getByRole("button", { name: "Review changes", exact: true }).click();
    const review = page.getByRole("dialog", { name: `Review changes to Deployment ${name}` });
    await expect(review.getByText("The Cluster accepts this edit.")).toBeVisible();
    await review.getByRole("button", { name: "Apply", exact: true }).click();
    await expect(review).toBeHidden();
    await expect
      .poll(
        () =>
          JSON.parse(kubectl("-n", namespace, "get", "deployment", name, "-o", "json")).spec
            .replicas,
      )
      .toBe(2);
    await expect(panel.getByText("Unsaved changes", { exact: true })).toBeHidden();
    // Review returns keyboard focus to the field that started it, including later table cells.
    await panel.getByRole("tab", { name: /^Overview/ }).click();
    const imageButton = panel.getByRole("button", { name: "Edit Containers 1 Image", exact: true });
    await imageButton.click();
    await panel
      .getByRole("textbox", { name: "Containers 1 Image", exact: true })
      .fill("rancher/mirrored-pause:3.6-review-only");
    await panel.getByRole("button", { name: "Done", exact: true }).click();
    await panel.getByRole("button", { name: "Review changes", exact: true }).click();
    await expect(review.getByText("The Cluster accepts this edit.")).toBeVisible();
    await review.getByRole("button", { name: "Back to editing", exact: true }).click();
    await expect(imageButton).toBeFocused();
    await panel.getByRole("button", { name: "Revert field", exact: true }).click();
    await panel.getByRole("button", { name: "Cancel", exact: true }).click();
    // String-map editing uses the same review/apply pipeline.
    const configName = "e2e-overview-config";
    kubectl("-n", namespace, "create", "configmap", configName, "--from-literal=greeting=hello");
    const config = await openResource(page, namespace, "configmaps", configName);
    await config.getByRole("tab", { name: /^Overview/ }).click();
    await config.getByRole("button", { name: "Edit greeting", exact: true }).click();
    await config.getByRole("textbox", { name: "greeting", exact: true }).fill("from-overview");
    await config.getByRole("button", { name: "Done", exact: true }).click();
    await config.getByRole("button", { name: "Review changes", exact: true }).click();
    const configReview = page.getByRole("dialog", {
      name: `Review changes to ConfigMap ${configName}`,
    });
    await expect(configReview.getByText("The Cluster accepts this edit.")).toBeVisible();
    await configReview.getByRole("button", { name: "Apply", exact: true }).click();
    await expect(configReview).toBeHidden();
    await expect
      .poll(
        () =>
          JSON.parse(kubectl("-n", namespace, "get", "configmap", configName, "-o", "json")).data
            .greeting,
      )
      .toBe("from-overview");
  });

  test("imports a Widget definition, edits, reloads, removes it and restores YAML fallback", async ({
    page,
  }) => {
    const name = "e2e-overview-widget";
    const crd = JSON.parse(
      kubectl("get", "crd", "widgets.sample.hukube.dev", "-o", "json", "--ignore-not-found") ||
        "null",
    );
    // Only this disposable e2e Cluster is addressed by env.ts. Preserve an existing fixture CRD.
    let createdCRD = false;
    if (!crd) {
      kubectl("apply", "-f", "../docs/overview/widget-crd.yaml");
      createdCRD = true;
      kubectl(
        "wait",
        "--for=condition=established",
        "--timeout=30s",
        "crd/widgets.sample.hukube.dev",
      );
    }
    kubectlCreate({
      apiVersion: "sample.hukube.dev/v1",
      kind: "Widget",
      metadata: { name, namespace },
      spec: { size: 3 },
    });
    let installed = false;
    let saved = false;
    page.on("websocket", (socket) => {
      const ids = new Set<number>();
      socket.on("framesent", ({ payload }) => {
        if (typeof payload !== "string") return;
        const message = JSON.parse(payload) as {
          id: number;
          method?: string;
          params?: { key?: string; value?: unknown };
        };
        if (
          message.method === "settings.put" &&
          message.params?.key?.startsWith("workspace/") &&
          JSON.stringify(message.params.value).includes(name)
        )
          ids.add(message.id);
      });
      socket.on("framereceived", ({ payload }) => {
        if (typeof payload !== "string") return;
        const message = JSON.parse(payload) as { id: number; type: string };
        if (message.type === "result" && ids.has(message.id)) saved = true;
      });
    });
    try {
      await page.goto(`/#token=${engineToken}`);
      await page.getByRole("button", { name: new RegExp(clusterId) }).click();
      const panel = await openResource(page, namespace, "widgets.sample.hukube.dev", name);
      await expect(panel.getByRole("tab", { name: /^Overview/ })).toHaveCount(0);
      let definitions = await manager(page);
      await definitions
        .getByRole("textbox", { name: "Definition YAML" })
        .fill(readFileSync("../docs/overview/widget.yaml", "utf8"));
      await definitions.getByRole("button", { name: "Validate import" }).click();
      await definitions.getByRole("button", { name: "Install definition", exact: true }).click();
      await expect(
        definitions.getByText("widgets.sample.hukube.dev saved.", { exact: true }),
      ).toBeVisible();
      installed = true;
      await definitions.getByRole("button", { name: "Close", exact: true }).first().click();
      await panel.getByRole("tab", { name: /^Overview/ }).click();
      await panel.getByRole("button", { name: "Edit Size", exact: true }).click();
      await panel.getByRole("textbox", { name: "Size", exact: true }).fill("4");
      await panel.getByRole("button", { name: "Done", exact: true }).click();
      await panel.getByRole("button", { name: "Review changes", exact: true }).click();
      const review = page.getByRole("dialog", { name: `Review changes to Widget ${name}` });
      await expect(review.getByText("The Cluster accepts this edit.")).toBeVisible();
      await review.getByRole("button", { name: "Apply", exact: true }).click();
      await expect(review).toBeHidden();
      await expect
        .poll(
          () => JSON.parse(kubectl("-n", namespace, "get", "widget", name, "-o", "json")).spec.size,
        )
        .toBe(4);
      await expect.poll(() => saved, { message: "Resource Tab layout acknowledged" }).toBe(true);
      await page.reload();
      const restored = page.getByRole("tabpanel", { name, exact: true });
      await expect(restored.getByRole("button", { name: "Edit Size", exact: true })).toHaveText(
        "4",
      );
      definitions = await manager(page);
      await definitions
        .getByRole("button", { name: "Remove widgets.sample.hukube.dev", exact: true })
        .click();
      await definitions.getByRole("button", { name: "Confirm removal", exact: true }).click();
      await expect(
        definitions.getByText("widgets.sample.hukube.dev removed.", { exact: true }),
      ).toBeVisible();
      installed = false;
      await definitions.getByRole("button", { name: "Close", exact: true }).first().click();
      await expect(restored.getByRole("tab", { name: /^Overview/ })).toHaveCount(0);
      await expect(restored.getByRole("tab", { name: /^YAML/ })).toHaveAttribute(
        "aria-selected",
        "true",
      );
    } finally {
      try {
        if (installed && !page.isClosed()) {
          const openDialog = page.getByRole("dialog", {
            name: "Overview definitions",
            exact: true,
          });
          const definitions = (await openDialog.isVisible()) ? openDialog : await manager(page);
          await definitions
            .getByRole("button", { name: "Remove widgets.sample.hukube.dev", exact: true })
            .click();
          await definitions.getByRole("button", { name: "Confirm removal", exact: true }).click();
          await expect(
            definitions.getByText("widgets.sample.hukube.dev removed.", { exact: true }),
          ).toBeVisible();
        }
      } finally {
        kubectl("-n", namespace, "delete", "widget", name, "--ignore-not-found");
        if (createdCRD) {
          kubectl("delete", "-f", "../docs/overview/widget-crd.yaml", "--ignore-not-found");
        }
      }
    }
  });
}

// No Cluster Resources are required to exercise the Engine-wide registry race.
test("concurrent definition imports in two windows retain both entries and clean up", async ({
  page,
  context,
}) => {
  const second = await context.newPage();
  const keys = ["first.overview-e2e.hukube.dev", "second.overview-e2e.hukube.dev"];
  const dialogs: Awaited<ReturnType<typeof manager>>[] = [];
  try {
    for (const current of [page, second]) {
      await current.goto(`/#token=${engineToken}`);
      dialogs.push(await manager(current));
    }
    const example = readFileSync("../docs/overview/widget.yaml", "utf8");
    for (let i = 0; i < dialogs.length; i++) {
      await dialogs[i]!.getByRole("textbox", { name: "Definition YAML" }).fill(
        example.replace("widgets.sample.hukube.dev", keys[i]!),
      );
      await dialogs[i]!.getByRole("button", { name: "Validate import" }).click();
    }
    await Promise.all(
      dialogs.map((dialog) =>
        dialog.getByRole("button", { name: "Install definition", exact: true }).click(),
      ),
    );
    for (let i = 0; i < dialogs.length; i++)
      await expect(dialogs[i]!.getByText(`${keys[i]} saved.`, { exact: true })).toBeVisible();
    for (const dialog of dialogs)
      for (const key of keys)
        await expect(
          dialog.getByRole("button", { name: `Remove ${key}`, exact: true }),
        ).toBeVisible();
  } finally {
    const dialog = dialogs[0];
    if (dialog && (await dialog.isVisible())) {
      for (const key of keys) {
        const remove = dialog.getByRole("button", { name: `Remove ${key}`, exact: true });
        if (await remove.count()) {
          await remove.click();
          await dialog.getByRole("button", { name: "Confirm removal", exact: true }).click();
          await expect(dialog.getByText(`${key} removed.`, { exact: true })).toBeVisible();
        }
      }
    }
    await second.close();
  }
});
