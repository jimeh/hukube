// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useUnsavedEdits, guardCluster, guardResource } from "./unsaved-edits.ts";
import { UnsavedGuard } from "./unsaved-guard.tsx";
import { copyText } from "./clipboard.ts";
afterEach(() => {
  cleanup();
  useUnsavedEdits.setState({ entries: new Map(), guard: undefined });
  vi.unstubAllGlobals();
});
it("guards resource and Cluster actions and the Host unload until edits are discarded", async () => {
  useUnsavedEdits.getState().set("constructor", {
    cluster: "__proto__",
    label: "ConfigMap constructor",
    read: () => "data: mine",
  });
  render(<UnsavedGuard />);
  const close = vi.fn<() => void>();
  act(() => guardResource("constructor", close));
  expect(await screen.findByText("Discard your edits to ConfigMap constructor?")).toBeDefined();
  fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
  expect(close).not.toHaveBeenCalled();
  act(() => guardCluster("__proto__", close));
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
