// @vitest-environment jsdom

import { expect, it } from "vitest";

import { createWorkspaceFocusRegistry } from "./workspace-focus-registry.ts";

it("retains focus ownership through ref churn and releases it only when the ID closes", () => {
  const registry = createWorkspaceFocusRegistry();
  const workspace = document.createElement("section");
  const control = document.createElement("button");
  workspace.append(control);
  document.body.append(workspace);

  registry.workspace("dev", workspace);
  registry.focused("dev", control);
  registry.workspace("dev", null);
  expect(registry.diagnostics("dev")).toEqual({
    workspaces: 0,
    focused: 1,
    ownsWorkspace: false,
    ownsFocus: true,
  });

  registry.workspace("dev", workspace);
  expect(registry.restore("dev")).toBe(control);
  expect(document.activeElement).toBe(control);
  registry.retain(["dev"]);
  expect(registry.diagnostics("dev").ownsFocus).toBe(true);

  registry.workspace("dev", null);
  registry.retain([]);
  expect(registry.diagnostics("dev")).toEqual({
    workspaces: 0,
    focused: 0,
    ownsWorkspace: false,
    ownsFocus: false,
  });

  registry.workspace("dev", workspace);
  expect(registry.restore("dev")).toBe(workspace);
  expect(registry.diagnostics("dev").ownsFocus).toBe(false);
});
