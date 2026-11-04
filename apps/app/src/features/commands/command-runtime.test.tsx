// @vitest-environment jsdom
import { useState } from "react";
import { flushSync } from "react-dom";
import { Dialog, DialogContent, DialogTitle } from "@hukube/ui/components/dialog";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { EngineProvider } from "@hukube/engine-client/react";
import type { EngineClient, Setting } from "@hukube/engine-client";
import { createBrowserHost } from "@hukube/host";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { DockviewApi, IDockviewPanel } from "dockview-react";
import type { WorkspaceValue } from "../workspace/workspace-context.tsx";
import { HostProvider } from "@/lib/host.tsx";
import { CommandRuntime } from "./command-runtime.tsx";
import { commands, type Surface } from "./runtime.ts";

const scrollIntoView = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollIntoView");
beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: () => {},
  });
  vi.useFakeTimers();
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([{}] as unknown as DOMRectList);
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});
afterEach(() => {
  commands.closePalette(false);
  commands.blur();
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (scrollIntoView)
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", scrollIntoView);
  else Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
});

async function setup(workspace = false, resource: boolean | "hydrated" = false) {
  // Only the Engine transport is fake. Stores, root hooks, modal count and Base UI
  // focus/transition owners are mounted together, as in the real window.
  const request = vi.fn<(...args: unknown[]) => Promise<unknown>>(async (method) =>
    String(method).startsWith("resources.") ? { rows: [], total: 0 } : {},
  );
  let connection = "open";
  const stateListeners = new Set<() => void>();
  let setModal!: (open: boolean) => void;
  const client = {
    request,
    getState: () => connection,
    onStateChange: (listener: () => void) => {
      stateListeners.add(listener);
      return () => stateListeners.delete(listener);
    },
    subscribe: (method: string, params: { key: string }, listener: { data(s: unknown): void }) => {
      queueMicrotask(() =>
        listener.data(
          method.startsWith("resources.")
            ? { rows: [], total: 0 }
            : ({ key: params.key, revision: "", value: null } satisfies Setting),
        ),
      );
      return { close() {}, update() {} };
    },
  } as unknown as EngineClient;
  const root = createRootRoute({
    component: function Root() {
      const [modal, updateModal] = useState(false);
      setModal = updateModal;
      return (
        <EngineProvider client={client}>
          <HostProvider host={createBrowserHost()}>
            <CommandRuntime />
            <div data-command-panel="p">
              <textarea aria-label="Origin" />
            </div>
            <Dialog open={modal} onOpenChange={updateModal}>
              <DialogContent>
                <DialogTitle>Other owner</DialogTitle>
                <input aria-label="Other input" />
              </DialogContent>
            </Dialog>
          </HostProvider>
        </EngineProvider>
      );
    },
  });
  const router = createRouter({
    routeTree: root,
    history: createMemoryHistory({ initialEntries: [workspace ? "/c/c" : "/"] }),
  });
  const container = document.createElement("div");
  container.id = "root";
  document.body.append(container);
  await act(async () => {
    render(<RouterProvider router={router} />, { container });
  });
  const value = { active: true, cluster: "c", types: new Map() } as unknown as WorkspaceValue;
  const panel = {
    id: "p",
    group: {},
    params: { uri: "original" },
    api: { title: "Original Resource", component: "resource" },
  } as unknown as IDockviewPanel;
  const unregisterWorkspace = workspace
    ? commands.registerWorkspace("c", {
        token: {},
        value,
        api: {
          getPanel: () => (resource ? panel : undefined),
          activePanel: resource ? panel : undefined,
        } as unknown as DockviewApi,
      })
    : () => {};
  const origin = screen.getByRole("textbox", { name: "Origin" });
  let uid: string | undefined = resource === "hydrated" ? undefined : "original";
  const review = vi.fn<() => void>();
  const surface: Surface = {
    element: origin.parentElement!,
    read: () => ({ kind: "resource", uid, review }),
  };
  let unregisterSurface = resource ? commands.registerSurface(surface) : () => {};
  const unregister = () => {
    unregisterSurface();
    unregisterWorkspace();
  };
  origin.focus();
  await act(async () => {
    commands.openPalette("commands");
  });
  await act(async () => {
    vi.advanceTimersToNextFrame();
  });
  const search = screen.getByLabelText("Search commands");
  expect(document.activeElement).toBe(search);
  return {
    origin,
    panel,
    review,
    changeResource: (change: string) => {
      if (change === "remount") {
        unregisterSurface();
        unregisterSurface = commands.registerSurface({ ...surface });
      } else
        uid = change === "deleted" ? undefined : change === "original" ? "original" : "replacement";
      commands.refreshAvailability();
    },
    search,
    request,
    value,
    unregister,
    router,
    setModal,
    setConnection: (state: string) => {
      connection = state;
      for (const notify of stateListeners) notify();
    },
  };
}

