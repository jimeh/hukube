// @vitest-environment jsdom
import type { EngineClient, Setting } from "@hukube/engine-client";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ExecButton } from "./exec-button.tsx";
import { WorkspaceContext, type WorkspaceValue } from "../workspace/workspace-context.tsx";

const mocked = vi.hoisted(() => ({ client: undefined as EngineClient | undefined }));
vi.mock("@hukube/engine-client/react", () => ({ useEngine: () => mocked.client }));
let deliver: (value: unknown) => void;
const saves = vi.fn<(value: unknown) => void>();
beforeEach(() => {
  mocked.client = {
    subscribe: (
      _method: string,
      _params: unknown,
      listener: { data: (setting: Setting) => void },
    ) => {
      deliver = (value) => listener.data({ key: "exec/commands", value });
      return { close: () => {}, update: () => {} };
    },
    request: (_method: string, params: unknown) => {
      saves(params);
      return Promise.resolve();
    },
  } as unknown as EngineClient;
  saves.mockClear();
});
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
  spec: { containers: [{ name: "app", image: "busybox:1.36" }] },
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
  fireEvent.click(screen.getByRole("button", { name: "Exec Session options" }));
  expect(await screen.findByText("Exec Session in")).toBeDefined();
  expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
    "constructor",
    "__proto__",
    "lastwaiting",
    "setupinitterminated",
    "debugephemeral",
    "Run a command…",
  ]);
  expect(screen.getByRole("menuitem", { name: /last/ }).getAttribute("aria-disabled")).toBe("true");
  fireEvent.click(screen.getByRole("menuitem", { name: /^__proto__$/ }));
  expect(open).toHaveBeenCalledWith(
    { namespace: "ns", pod: "web", uid: "uid", container: "__proto__" },
    { pane: "source" },
  );
});

it("starts the default container directly even when there are several", () => {
  view({
    object: {
      ...object,
      metadata: {
        uid: "uid",
        annotations: { "kubectl.kubernetes.io/default-container": "second" },
      },
      spec: { containers: [{ name: "first" }, { name: "second" }] },
      status: {
        containerStatuses: [
          { name: "first", state: { running: {} } },
          { name: "second", state: { running: {} } },
        ],
      },
    },
  });
  fireEvent.click(screen.getByRole("button", { name: "Open an Exec Session" }));
  expect(open).toHaveBeenCalledWith(
    { namespace: "ns", pod: "web", uid: "uid", container: "second" },
    { pane: "source" },
  );
});
it("names the remembered line in the tooltip and menu and runs it from the button", async () => {
  view();
  act(() => deliver({ images: [{ image: "busybox", command: "sh -l" }], recent: [] }));
  fireEvent.focus(screen.getByRole("button", { name: "Open an Exec Session" }));
  expect(await screen.findByText("Open an Exec Session: runs sh -l")).toBeDefined();
  fireEvent.click(screen.getByRole("button", { name: "Open an Exec Session" }));
  expect(open).toHaveBeenCalledWith(
    { namespace: "ns", pod: "web", uid: "uid", container: "app", commandLine: "sh -l" },
    { pane: "source" },
  );
  fireEvent.click(screen.getByRole("button", { name: "Exec Session options" }));
  expect((await screen.findByRole("menuitem", { name: /app/ })).textContent).toContain("sh -l");
});
it("opens the command dialog, refuses a pipeline, fills a recent line unchanged, and remembers by choice", async () => {
  view();
  act(() => deliver({ images: [], recent: ["ls '*.log'"] }));
  fireEvent.click(screen.getByRole("button", { name: "Exec Session options" }));
  fireEvent.click(await screen.findByRole("menuitem", { name: "Run a command…" }));
  expect(await screen.findByRole("dialog", { name: "Run a command in a container" })).toBeDefined();
  const field = screen.getByRole<HTMLInputElement>("textbox", { name: "Command" });
  await vi.waitFor(() => expect(document.activeElement).toBe(field));
  const checkbox = screen.getByRole("checkbox", {
    name: "Use the default shell for busybox from now on",
  });
  expect(checkbox.getAttribute("aria-checked")).toBe("false");
  fireEvent.change(field, { target: { value: "x # note" } });
  expect(screen.getByRole("alert").textContent).toBe(
    "# starts a comment here. Quote it to pass it as text.",
  );
  expect(
    [...screen.getByRole("alert").querySelectorAll("code")].map((element) => element.textContent),
  ).toEqual(["#"]);
  fireEvent.change(field, { target: { value: "a | b" } });
  expect(screen.getByRole("alert").textContent).toBe(
    "| needs a shell. To use one, write sh -c '…'.",
  );
  expect(
    [...screen.getByRole("alert").querySelectorAll("code")].map((element) => element.textContent),
  ).toEqual(["|", "sh -c '…'"]);
  expect(screen.getByRole<HTMLButtonElement>("button", { name: /^Run$/ }).disabled).toBe(true);
  fireEvent.submit(field.closest("form")!);
  expect(open).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "ls '*.log'" }));
  expect(field.value).toBe("ls '*.log'");
  expect(screen.getByRole("checkbox", { name: "Use this command for busybox from now on" })).toBe(
    checkbox,
  );
  expect(screen.getByLabelText("Words to run").textContent).toContain('"*.log"');
  fireEvent.click(checkbox);
  fireEvent.submit(field.closest("form")!);
  expect(open).toHaveBeenCalledWith(
    { namespace: "ns", pod: "web", uid: "uid", container: "app", commandLine: "ls '*.log'" },
    { pane: "source" },
  );
  expect(saves).toHaveBeenCalledWith({
    key: "exec/commands",
    value: { images: [{ image: "busybox", command: "ls '*.log'" }], recent: ["ls '*.log'"] },
  });
});

