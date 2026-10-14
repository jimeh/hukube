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
  openExecSession: () => {},
  openList: () => {},
  openResource: () => {},
};
const object = { metadata: { name: "web", uid: "u" } };
afterEach(() => {
  cleanup();
  workspace.types.clear();
});
function setup(
  type = "configmaps",
  answer?: unknown,
  related?: Related,
  manifest: Record<string, unknown> = object,
  countTotal = 42,
) {
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
    listener.data({ total: countTotal, rows: [] });
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
          object={manifest}
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
    setConnection: (value: ConnectionState) =>
      act(() => {
        connection = value;
        for (const listener of listeners) listener();
      }),
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
        : "The delete may or may not have happened.",
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

it("disables Delete while reconnecting and reports an unsent delete", async () => {
  const h = setup(
    "configmaps",
    new EngineRequestError({ code: "not_connected", message: "closed" }),
  );
  h.setConnection("reconnecting");
  const button = screen.getByRole("button", { name: "Delete" });
  expect(button.hasAttribute("disabled")).toBe(true);
  expect(screen.getByText("Reconnecting to the Engine…")).toBeDefined();
  fireEvent.click(button);
  expect(h.requests).not.toHaveBeenCalled();
  h.reconnect();
  fireEvent.click(button);
  expect(
    await screen.findByText("Not connected to the Engine. Nothing was deleted."),
  ).toBeDefined();
  h.setAnswer(undefined);
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  await waitFor(() => expect(h.closed).toHaveBeenCalledOnce());
});
it.each(["button", "Escape"])("drops a pending delete on %s, before reconnect", async (dismiss) => {
  const h = setup("pods", new EngineRequestError({ code: "disconnected", message: "lost" }));
  fireEvent.click(screen.getByRole("button", { name: "Delete" }));
  await screen.findByText(/The delete may or may not have reached the Cluster/);
  const close = screen.getByRole("button", { name: "Stop and close" });
  if (dismiss === "button") fireEvent.click(close);
  else fireEvent.keyDown(close, { key: "Escape" });
  expect(h.closed).toHaveBeenCalledOnce();
  h.reconnect();
  await act(async () => {});
  expect(h.requests).toHaveBeenCalledOnce();
});
it("keeps a delete's outcome unknown after the Cluster did not answer", async () => {
  const h = setup("pods", new EngineRequestError({ code: "unavailable", message: "EOF" }));
  fireEvent.click(screen.getByRole("button", { name: "Delete" }));
  await screen.findByText("The Cluster did not answer. The delete may or may not have happened.");
  // The first delete may have landed and a controller made a new Resource of the same name.
  h.setAnswer(new EngineRequestError({ code: "conflict", message: "replaced" }));
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(
    await screen.findByText(
      "The answer to an earlier attempt was lost. The Resource may have been deleted and then replaced by a new one of the same name.",
    ),
  ).toBeDefined();
  expect(screen.queryByText(/Nothing was deleted/)).toBeNull();
  expect(h.requests).toHaveBeenCalledTimes(2);
});
it.each([false, true])("explains finalizers (terminating: %s)", (terminating) => {
  setup("configmaps", undefined, undefined, {
    metadata: {
      ...object.metadata,
      finalizers: ["a", "b"],
      ...(terminating ? { deletionTimestamp: "now" } : {}),
    },
  });
  expect(
    screen.getByText(
      terminating
        ? "It is already terminating and waits for finalizers: a, b. Removing them from metadata.finalizers in the YAML Facet releases it."
        : "It has finalizers (a, b), so it stays terminating until they are removed.",
    ),
  ).toBeDefined();
});
it("uses singular Resource counts for an owned Resource and a CRD", () => {
  workspace.types.set("web", { kind: "Widget", count: 1, state: "ready" });
  setup("customresourcedefinitions.apiextensions.k8s.io", undefined, {
    sections: [
      {
        relationship: "owns",
        direction: "out",
        total: 1,
        rows: [{ kind: "Pod", status: "found" }],
        truncated: false,
      },
    ],
  } as Related);
  expect(screen.getByText("This deletes every Widget in the Cluster: 1 Resource.")).toBeDefined();
  expect(screen.getByText("It owns 1 Resource: Pod (1).")).toBeDefined();
  workspace.types.clear();
});

it("uses the singular Resource for a Namespace count of one", async () => {
  setup("namespaces", undefined, undefined, object, 1);
  expect(
    await screen.findByText("This deletes every Resource in the Namespace: at least 1 Resource."),
  ).toBeDefined();
});

it("counts owned kinds without guessing the plural of a Cluster-supplied name", () => {
  setup("configmaps", undefined, {
    sections: [
      {
        relationship: "owns",
        direction: "out",
        total: 2,
        rows: [
          { kind: "Policy", status: "found" },
          { kind: "Policy", status: "found" },
        ],
        truncated: false,
      },
    ],
  } as Related);
  expect(screen.getByText("It owns 2 Resources: Policy (2).")).toBeDefined();
});

it.each(["conflict", "forbidden", "invalid", "not_found"] as const)(
  "keeps a lost delete outcome unknown when the repeat answers %s",
  async (code) => {
    const h = setup(
      "configmaps",
      new EngineRequestError({ code: "disconnected", message: "lost" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await screen.findByText(/Lost the connection to the Engine while deleting/);
    h.setAnswer(new EngineRequestError({ code, message: "API answer" }));
    h.reconnect();
    const alert = await screen.findByRole("alert");
    await waitFor(() =>
      expect(alert.textContent).toContain(
        code === "conflict"
          ? "The answer to an earlier attempt was lost. The Resource may have been deleted and then replaced by a new one of the same name."
          : "The answer to an earlier attempt was lost, so the delete may already have happened.",
      ),
    );
    expect(alert.textContent).not.toContain("Nothing was deleted");
    expect(h.requests).toHaveBeenCalledTimes(2);
  },
);

it.each(["missing", "syncing", "forbidden", "failed"])(
  "does not state a CRD count when its type is %s",
  (state) => {
    if (state !== "missing") workspace.types.set("web", { kind: "Widget", count: 0, state });
    setup("customresourcedefinitions.apiextensions.k8s.io");
    expect(
      screen.getByText(
        `This deletes every ${state === "missing" ? "Resource of this type" : "Widget"} in the Cluster. The number of Resources is not known.`,
      ),
    ).toBeDefined();
    expect(screen.queryByText(/0 Resources/)).toBeNull();
  },
);
