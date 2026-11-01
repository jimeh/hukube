// @vitest-environment jsdom

import { cleanup } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";

import { restoreWorkspaceFocus } from "./focus-return.ts";

function focusFixture() {
  const workspace = document.createElement("div");
  workspace.tabIndex = -1;
  workspace.setAttribute("role", "region");
  workspace.setAttribute("aria-label", "dev Workspace");
  workspace.innerHTML = `
    <button data-target>Original control</button>
    <div role="tablist" aria-label="Facets">
      <button role="tab" aria-selected="true" class="focus-visible:ring-2">Logs</button>
    </div>
  `;
  document.body.append(workspace);
  return {
    workspace,
    target: workspace.querySelector<HTMLElement>("[data-target]")!,
    logs: workspace.querySelector<HTMLElement>("[role='tab']")!,
  };
}

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

it.each([
  ["removed", ({ target }: ReturnType<typeof focusFixture>) => target.remove()],
  [
    "disabled",
    ({ target }: ReturnType<typeof focusFixture>) => target.setAttribute("disabled", ""),
  ],
  ["inert", ({ target }: ReturnType<typeof focusFixture>) => target.setAttribute("inert", "")],
  ["hidden", ({ target }: ReturnType<typeof focusFixture>) => target.setAttribute("hidden", "")],
])("uses the selected Logs Facet when the previous target is %s", (_name, invalidate) => {
  const fixture = focusFixture();
  fixture.target.focus();
  invalidate(fixture);

  expect(restoreWorkspaceFocus(fixture.workspace, fixture.target)).toBe(fixture.logs);
  expect(document.activeElement).toBe(fixture.logs);
  expect(fixture.logs.className).toContain("focus-visible:ring-2");
});

it("rejects a target owned by another Workspace", () => {
  const active = focusFixture();
  const inactive = document.createElement("div");
  const wrongTarget = document.createElement("button");
  inactive.append(wrongTarget);
  document.body.append(inactive);

  expect(restoreWorkspaceFocus(active.workspace, wrongTarget)).toBe(active.logs);
  expect(document.activeElement).toBe(active.logs);
});

it("focuses the named Workspace when it has no valid control", () => {
  const workspace = document.createElement("div");
  workspace.tabIndex = -1;
  workspace.setAttribute("role", "region");
  workspace.setAttribute("aria-label", "dev Workspace");
  document.body.append(workspace);

  expect(restoreWorkspaceFocus(workspace, undefined)).toBe(workspace);
  expect(document.activeElement).toBe(workspace);
  expect(workspace.getAttribute("aria-label")).toBe("dev Workspace");
});