it("lets a running container be selected when the default is stopped, and forgets its command by choice", async () => {
  view({
    object: {
      ...object,
      spec: {
        containers: [
          { name: "app", image: "busybox:1.36" },
          { name: "side", image: "python:3" },
        ],
      },
      status: {
        containerStatuses: [
          { name: "app", state: { terminated: {} } },
          { name: "side", state: { running: {} } },
        ],
      },
    },
  });
  act(() =>
    deliver({
      images: [
        { image: "busybox", command: "bash" },
        { image: "python", command: "python3" },
      ],
      recent: [],
    }),
  );
  expect(
    screen.getByRole("button", { name: "Open an Exec Session" }).getAttribute("aria-disabled"),
  ).toBe("true");
  fireEvent.click(screen.getByRole("button", { name: "Exec Session options" }));
  fireEvent.click(await screen.findByRole("menuitem", { name: "Run a command…" }));
  const run = await screen.findByRole<HTMLButtonElement>("button", { name: /^Run$/ });
  expect(run.disabled).toBe(true);
  fireEvent.click(screen.getByRole("combobox", { name: "Container" }));
  const side = await screen.findByRole("option", { name: "side" });
  fireEvent.pointerDown(side, { pointerType: "mouse" });
  fireEvent.click(side);
  await vi.waitFor(() => expect(run.disabled).toBe(false));
  fireEvent.click(
    screen.getByRole("checkbox", { name: "Use the default shell for python from now on" }),
  );
  fireEvent.click(run);
  expect(open).toHaveBeenCalledWith(
    { namespace: "ns", pod: "web", uid: "uid", container: "side", commandLine: "" },
    { pane: "source" },
  );
  expect(saves).toHaveBeenCalledWith({
    key: "exec/commands",
    value: { images: [{ image: "busybox", command: "bash" }], recent: [] },
  });
});
it("cancels the command dialog with Escape without opening a session or saving settings", async () => {
  view();
  fireEvent.click(screen.getByRole("button", { name: "Exec Session options" }));
  fireEvent.click(await screen.findByRole("menuitem", { name: "Run a command…" }));
  const field = await screen.findByRole("textbox", { name: "Command" });
  fireEvent.change(field, { target: { value: "python3" } });
  fireEvent.keyDown(field, { key: "Escape", code: "Escape" });
  await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(open).not.toHaveBeenCalled();
  expect(saves).not.toHaveBeenCalled();
});