it.each(["Enter", "Escape"])(
  "returns focus after the real dialog exit animation and %s release",
  async (key) => {
    const { origin, search } = await setup();
    const popup = screen.getByRole("dialog", { name: "Command palette" });
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const animations = vi.fn<() => Animation[]>(() => [{ finished }] as unknown as Animation[]);
    popup.getAnimations = animations;
    // Enter selects the first command, which toggles this palette closed.
    fireEvent.keyDown(search, { key, code: key });
    fireEvent.keyUp(window, { key, code: key });
    await act(async () => {
      vi.advanceTimersToNextFrame();
    });
    expect(animations).toHaveBeenCalled();
    expect(popup.isConnected).toBe(true);
    expect(document.activeElement).not.toBe(origin);
    await act(async () => {
      finish();
      await finished;
    });
    await act(async () => {
      vi.advanceTimersToNextFrame();
    });
    expect(popup.isConnected).toBe(false);
    expect(document.activeElement).toBe(origin);
  },
);

it.each([
  ["appearance.setTheme", "Theme (required)", "Theme: Choose a value."],
  ["logs.setWrap", "Enabled (required)", "Enabled: Choose Yes or No."],
  ["resource.openType", "Resource Type (required)", "Resource Type: Enter a value."],
] as const)(
  "labels missing %s arguments and focuses the first invalid field",
  async (id, label, message) => {
    await setup();
    act(() => commands.editArguments(id, commands.getSnapshot().palette!.origin));
    const field = screen.getByLabelText(label);
    fireEvent.click(screen.getByRole("button", { name: "Run command" }));
    expect(field.getAttribute("aria-invalid")).toBe("true");
    expect(document.activeElement).toBe(field);
    expect(
      (field.getAttribute("aria-describedby") ?? "")
        .split(" ")
        .some((descriptionId) => document.getElementById(descriptionId)?.textContent === message),
    ).toBe(true);
  },
);
it("keeps command orientation and canonical Resource URI guidance with associated invalid feedback", async () => {
  await setup();
  act(() => commands.editArguments("resource.open", commands.getSnapshot().palette!.origin));
  const field = screen.getByLabelText("Resource URI (required)");
  fireEvent.change(field, { target: { value: "pod-name" } });
  fireEvent.click(screen.getByRole("button", { name: "Run command" }));
  expect(field.getAttribute("aria-invalid")).toBe("true");
  expect(document.activeElement).toBe(field);
  expect(screen.getByRole("heading", { name: "Open Resource" })).toBeTruthy();
  expect(field.getAttribute("placeholder")).toMatch(/^hukube:\/\/resource\/v1\//);
  const description = (field.getAttribute("aria-describedby") ?? "")
    .split(" ")
    .map((id) => document.getElementById(id)?.textContent)
    .join(" ");
  expect(description).toContain("percent-encoded");
  expect(description).toContain("cluster-scoped");
  expect(description).toContain("Resource URI: Use a canonical Resource URI.");
});
it("submits corrected arguments once through Enter and Escape returns from arguments to search", async () => {
  const { request } = await setup();
  act(() => {
    commands.invoke("appearance.setTheme", {}, commands.getSnapshot().palette!.origin);
  });
  fireEvent.click(screen.getByRole("button", { name: "Run command" }));
  fireEvent.change(screen.getByLabelText("Theme (required)"), { target: { value: "dark" } });
  await act(async () => {
    fireEvent.submit(screen.getByRole("button", { name: "Run command" }).closest("form")!);
  });
  expect(request).toHaveBeenCalledTimes(1);
  expect(commands.getSnapshot().palette).toBeUndefined();
  await act(async () => {
    commands.openPalette("commands");
  });
  act(() => commands.editArguments("resource.open", commands.getSnapshot().palette!.origin));
  fireEvent.keyDown(screen.getByLabelText("Resource URI (required)"), {
    key: "Escape",
    code: "Escape",
  });
  fireEvent.keyUp(window, { key: "Escape", code: "Escape" });
  expect(commands.getSnapshot().palette?.prompt).toBeUndefined();
  expect(request).toHaveBeenCalledTimes(1);
});

async function frame() {
  await act(async () => {
    vi.advanceTimersToNextFrame();
  });
}

it.each(["pointer", "Escape"])(
  "Back by %s restores Search ownership after invalid arguments",
  async (method) => {
    await setup();
    fireEvent.change(screen.getByLabelText("Search commands"), {
      target: { value: "Open Resource" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Edit arguments for Open Resource" }));
    const field = screen.getByLabelText("Resource URI (required)");
    fireEvent.change(field, { target: { value: "pod-name" } });
    fireEvent.click(screen.getByRole("button", { name: "Run command" }));
    expect(field.getAttribute("aria-invalid")).toBe("true");
    expect(document.activeElement).toBe(field);
    if (method === "pointer") {
      const back = screen.getByRole("button", { name: "Back" });
      back.focus();
      fireEvent.click(back);
    } else {
      fireEvent.keyDown(field, { key: "Escape", code: "Escape" });
      fireEvent.keyUp(window, { key: "Escape", code: "Escape" });
    }
    await frame();
    const search = screen.getByLabelText("Search commands");
    expect(document.activeElement).toBe(search);
    // Deliver text to the actual focus owner, never select Search as a recovery.
    fireEvent.input(document.activeElement!, { target: { value: "Open Resourcexyz" } });
    expect(search).toHaveProperty("value", "Open Resourcexyz");
  },
);

it("reopens before the old popup exits and keeps immediate typing ownership", async () => {
  const { origin } = await setup();
  const popup = screen.getByRole("dialog", { name: "Command palette" });
  let finish!: () => void;
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });
  popup.getAnimations = () => [{ finished }] as unknown as Animation[];
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  await frame();
  expect(popup.isConnected).toBe(true);
  act(() => commands.openPalette("commands", { route: "/", element: origin }));
  await frame();
  const search = screen.getByLabelText("Search commands");
  expect(document.activeElement).toBe(search);
  fireEvent.input(document.activeElement!, { target: { value: "xyz" } });
  expect(search).toHaveProperty("value", "xyz");
  await act(async () => {
    finish();
    await finished;
  });
  await frame();
  expect(document.activeElement).toBe(search);
});

it("preserves deliberate pointer focus and Search selection through ordinary updates", async () => {
  await setup();
  const button = screen.getByRole("button", {
    name: "Edit arguments for Open Resource",
  });
  button.focus();
  act(() => commands.refreshAvailability());
  await frame();
  expect(document.activeElement).toBe(button);
  const search = screen.getByLabelText("Search commands") as HTMLInputElement;
  fireEvent.change(search, { target: { value: "Resource" } });
  search.focus();
  search.setSelectionRange(2, 5);
  act(() => commands.refreshAvailability());
  await frame();
  expect(document.activeElement).toBe(search);
  expect([search.selectionStart, search.selectionEnd]).toEqual([2, 5]);
});

it("changes command and Resource modes with one useful input and one dialog", async () => {
  const { unregister } = await setup(true);
  try {
    for (const mode of ["Go to Resource", "Commands", "Go to Resource"]) {
      fireEvent.click(screen.getByRole("button", { name: mode }));
      await frame();
      expect(screen.getAllByRole("dialog")).toHaveLength(1);
      const input = screen.getByLabelText(
        mode === "Commands" ? "Search commands" : "Go to Resource",
        { selector: "input" },
      );
      expect(document.activeElement).toBe(input);
      fireEvent.input(document.activeElement!, { target: { value: "xyz" } });
      expect(input).toHaveProperty("value", "xyz");
    }
  } finally {
    act(unregister);
  }
});

it.each(["commands", "resources"] as const)(
  "opens %s after actual close with immediate input ownership",
  async (mode) => {
    const { origin, unregister } = await setup(true);
    try {
      fireEvent.click(screen.getByRole("button", { name: "Close" }));
      await frame();
      expect(screen.queryByRole("dialog")).toBeNull();
      await act(async () => commands.openPalette(mode, commands.capture("c", undefined, origin)));
      const input = screen.getByLabelText(
        mode === "commands" ? "Search commands" : "Go to Resource",
        { selector: "input" },
      );
      expect(document.activeElement).toBe(input);
      await frame();
      expect(document.activeElement).toBe(input);
    } finally {
      act(unregister);
    }
  },
);

it.each(["pointer", "Tab"])(
  "does not override deliberate %s focus at open completion or availability publication",
  async (method) => {
    const { value, unregister } = await setup(true);
    try {
      const search = screen.getByLabelText("Search commands");
      const target = screen.getByRole("button", { name: "Close" });
      if (method === "Tab") fireEvent.keyDown(search, { key: "Tab", code: "Tab" });
      else fireEvent.pointerDown(target);
      // jsdom does not perform the browser's native pointer/Tab default focus.
      target.focus();
      act(() => {
        value.types = new Map();
        commands.refreshAvailability();
      });
      await frame();
      expect(document.activeElement).toBe(target);
    } finally {
      act(unregister);
    }
  },
);

it.each(["blur", "recording"])(
  "does not reclaim focus after %s supersedes a pending close",
  async (boundary) => {
    const { origin } = await setup();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await act(async () => {});
    // The public close callback has run; the existing return commit frame has not.
    const next = document.createElement("button");
    document.body.append(next);
    next.focus();
    act(() => {
      if (boundary === "blur") commands.blur();
      else commands.setRecording(true);
    });
    await frame();
    expect(document.activeElement).toBe(next);
    expect(document.activeElement).not.toBe(origin);
    act(() => commands.setRecording(false));
    next.remove();
  },
);

it.each(["blur", "recording", "route", "modal", "outdated", "hidden", "workspace"])(
  "a real late close completion cannot reclaim focus after %s supersession",
  async (boundary) => {
    const h = await setup(true);
    try {
      const popup = screen.getByRole("dialog", { name: "Command palette" });
      let finish!: () => void;
      const finished = new Promise<void>((resolve) => {
        finish = resolve;
      });
      popup.getAnimations = () => [{ finished }] as unknown as Animation[];
      fireEvent.click(screen.getByRole("button", { name: "Close" }));
      await frame();
      expect(popup.isConnected).toBe(true);
      await act(async () => {
        switch (boundary) {
          case "blur":
            commands.blur();
            break;
          case "recording":
            commands.setRecording(true);
            commands.setRecording(false);
            break;
          case "route":
            await h.router.navigate({
              to: "/settings/$section",
              params: { section: "appearance" },
            });
            break;
          case "modal":
            h.setModal(true);
            break;
          case "outdated":
            h.setConnection("outdated");
            break;
          case "hidden":
            h.value.active = false;
            commands.refreshAvailability();
            h.value.active = true;
            break;
          case "workspace":
            h.unregister();
            break;
        }
      });
      const next = boundary === "modal" ? screen.getByLabelText("Other input") : h.origin;
      next.focus();
      await act(async () => {
        finish();
        await finished;
      });
      await frame();
      expect(popup.isConnected).toBe(false);
      expect(document.activeElement).toBe(next);
      act(() => {
        h.setModal(false);
        h.setConnection("open");
      });
    } finally {
      act(h.unregister);
    }
  },
);

it("releases the outgoing view before a removal blur can schedule a stale popup restore", async () => {
  const { origin, search } = await setup();
  const popup = screen.getByRole("dialog", { name: "Command palette" });
  let finish!: () => void;
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });
  popup.getAnimations = () => [{ finished }] as unknown as Animation[];
  await act(async () => {
    // Browsers emit this focusout as a focused control disappears. jsdom removes
    // focus without that event, so dispatch the native boundary explicitly.
    fireEvent.focusOut(search, { relatedTarget: null });
    flushSync(() => commands.closePalette());
  });
  // Reopen before advancing the old restore/animation frame.
  act(() => commands.openPalette("commands", { route: "/", element: origin }));
  const current = screen.getByLabelText("Search commands");
  expect(document.activeElement).toBe(current);
  await frame();
  expect(document.activeElement).toBe(current);
  await act(async () => {
    finish();
    await finished;
  });
  await frame();
  expect(document.activeElement).toBe(current);
});

