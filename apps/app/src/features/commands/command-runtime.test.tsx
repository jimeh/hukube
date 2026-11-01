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
  const client = {
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
  return { origin, search };
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
