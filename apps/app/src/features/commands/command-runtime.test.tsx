// @vitest-environment jsdom
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
import { HostProvider } from "@/lib/host.tsx";
import { CommandRuntime } from "./command-runtime.tsx";
import { commands } from "./runtime.ts";

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

async function setup() {
  // Only the Engine transport is fake. Stores, root hooks, modal count and Base UI
  // focus/transition owners are mounted together, as in the real window.
  const request = vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({}));
  const client = {
    request,
    getState: () => "open",
    onStateChange: () => () => {},
    subscribe: (_method: string, params: { key: string }, listener: { data(s: Setting): void }) => {
      queueMicrotask(() => listener.data({ key: params.key, revision: "", value: null }));
      return { close() {}, update() {} };
    },
  } as unknown as EngineClient;
  const root = createRootRoute({
    component: () => (
      <EngineProvider client={client}>
        <HostProvider host={createBrowserHost()}>
          <CommandRuntime />
          <textarea aria-label="Origin" />
        </HostProvider>
      </EngineProvider>
    ),
  });
  const router = createRouter({ routeTree: root, history: createMemoryHistory() });
  const container = document.createElement("div");
  container.id = "root";
  document.body.append(container);
  await act(async () => {
    render(<RouterProvider router={router} />, { container });
  });
  const origin = screen.getByRole("textbox", { name: "Origin" });
  origin.focus();
  await act(async () => {
    commands.openPalette("commands");
  });
  await act(async () => {
    vi.advanceTimersToNextFrame();
  });
  const search = screen.getByLabelText("Search commands");
  expect(document.activeElement).toBe(search);
  return { origin, search, request };
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
