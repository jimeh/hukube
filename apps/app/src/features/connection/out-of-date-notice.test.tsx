// @vitest-environment jsdom

import type { ConnectionState, EngineClient } from "@hukube/engine-client";
import { EngineProvider } from "@hukube/engine-client/react";
import type { Host } from "@hukube/host";
import { act, cleanup, render, screen, within, fireEvent } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { HostProvider } from "../../lib/host.tsx";
import { useUnsavedEdits } from "../edit/unsaved-edits.ts";
vi.mock("../edit/clipboard.ts", () => ({
  copyText: vi.fn<() => Promise<void>>(() => Promise.resolve()),
}));
import { OutOfDateNotice } from "./out-of-date-notice.tsx";

class FakeEngineClient implements EngineClient {
  openStream: EngineClient["openStream"] = () => {
    throw new Error("unexpected stream");
  };
  state: ConnectionState = "open";
  listeners = new Set<() => void>();

  request: EngineClient["request"] = () => {
    throw new Error("unexpected request");
  };
  subscribe: EngineClient["subscribe"] = () => {
    throw new Error("unexpected subscription");
  };
  getState() {
    return this.state;
  }
  onStateChange(listener: () => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  setState(state: ConnectionState) {
    this.state = state;
    for (const listener of this.listeners) listener();
  }
  close() {}
}

afterEach(() => {
  cleanup();
  useUnsavedEdits.setState({ entries: new Map() });
  vi.useRealTimers();
});

function renderNotice(kind: Host["kind"], state: ConnectionState = "open") {
  const client = new FakeEngineClient();
  client.state = state;
  const host: Host = {
    kind,
    engine: () => Promise.resolve({ url: "http://localhost", token: "t" }),
    openWindow: () => {},
    openExternal: () => {},
  };
  const view = render(
    <EngineProvider client={client}>
      <HostProvider host={host}>
        <OutOfDateNotice />
      </HostProvider>
    </EngineProvider>,
  );
  return { client, ...view };
}

describe("OutOfDateNotice", () => {
  it("renders nothing while the connection is open", () => {
    const { container } = renderNotice("web");
    expect(container.childElementCount).toBe(0);
  });

  it("tells a web Host to reload when outdated", () => {
    renderNotice("web", "outdated");
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("This page is out of date");
    expect(alert.textContent).toContain(
      "The Engine was updated after this page loaded, so live data has stopped. Reload to continue.",
    );
    expect(within(alert).getByRole("button", { name: "Reload" })).toBeDefined();
  });

  it("tells a desktop Host to quit and reopen when outdated without a button", () => {
    renderNotice("desktop", "outdated");
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("This window is out of date");
    expect(alert.textContent).toContain(
      "hukube was updated while it was running, so live data has stopped. Quit and reopen hukube to continue.",
    );
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("focuses the alert when the connection changes from open to outdated", () => {
    const { client } = renderNotice("web");
    expect(screen.queryByRole("alert")).toBeNull();
    act(() => client.setState("outdated"));
    expect(document.activeElement).toBe(screen.getByRole("alert"));
  });
});

it("announces Copied for two seconds for unsaved edits", async () => {
  useUnsavedEdits
    .getState()
    .set("p", { cluster: "c", label: "ConfigMap web", read: () => "kind: ConfigMap" });
  renderNotice("web", "outdated");
  vi.useFakeTimers();
  fireEvent.click(screen.getByRole("button", { name: "Copy unsaved edits" }));
  await act(async () => {});
  expect(
    screen.getByRole("button", { name: "Copied" }).querySelector('[aria-live="polite"]'),
  ).not.toBeNull();
  await act(() => vi.advanceTimersByTime(2000));
  expect(screen.getByRole("button", { name: "Copy unsaved edits" })).toBeDefined();
});