it.each(
  ["hydrated", "deleted", "replaced", "remount"].flatMap((change) =>
    ["pointer", "Escape"].map((back) => ({ change, back })),
  ),
)(
  "stale Resource $change retains useful Back by $back and both mode inputs",
  async ({ change, back }) => {
    const h = await setup(true, change === "hydrated" ? "hydrated" : true);
    try {
      const captured = commands.getSnapshot().palette!.origin;
      fireEvent.change(h.search, { target: { value: "Open Resource" } });
      fireEvent.click(screen.getByRole("button", { name: "Edit arguments for Open Resource" }));
      const field = screen.getByLabelText("Resource URI (required)");
      expect(document.activeElement).toBe(field);
      act(() => h.changeResource(change));
      // Ordinary identity/availability updates retain the current field and caret.
      expect(document.activeElement).toBe(field);
      fireEvent.input(document.activeElement!, { target: { value: "draftxyz" } });
      expect(field).toHaveProperty("value", "draftxyz");
      if (back === "pointer") {
        const button = screen.getByRole("button", { name: "Back" });
        button.focus();
        fireEvent.click(button);
      } else {
        fireEvent.keyDown(field, { key: "Escape", code: "Escape" });
        fireEvent.keyUp(window, { key: "Escape", code: "Escape" });
      }
      await frame();
      const search = screen.getByLabelText("Search commands");
      expect(document.activeElement).toBe(search);
      fireEvent.input(document.activeElement!, { target: { value: "Open Resourcexyz" } });
      expect(search).toHaveProperty("value", "Open Resourcexyz");
      for (const mode of ["Go to Resource", "Commands"]) {
        fireEvent.click(screen.getByRole("button", { name: mode }));
        await frame();
        const input = screen.getByLabelText(mode === "Commands" ? "Search commands" : mode, {
          selector: "input",
        });
        expect(document.activeElement).toBe(input);
        fireEvent.input(document.activeElement!, { target: { value: "typed" } });
        expect(input).toHaveProperty("value", "typed");
        expect(commands.getSnapshot().palette?.origin).toBe(captured);
      }
      act(() => {
        expect(commands.invoke("manifest.review", {}, captured)).toBe(false);
      });
      expect(commands.getSnapshot().error).toContain("captured target changed");
      expect(h.review).not.toHaveBeenCalled();
    } finally {
      act(h.unregister);
    }
  },
);

