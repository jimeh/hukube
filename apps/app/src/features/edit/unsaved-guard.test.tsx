// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useUnsavedEdits, guardWorkspace, guardPanel } from "./unsaved-edits.ts";
import { UnsavedGuard as Guard } from "./unsaved-guard.tsx";
import { HostProvider } from "@/lib/host.tsx";
import type { Host } from "@hukube/host";
const reportOpenWork = vi.fn<(work: { edits: number; sessions: number }) => void>();
const host: Host = {
  kind: "web",
  engine: async () => ({ url: "", token: "" }),
  openWindow: () => {},
  openExternal: () => {},
  reportOpenWork,
};
function UnsavedGuard() {
  return (
    <HostProvider host={host}>
      <Guard />
    </HostProvider>
  );
}
import { copyText } from "./clipboard.ts";
import { useExecSessions, endSession, type ExecState } from "../exec/sessions.ts";
// Imported here, not inside a test: loading the icon set takes seconds on a
// slow machine, which would count against the first test's time limit.
import { PanelTab } from "../workspace/panel-tab.tsx";
vi.mock("../workspace/workspace-context.tsx", () => ({ useWorkspace: () => ({ cluster: "c" }) }));

afterEach(() => {
  cleanup();
  for (const id of useExecSessions.getState().entries.keys()) endSession(id);
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
    session("id", { phase: "starting" });
    const close = vi.fn<() => void>();
    const props = {
      api: {
        id: "exec:id",
        title: "web",
        close,
        onDidTitleChange: () => ({ dispose: () => {} }),
        onDidActiveChange: () => ({ dispose: () => {} }),
      },
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
it("closes and moves a Workspace with sessions without prompting and asks only about edits", () => {
  session("id");
  render(<UnsavedGuard />);
  const close = vi.fn<() => void>();
  act(() => guardWorkspace("c", close));
  expect(close).toHaveBeenCalledOnce();
  expect(screen.queryByRole("alertdialog")).toBeNull();
  act(() =>
    useUnsavedEdits
      .getState()
      .set("edit", { cluster: "c", label: "ConfigMap web", read: () => "mine" }),
  );
  act(() => guardWorkspace("c", close));
  expect(screen.getByText("Discard unsaved edits in c?")).toBeDefined();
  expect(screen.getByText("1 Resource has unsaved edits.")).toBeDefined();
  fireEvent.click(screen.getByRole("button", { name: "Discard and close" }));
  expect(close).toHaveBeenCalledTimes(2);
});

it("guards held Tabs only and reports changed counts to the Host", () => {
  render(<UnsavedGuard />);
  const close = vi.fn<() => void>();
  for (const [state, held] of [
    [{ phase: "starting" }, true],
    [{ phase: "attaching" }, true],
    [{ phase: "live" }, true],
    [{ phase: "reconnecting" }, true],
    [{ phase: "waiting", attaching: true }, true],
    [{ phase: "waiting" }, false],
    [{ phase: "elsewhere" }, false],
    [{ phase: "gone" }, false],
    [{ phase: "ended", reason: "complete" }, false],
    [{ phase: "failed", reason: "error" }, false],
  ] as [ExecState, boolean][]) {
    act(() => {
      session("id", state);
      useUnsavedEdits.getState().dismiss();
      guardPanel("exec:id", close);
    });
    expect(!!useUnsavedEdits.getState().guard).toBe(held);
    expect(reportOpenWork).toHaveBeenLastCalledWith({ edits: 0, sessions: Number(held) });
  }
  act(() => useUnsavedEdits.getState().set("edit", { cluster: "c", label: "Pod", read: () => "" }));
  expect(reportOpenWork).toHaveBeenLastCalledWith({ edits: 1, sessions: 0 });
});

it.each(["web", "desktop"] as const)(
  "refuses an unload on the %s Host according to open work",
  (kind) => {
    const desktop: Host = { ...host, kind };
    render(
      <HostProvider host={desktop}>
        <Guard />
      </HostProvider>,
    );
    for (const [state, held] of [
      [{ phase: "live" }, true],
      [{ phase: "reconnecting" }, true],
      [{ phase: "elsewhere" }, false],
      [{ phase: "waiting" }, false],
    ] as [ExecState, boolean][]) {
      act(() => session("id", state));
      const event = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(kind === "desktop" && held);
    }
    act(() =>
      useUnsavedEdits.getState().set("edit", { cluster: "c", label: "Pod", read: () => "" }),
    );
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  },
);
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
  const close = vi.fn<() => void>();
  const props = {
    api: {
      id: "tab",
      title: "web",
      close,
      onDidTitleChange: () => ({ dispose: () => {} }),
      onDidActiveChange: () => ({ dispose: () => {} }),
    },
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

it("mutes unattached session icons without striking their titles, and strikes sessions that are over", () => {
  const api = {
    id: "exec:id",
    title: "web",
    close: () => {},
    onDidTitleChange: () => ({ dispose: () => {} }),
    onDidActiveChange: () => ({ dispose: () => {} }),
  } as unknown as Parameters<typeof PanelTab>[0]["api"];
  const props = { api, params: {} } as Parameters<typeof PanelTab>[0];
  const view = render(<PanelTab {...props} />);
  for (const phase of [
    "starting",
    "attaching",
    "live",
    "reconnecting",
    "elsewhere",
    "waiting",
    "ended",
    "failed",
    "gone",
  ] as const) {
    act(() =>
      session(
        "id",
        phase === "ended" || phase === "failed" ? { phase, reason: "complete" } : { phase },
      ),
    );
    const over = ["ended", "failed", "gone"].includes(phase);
    expect(screen.getByText("web").classList.contains("line-through")).toBe(over);
    expect(view.container.querySelector("svg")!.classList.contains("text-cluster")).toBe(
      phase === "live" || phase === "starting",
    );
    expect(view.container.firstElementChild!.getAttribute("title")).toBe(
      `Exec Session, ${phase === "elsewhere" ? "open in another window" : phase}: web`,
    );
  }
});
