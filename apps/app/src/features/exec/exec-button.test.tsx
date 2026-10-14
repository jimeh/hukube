// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ExecButton } from "./exec-button.tsx";
import { WorkspaceContext, type WorkspaceValue } from "../workspace/workspace-context.tsx";

const open = vi.fn<WorkspaceValue["openExecSession"]>();
const workspace: WorkspaceValue = {
  cluster: "c",
  active: true,
  types: new Map(),
  openList: () => {},
  openResource: () => {},
  openExecSession: open,
};
const object = {
  metadata: { uid: "uid" },
  spec: { containers: [{ name: "app" }] },
  status: { containerStatuses: [{ name: "app", state: { running: {} } }] },
};
const props = {
  object,
  pod: "web",
  namespace: "ns",
  panelId: "source",
  connection: "open" as const,
  access: { allowed: true },
};
afterEach(() => {
  cleanup();
  open.mockClear();
});
function view(overrides: Partial<Parameters<typeof ExecButton>[0]> = {}) {
  return render(
    <WorkspaceContext value={workspace}>
      <ExecButton {...props} {...overrides} />
    </WorkspaceContext>,
  );
}
it("opens the only container in the Pod's Pane", () => {
  view();
  fireEvent.click(screen.getByRole("button", { name: "Open an Exec Session" }));
  expect(open).toHaveBeenCalledWith(
    { namespace: "ns", pod: "web", uid: "uid", container: "app" },
    { pane: "source" },
  );
});
it.each<[Partial<Parameters<typeof ExecButton>[0]>, string]>([
  [
    { object: undefined, connection: "reconnecting", access: { allowed: false } },
    "The Pod is not available.",
  ],
  [{ deleted: true }, "The Pod is not available."],
  [{ connection: "reconnecting", access: { allowed: false } }, "Reconnecting to the Engine"],
  [{ access: { allowed: false, reason: "The Engine is read-only." } }, "The Engine is read-only."],
  [{ access: { allowed: false } }, "Not permitted"],
  [{ object: { ...object, status: {} } }, "No container is running."],
])("disables the action with its reason: %s", async (overrides, reason) => {
  view(overrides);
  const button = screen.getByRole("button", { name: "Open an Exec Session" });
  expect(button.getAttribute("aria-disabled")).toBe("true");
  expect(button.getAttribute("tabindex")).not.toBe("-1");
  fireEvent.focus(button);
  expect(await screen.findByText(reason)).toBeDefined();
  fireEvent.click(button);
  expect(open).not.toHaveBeenCalled();
});
it("orders the default, remaining, init, and ephemeral containers and names their disabled states", async () => {
  view({
    object: {
      metadata: {
        uid: "uid",
        annotations: { "kubectl.kubernetes.io/default-container": "constructor" },
      },
      spec: {
        containers: [{ name: "__proto__" }, { name: "constructor" }, { name: "last" }],
        initContainers: [{ name: "setup" }],
        ephemeralContainers: [{ name: "debug" }],
      },
      status: {
        containerStatuses: [
          { name: "constructor", state: { running: {} } },
          { name: "__proto__", state: { running: {} } },
          { name: "last", state: { waiting: {} } },
        ],
        initContainerStatuses: [{ name: "setup", state: { terminated: {} } }],
        ephemeralContainerStatuses: [{ name: "debug", state: { running: {} } }],
      },
    },
  });
  fireEvent.click(screen.getByRole("button", { name: "Open an Exec Session" }));
  expect(await screen.findByText("Exec Session in")).toBeDefined();
  expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
    "constructor",
    "__proto__",
    "lastwaiting",
    "setupinitterminated",
    "debugephemeral",
  ]);
  expect(screen.getByRole("menuitem", { name: /last/ }).getAttribute("aria-disabled")).toBe("true");
  fireEvent.click(screen.getByRole("menuitem", { name: /^__proto__$/ }));
  expect(open).toHaveBeenCalledWith(
    { namespace: "ns", pod: "web", uid: "uid", container: "__proto__" },
    { pane: "source" },
  );
});