it("Resource updates preserve deliberate palette focus and selection without reviving a superseded claim", async () => {
  const h = await setup(true, true);
  try {
    const search = h.search as HTMLInputElement;
    fireEvent.change(search, { target: { value: "Resource" } });
    search.setSelectionRange(2, 5);
    act(() => h.changeResource("replaced"));
    await frame();
    expect(document.activeElement).toBe(search);
    expect([search.selectionStart, search.selectionEnd]).toEqual([2, 5]);
    const close = screen.getByRole("button", { name: "Close" });
    close.focus();
    act(() => h.changeResource("remount"));
    await frame();
    expect(document.activeElement).toBe(close);
    const palette = commands.getSnapshot().palette!;
    act(() => commands.blur());
    act(() => h.changeResource("deleted"));
    await frame();
    expect(commands.ownsPaletteInput(palette)).toBe(false);
    expect(document.activeElement).toBe(close);
  } finally {
    act(h.unregister);
  }
});

it("keeps an unavailable-only search readable and disabled through Enter and pointer activation", async () => {
  const { search } = await setup();
  const palette = commands.getSnapshot().palette;
  fireEvent.change(search, { target: { value: "Go to Resource" } });
  await frame();
  const row = screen.getByRole("option", { name: /Go to Resource/ });
  expect(row.textContent).toContain("Open a Cluster Workspace first.");
  expect(row.getAttribute("aria-disabled")).toBe("true");
  fireEvent.keyDown(search, { key: "ArrowDown", code: "ArrowDown" });
  fireEvent.keyDown(search, { key: "Enter", code: "Enter" });
  fireEvent.keyUp(window, { key: "Enter", code: "Enter" });
  fireEvent.pointerMove(row);
  fireEvent.click(row);
  await frame();
  expect(commands.getSnapshot().palette).toBe(palette);
  expect(commands.getSnapshot().error).toBe("");
  expect(document.activeElement).toBe(search);
  fireEvent.change(search, { target: { value: "Set theme" } });
  await frame();
  const available = screen.getByRole("option", { name: /Set theme/i });
  expect(available.getAttribute("aria-disabled")).toBe("false");
  fireEvent.keyDown(search, { key: "Enter", code: "Enter" });
  expect(screen.getByLabelText("Theme (required)")).toBe(document.activeElement);
});

