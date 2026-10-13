// @vitest-environment jsdom
import {
  EngineRequestError,
  type EngineClient,
  type ConnectionState,
  type Related,
} from "@hukube/engine-client";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { EngineProvider } from "@hukube/engine-client/react";
import { WorkspaceContext } from "../workspace/workspace-context.tsx";
import { DeleteDialog } from "./delete-dialog.tsx";
const workspace = {
  cluster: "c",
  active: true,
  types: new Map(),
  openList: () => {},
  openResource: () => {},
};
const object = { metadata: { name: "web", uid: "u" } };
afterEach(cleanup);
function setup(type = "configmaps", answer?: unknown, related?: Related) {
  let result = answer;
  let connection: ConnectionState = "open";
  const listeners = new Set<() => void>();
  const requests = vi.fn<(method: string, params: unknown, options?: unknown) => Promise<unknown>>(
    () => {
      if (result instanceof EngineRequestError && result.code === "disconnected")
        connection = "reconnecting";
      return result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
    },
  );
  const subscribe = vi.fn<EngineClient["subscribe"]>((_method, _params, listener) => {
    listener.data({ total: 42, rows: [] });
    return { update: () => {}, close: () => {} };
  });
  const client = {
    request: requests,
    subscribe,
    getState: () => connection,
    onStateChange: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  } as unknown as EngineClient;
  const closed = vi.fn<() => void>();
  const view = render(
    <EngineProvider client={client}>
      <WorkspaceContext value={workspace}>
        <DeleteDialog
          open
          onClose={closed}
          address={{ cluster: "c", type, namespace: "ns", name: "web" }}
          kind={type === "namespaces" ? "Namespace" : "ConfigMap"}
          object={object}
          related={related}
        />
      </WorkspaceContext>
    </EngineProvider>,
  );
  return {
    replace: () =>
      view.rerender(
        <EngineProvider client={client}>
          <WorkspaceContext value={workspace}>
            <DeleteDialog
              open
              onClose={closed}
              address={{ cluster: "c", type, namespace: "ns", name: "web" }}
              kind="ConfigMap"
              object={{ metadata: { uid: "replacement" } }}
              related={related}
            />
          </WorkspaceContext>
        </EngineProvider>,
      ),
    requests,
    closed,
    subscribe,
    setAnswer: (value: unknown) => {
      result = value;
    },
    reconnect: () =>
      act(() => {
        connection = "open";
        for (const listener of listeners) listener();
      }),
  };
}
it("deletes the named incarnation with background propagation, without cancellation", async () => {
  const h = setup();
  await waitFor(() => expect(document.activeElement?.textContent).toBe("Cancel"));
  fireEvent.click(screen.getByRole("button", { name: "Delete" }));
  await waitFor(() => expect(h.closed).toHaveBeenCalledOnce());
  expect(h.requests).toHaveBeenCalledWith("resource.delete", {
    cluster: "c",
    type: "configmaps",
    namespace: "ns",
    name: "web",
    uid: "u",
    propagation: "background",
    immediate: false,
  });
});
it("confirms a Namespace by name and counts all matches with a small query window", async () => {
  const h = setup("namespaces");
  expect(
    await screen.findByText("This deletes every Resource in the Namespace: at least 42 Resources."),
  ).toBeDefined();
  expect(h.subscribe).toHaveBeenCalledWith(
    "resources.query",
    expect.objectContaining({ where: { op: "in", field: "namespace", values: ["web"] }, limit: 1 }),
    expect.anything(),
  );
  const button = screen.getByRole("button", { name: "Delete" });
  expect(button.hasAttribute("disabled")).toBe(true);
  fireEvent.change(screen.getByRole("textbox", { name: "Type the name to confirm" }), {
    target: { value: "web" },
  });
  fireEvent.click(button);
  await waitFor(() => expect(h.closed).toHaveBeenCalledOnce());
});
it("repeats exactly the same delete after reconnect", async () => {
  const h = setup("pods", new EngineRequestError({ code: "disconnected", message: "lost" }));
  fireEvent.click(screen.getByRole("checkbox", { name: "Delete immediately" }));
  expect(screen.getByText(/containers may keep running/)).toBeDefined();
  fireEvent.click(screen.getByRole("button", { name: "Delete" }));
  await screen.findByText(/Lost the connection to the Engine while deleting/);
  expect(h.closed).not.toHaveBeenCalled();
  h.setAnswer(undefined);
  h.reconnect();
  await waitFor(() => expect(h.closed).toHaveBeenCalledOnce());
  expect(h.requests.mock.calls).toHaveLength(2);
  expect(h.requests.mock.calls[1]).toEqual(h.requests.mock.calls[0]);
  expect(h.requests.mock.calls[0]?.[1]).toMatchObject({ immediate: true });
});
it.each(["forbidden", "conflict", "unavailable"] as const)("reports delete %s", async (code) => {
  const h = setup("configmaps", new EngineRequestError({ code, message: "API answer" }));
  fireEvent.click(screen.getByRole("button", { name: "Delete" }));
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain(
    code === "forbidden"
      ? "Not permitted"
      : code === "conflict"
        ? "Nothing was deleted."
        : "API answer",
  );
  expect(h.closed).not.toHaveBeenCalled();
});
it("keeps a delete dialog open while a write is in flight", async () => {
  let finish: (() => void) | undefined;
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const h = setup("configmaps", pending);
  fireEvent.click(screen.getByRole("button", { name: "Delete" }));
  await screen.findByText("Deleting…");
  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  expect(h.closed).not.toHaveBeenCalled();
  await act(async () => finish?.());
  expect(h.closed).toHaveBeenCalledOnce();
});

it("keeps the confirmation's original UID when a same-named Resource replaces it", async () => {
  const h = setup();
  h.replace();
  fireEvent.click(screen.getByRole("button", { name: "Delete" }));
  await waitFor(() => expect(h.requests).toHaveBeenCalledOnce());
  expect(h.requests.mock.calls[0]?.[1]).toMatchObject({ uid: "u" });
});
