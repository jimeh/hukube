// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useUnsavedEdits, guardWorkspace, guardPanel } from "./unsaved-edits.ts";
import { UnsavedGuard } from "./unsaved-guard.tsx";
import { copyText } from "./clipboard.ts";
import { useExecSessions, disposeSession, type ExecState } from "../exec/sessions.ts";
afterEach(() => {
  cleanup();
  for (const id of useExecSessions.getState().entries.keys()) disposeSession(id);
  useUnsavedEdits.setState({ entries: new Map(), guard: undefined });
  vi.unstubAllGlobals();
});

function session(id: string, state: ExecState = { phase: "live" }) {
  useExecSessions.setState((store) => ({
    entries: new Map(store.entries).set(id, {
      cluster: "c",
      params: { sessionId: id, namespace: "ns", pod: "web", uid: "uid", container: "app" },
      state,
    }),
  }));
}
it.each(["button", "middle click"])(
  "guards an Exec Session Tab's %s close path and keeps it running on cancel",
  async (action) => {
    const { PanelTab } = await import("../workspace/panel-tab.tsx");
    session("id", { phase: "starting" });
    const close = vi.fn<() => void>();
    const props = {
      api: { id: "exec:id", title: "web", close, onDidTitleChange: () => ({ dispose: () => {} }) },
      params: {},
    } as unknown as Parameters<typeof PanelTab>[0];
    const view = render(
      <>
        <PanelTab {...props} />
        <UnsavedGuard />
      </>,
    );
    if (action === "button") fireEvent.click(screen.getByRole("button", { name: "Close web" }));
    else
      fireEvent(
        view.container.firstElementChild!,
        new MouseEvent("auxclick", { bubbles: true, button: 1 }),
      );
    expect(await screen.findByText("End the Exec Session in app of web?")).toBeDefined();
    expect(
      screen.getByText(
        "Its shell is told to exit. A command still running in the container may keep running.",
      ),
    ).toBeDefined();
    const keep = screen.getByRole("button", { name: "Keep session" });
    await vi.waitFor(() => expect(document.activeElement).toBe(keep));
    fireEvent.click(keep);
    expect(close).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Close web" }));
    fireEvent.click(screen.getByRole("button", { name: "End session" }));
    expect(close).toHaveBeenCalledOnce();
  },
);
it.each([1, 2])("counts %s Exec Sessions with the Cluster's exact close copy", async (count) => {
  for (let i = 0; i < count; i++) session(String(i));
  render(<UnsavedGuard />);
  const close = vi.fn<() => void>();
  act(() => guardWorkspace("c", close));
  expect(await screen.findByText("End the Exec Sessions in c?")).toBeDefined();
  expect(
    screen.getByText(
      `${count === 1 ? "1 Exec Session is" : "2 Exec Sessions are"} running. A command still running in the container may keep running.`,
    ),
  ).toBeDefined();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(close).not.toHaveBeenCalled();
  act(() => guardWorkspace("c", close));
  fireEvent.click(screen.getByRole("button", { name: "End sessions and close" }));
  expect(close).toHaveBeenCalledOnce();
});
it("uses one dialog to name edits and sessions together", async () => {
  session("id");
  useUnsavedEdits
    .getState()
    .set("edit", { cluster: "c", label: "ConfigMap web", read: () => "mine" });
  render(<UnsavedGuard />);
  const close = vi.fn<() => void>();
  act(() => guardWorkspace("c", close));
  expect(await screen.findByText("Close c?")).toBeDefined();
  expect(
    screen.getByText(
      "1 Resource has unsaved edits. 1 Exec Session is running. A command still running in the container may keep running.",
    ),
  ).toBeDefined();
  expect(screen.getAllByRole("alertdialog")).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "Discard and close" }));
  expect(close).toHaveBeenCalledOnce();
});
it.each<[ExecState, boolean]>([
  [{ phase: "starting" }, true],
  [{ phase: "live" }, true],
  [{ phase: "waiting" }, false],
  [{ phase: "ended", reason: "lost" }, false],
])("prompts at unload only for starting or live sessions: %j", (state, guarded) => {
  session("id", state);
  render(<UnsavedGuard />);
  const event = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(guarded);
});
it("guards resource and Cluster actions and the Host unload until edits are discarded", async () => {
  useUnsavedEdits.getState().set("constructor", {
    cluster: "__proto__",
    label: "ConfigMap constructor",
    read: () => "data: mine",
  });
  render(<UnsavedGuard />);
  const close = vi.fn<() => void>();
  act(() => guardPanel("constructor", close));
  expect(await screen.findByText("Discard your edits to ConfigMap constructor?")).toBeDefined();
  fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
  expect(close).not.toHaveBeenCalled();
  act(() => guardWorkspace("__proto__", close));
  expect(await screen.findByText("1 Resource has unsaved edits.")).toBeDefined();
  fireEvent.click(screen.getByRole("button", { name: "Discard and close" }));
  expect(close).toHaveBeenCalledOnce();
  const event = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(true);
  act(() => useUnsavedEdits.getState().set("constructor"));
  const clean = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(clean);
  expect(clean.defaultPrevented).toBe(false);
});
it("copies YAML without navigator.clipboard and restores focus", async () => {
  const command = vi.fn<(name: string) => boolean>(() => true);
  Object.defineProperty(document, "execCommand", { configurable: true, value: command });
  vi.stubGlobal("navigator", {});
  const button = document.createElement("button");
  document.body.append(button);
  button.focus();
  await copyText("data: mine");
  expect(command).toHaveBeenCalledWith("copy");
  expect(document.activeElement).toBe(button);
  expect(document.querySelector("textarea")).toBeNull();
  button.remove();
});

it.each(["button", "middle click"])("guards the Tab's %s close path", async (action) => {
  const { PanelTab } = await import("../workspace/panel-tab.tsx");
  const close = vi.fn<() => void>();
  const props = {
    api: { id: "tab", title: "web", close, onDidTitleChange: () => ({ dispose: () => {} }) },
    params: {},
  } as unknown as Parameters<typeof PanelTab>[0];
  useUnsavedEdits
    .getState()
    .set("tab", { cluster: "c", label: "ConfigMap web", read: () => "data: mine" });
  const view = render(
    <>
      <PanelTab {...props} />
      <UnsavedGuard />
    </>,
  );
  if (action === "button") fireEvent.click(screen.getByRole("button", { name: "Close web" }));
  else
    fireEvent(
      view.container.firstElementChild!,
      new MouseEvent("auxclick", { bubbles: true, button: 1 }),
    );
  expect(await screen.findByText("Discard your edits to ConfigMap web?")).toBeDefined();
  fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
  expect(close).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Close web" }));
  fireEvent.click(screen.getByRole("button", { name: "Discard edits" }));
  expect(close).toHaveBeenCalledOnce();
});