it.each(["deleted", "replaced"])(
  "refreshes real cmdk disabled state when the captured Resource is %s",
  async (change) => {
    const h = await setup(true, true);
    try {
      const captured = commands.getSnapshot().palette!.origin;
      fireEvent.change(h.search, { target: { value: "Review Manifest changes" } });
      await frame();
      const row = screen.getByRole("option", { name: /Review Manifest changes/ });
      expect(row.getAttribute("aria-disabled")).toBe("false");
      act(() => h.changeResource(change));
      await frame();
      expect(row.getAttribute("aria-disabled")).toBe("true");
      expect(row.textContent).toContain("The captured target changed or is no longer available.");
      fireEvent.keyDown(h.search, { key: "Enter", code: "Enter" });
      fireEvent.keyUp(window, { key: "Enter", code: "Enter" });
      fireEvent.click(row);
      await frame();
      expect(h.review).not.toHaveBeenCalled();
      expect(commands.getSnapshot().palette?.origin).toBe(captured);
      expect(commands.getSnapshot().error).toBe("");
      act(() => expect(commands.invoke("manifest.review", {}, captured)).toBe(false));
      expect(commands.getSnapshot().error).toContain("captured target changed");
      expect(h.review).not.toHaveBeenCalled();
      act(() => h.changeResource("original"));
      await frame();
      expect(row.getAttribute("aria-disabled")).toBe("false");
      fireEvent.click(row);
      expect(h.review).toHaveBeenCalledTimes(1);
      expect(commands.getSnapshot().palette).toBeUndefined();
    } finally {
      act(h.unregister);
    }
  },
);

it("keeps Arguments Enter away from cmdk selection for multiple rows", async () => {
  const h = await setup();
  fireEvent.change(h.search, { target: { value: "app." } });
  const button = screen.getByRole("button", { name: "Edit arguments for Open Settings" });
  button.focus();
  fireEvent.keyDown(button, { key: "Enter", code: "Enter" });
  expect(commands.getSnapshot().palette?.mode).toBe("commands");
  expect(commands.getSnapshot().palette?.prompt).toBeUndefined();
  expect(h.router.state.location.pathname).toBe("/");
  // jsdom has no native Enter default. Browser verification checks the resulting click.
  const press = new KeyboardEvent("keypress", {
    key: "Enter",
    code: "Enter",
    cancelable: true,
    bubbles: true,
  });
  fireEvent(button, press);
  expect(press.defaultPrevented).toBe(false);
  fireEvent.keyUp(button, { key: "Enter", code: "Enter" });
  h.unregister();
});
