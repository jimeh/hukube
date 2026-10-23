// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState, useSyncExternalStore } from "react";
import type { DockviewPanelApi } from "dockview-react";
import type { ResourceData } from "@hukube/engine-client";
import { formatResourceUri, type Facet } from "@hukube/k8s";
import { ResourcePanel } from "../resource/resource-panel.tsx";
import { WorkspaceContext } from "../workspace/workspace-context.tsx";
import { useUnsavedEdits } from "../edit/unsaved-edits.ts";
import { bundledDefinitions } from "./bundled.ts";
import { parseDefinition } from "./definition.ts";
import { createRegistryStore, type RegistrySnapshot } from "./registry.ts";
import type * as RegistryModule from "./registry.ts";
import type { EngineClient, Setting } from "@hukube/engine-client";
const state = vi.hoisted(() => ({
  manifest: { object: {} } as ResourceData,
  snapshot: {} as RegistrySnapshot,
  error: undefined as string | undefined,
  store: undefined as ReturnType<typeof createRegistryStore> | undefined,
  client: {
    subscribe: () => ({ close: () => {}, update: () => {} }),
    request: () => Promise.resolve({ edit: { allowed: true }, delete: { allowed: true } }),
    getState: () => "open",
    onStateChange: () => () => {},
  },
}));
vi.mock("@hukube/engine-client/react", () => ({
  useEngine: () => state.client,
  useConnectionState: () => "open",
  useSubscription: (method: string) =>
    method === "resource.get"
      ? {
          stale: false,
          data: state.manifest,
          error: state.error ? { code: "unavailable", message: state.error } : undefined,
        }
      : { stale: false },
}));
vi.mock("./registry.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof RegistryModule>()),
  useRegistry: () => ({
    snapshot: useSyncExternalStore(
      state.store?.subscribe ?? (() => () => {}),
      state.store?.getSnapshot ?? (() => state.snapshot),
    ),
    store: state.store ?? { retry: () => {} },
  }),
}));
vi.mock("../resource/yaml-editor.tsx", () => ({
  default: ({
    value,
    onChange,
    editing,
  }: {
    value: string;
    onChange: (text: string) => void;
    editing: boolean;
  }) => (
    <textarea
      aria-label="YAML draft"
      value={value}
      readOnly={!editing}
      onChange={(event) => onChange(event.target.value)}
    />
  ),
}));
vi.mock("../resource/events-facet.tsx", () => ({
  EventsFacet: () => <div>Live Events</div>,
  EventsBadge: () => null,
  eventsTabName: () => "Events",
}));
vi.mock("../resource/related-facet.tsx", () => ({
  RelatedFacet: () => <div>Related Resources</div>,
  RelatedBadge: () => null,
  relatedTabName: () => "Related",
}));
vi.mock("../resource/logs-facet.tsx", () => ({ LogsFacet: () => <div>Logs</div> }));
const deployment = {
  apiVersion: "apps/v1",
  kind: "Deployment",
  metadata: { name: "web", uid: "u" },
  spec: { replicas: 1, template: { spec: { containers: [{ name: "app", image: "old" }] } } },
};
beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  state.manifest = { object: deployment };
  state.error = undefined;
  state.store = undefined;
  state.snapshot = {
    status: "ready",
    definitions: new Map(bundledDefinitions),
    errors: new Map(),
    registry: { version: 1, entries: {} },
    revision: "",
  };
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  useUnsavedEdits.setState({ entries: new Map(), guard: undefined });
});
function Harness({ type = "deployments.apps", facet }: { type?: string; facet?: Facet }) {
  const [params, setParams] = useState({
    uri: formatResourceUri({ cluster: "c", type, namespace: "ns", name: "web", facet }),
    preview: true,
  });
  const api = {
    id: "panel",
    isVisible: true,
    updateParameters: setParams,
  } as unknown as DockviewPanelApi;
  return (
    <WorkspaceContext
      value={{
        cluster: "c",
        active: true,
        types: new Map(),
        openList: () => {},
        openResource: () => {},
        openExecSession: () => {},
      }}
    >
      <ResourcePanel api={api} params={params} />
      <output aria-label="Tab params">{JSON.stringify(params)}</output>
    </WorkspaceContext>
  );
}
it("shares typed edits, invalid pending input, YAML changes and unsaved state across every Facet", async () => {
  render(<Harness />);
  expect(screen.getByRole("tab", { name: /^Overview/ }).getAttribute("aria-selected")).toBe("true");
  fireEvent.click(screen.getByRole("button", { name: "Edit Replicas" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Replicas" }), { target: { value: "2." } });
  expect(screen.getByLabelText("Tab params").textContent).toContain('"preview":false');
  fireEvent.change(screen.getByRole("textbox", { name: "Replicas" }), { target: { value: "-" } });
  fireEvent.click(screen.getByRole("tab", { name: /^YAML/ }));
  const yaml = await screen.findByRole<HTMLTextAreaElement>("textbox", { name: "YAML draft" });
  expect(yaml.value).toContain("replicas: 2");
  expect(screen.getByRole("button", { name: "Review changes" }).getAttribute("aria-disabled")).toBe(
    "true",
  );
  expect(useUnsavedEdits.getState().entries.size).toBe(1);
  fireEvent.change(yaml, { target: { value: yaml.value.replace("replicas: 2", "replicas: 4") } });
  fireEvent.click(screen.getByRole("tab", { name: /^Overview/ }));
  expect(screen.getByRole("button", { name: "Edit Replicas" }).textContent).toBe("4");
  fireEvent.click(screen.getByRole("tab", { name: "Events" }));
  expect(screen.getByText("Unsaved changes")).toBeDefined();
  expect(screen.getByRole("button", { name: "Review changes" })).toBeDefined();
  fireEvent.click(screen.getByRole("tab", { name: "Related" }));
  expect(screen.getByText("Unsaved changes")).toBeDefined();
});
it("invalid YAML remains intact, blocks Overview review, and is repairable in YAML", async () => {
  render(<Harness facet="yaml" />);
  fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
  const yaml = await screen.findByRole<HTMLTextAreaElement>("textbox", { name: "YAML draft" });
  fireEvent.change(yaml, { target: { value: "spec: [" } });
  fireEvent.click(screen.getByRole("tab", { name: /^Overview/ }));
  expect(
    screen.getAllByText(/Fix invalid YAML in the YAML Facet before editing inline/)[0],
  ).toBeDefined();
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "Review changes" }).disabled).toBe(
    true,
  );
  fireEvent.click(screen.getByRole("button", { name: "Open YAML" }));
  expect(
    (await screen.findByRole<HTMLTextAreaElement>("textbox", { name: "YAML draft" })).value,
  ).toBe("spec: [");
});
it("pins removed definitions while pending input exists and adopts removal only after discard", () => {
  const view = render(<Harness />);
  fireEvent.click(screen.getByRole("button", { name: "Edit Replicas" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Replicas" }), { target: { value: "-" } });
  state.snapshot = { ...state.snapshot, definitions: new Map() };
  view.rerender(<Harness />);
  expect(screen.getByText(/definition changed/)).toBeDefined();
  expect(screen.getByRole<HTMLInputElement>("textbox", { name: "Replicas" }).value).toBe("-");
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  act(() => useUnsavedEdits.getState().guard!.proceed());
  expect(screen.queryByRole("tab", { name: /^Overview/ })).toBeNull();
});
it("keeps a YAML-origin default session on YAML when a definition arrives; clean default then adopts Overview", async () => {
  state.snapshot = { ...state.snapshot, definitions: new Map() };
  const view = render(<Harness />);
  fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
  state.snapshot = { ...state.snapshot, definitions: new Map(bundledDefinitions) };
  view.rerender(<Harness />);
  expect(screen.getByRole("tab", { name: /^YAML/ }).getAttribute("aria-selected")).toBe("true");
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.getByRole("tab", { name: /^Overview/ }).getAttribute("aria-selected")).toBe("true");
});
it("waits for an undecidable version, preserves explicit YAML, and reveals core Secrets only explicitly", () => {
  state.manifest = { object: { metadata: { uid: "u" } } };
  const view = render(<Harness />);
  expect(screen.getByText("Loading Overview")).toBeDefined();
  view.unmount();
  state.manifest = {
    object: {
      apiVersion: "v1",
      kind: "Secret",
      metadata: { uid: "u" },
      data: { password: btoa("sensitive-value"), binary: "/w==" },
    },
  };
  render(<Harness type="secrets" />);
  expect(screen.queryByText("sensitive-value")).toBeNull();
  expect(screen.queryByRole("button", { name: "Edit password" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Reveal password" }));
  expect(screen.getByText("sensitive-value")).toBeDefined();
  expect(screen.getByRole("button", { name: "Hide password" }).textContent).not.toContain(
    "sensitive-value",
  );
  fireEvent.click(screen.getByRole("button", { name: "Reveal binary" }));
  expect(screen.getByText("Binary value")).toBeDefined();
});

it("a pointer Cancel field restores the opening value and a per-field revert cleans the shared draft", () => {
  render(<Harness />);
  fireEvent.click(screen.getByRole("button", { name: "Edit Replicas" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Replicas" }), { target: { value: "2" } });
  const cancel = screen.getByRole("button", { name: "Cancel field" });
  fireEvent.blur(screen.getByRole("textbox", { name: "Replicas" }), { relatedTarget: cancel });
  fireEvent.click(cancel);
  expect(screen.getByRole("button", { name: "Edit Replicas" }).textContent).toBe("1");
  expect(useUnsavedEdits.getState().entries.size).toBe(0);
  fireEvent.click(screen.getByRole("button", { name: "Edit Replicas" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Replicas" }), { target: { value: "2" } });
  fireEvent.keyDown(screen.getByRole("textbox", { name: "Replicas" }), { key: "Enter" });
  fireEvent.click(screen.getByRole("button", { name: "Revert Replicas" }));
  expect(useUnsavedEdits.getState().entries.size).toBe(0);
});

it("adds unique literal string-map keys and reflects them in YAML", async () => {
  state.manifest = {
    object: {
      apiVersion: "v1",
      kind: "ConfigMap",
      metadata: { uid: "u" },
      data: { greeting: "hello" },
    },
  };
  render(<Harness type="configmaps" />);
  fireEvent.click(screen.getByRole("button", { name: "Add data key" }));
  const key = screen.getByRole("textbox", { name: "New data key" });
  fireEvent.change(key, { target: { value: "greeting" } });
  expect(screen.getByText("This key already exists.")).toBeDefined();
  fireEvent.change(key, { target: { value: "example.dev/key.with.dot" } });
  fireEvent.click(screen.getByRole("button", { name: "Add key" }));
  const input = screen.getByRole("textbox", { name: "example.dev/key.with.dot" });
  fireEvent.change(input, { target: { value: "yes" } });
  fireEvent.click(screen.getByRole("button", { name: "Done" }));
  fireEvent.click(screen.getByRole("tab", { name: /^YAML/ }));
  expect(
    (await screen.findByRole<HTMLTextAreaElement>("textbox", { name: "YAML draft" })).value,
  ).toContain('example.dev/key.with.dot: "yes"');
});

it("keeps Resource unsaved state on Logs after a nested container image edit", () => {
  state.manifest = {
    object: {
      apiVersion: "v1",
      kind: "Pod",
      metadata: { uid: "u" },
      spec: { containers: [{ name: "app", image: "old" }] },
    },
  };
  render(<Harness type="pods" />);
  fireEvent.click(screen.getByRole("button", { name: "Edit Containers 1 Image" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Containers 1 Image" }), {
    target: { value: "new" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Done" }));
  fireEvent.click(screen.getByRole("tab", { name: "Logs" }));
  expect(screen.getByText("Unsaved changes")).toBeDefined();
  expect(screen.getByRole("button", { name: "Review changes" })).toBeDefined();
  expect(screen.getByRole("tab", { name: "Logs" }).textContent).not.toContain("Unsaved");
});

it("preserves multiline map values in a multiline control and shared YAML", async () => {
  state.manifest = {
    object: {
      apiVersion: "v1",
      kind: "ConfigMap",
      metadata: { uid: "u" },
      data: { config: "first\nsecond\n" },
    },
  };
  render(<Harness type="configmaps" />);
  fireEvent.click(screen.getByRole("button", { name: "Edit config" }));
  const input = screen.getByRole<HTMLTextAreaElement>("textbox", { name: "config" });
  expect(input.tagName).toBe("TEXTAREA");
  expect(input.value).toBe("first\nsecond\n");
  fireEvent.change(input, { target: { value: "first\nthird\n" } });
  fireEvent.click(screen.getByRole("button", { name: "Done" }));
  fireEvent.click(screen.getByRole("tab", { name: /^YAML/ }));
  expect(
    (await screen.findByRole<HTMLTextAreaElement>("textbox", { name: "YAML draft" })).value,
  ).toContain("    first\n    third\n");
});

it.each(["boolean", "enum"] as const)(
  "an unset %s control requires an explicit choice before showing a selected value",
  async (type) => {
    state.manifest = {
      object: { apiVersion: "v1", kind: "ConfigMap", metadata: { name: "web", uid: "u" } },
    };
    const definition = parseDefinition(`version: 1
resourceType: configmaps
apiVersions: [v1]
title: ConfigMap
sections:
  - id: configuration
    title: Configuration
    fields:
      - id: choice
        type: field
        label: Choice
        path: ${type === "boolean" ? "[immutable]" : "[metadata, annotations, example.dev/mode]"}
        format: ${type === "boolean" ? "boolean" : "text"}
        edit:
          type: ${type}
${type === "enum" ? '          choices: [first, second, ""]\n' : ""}`);
    state.snapshot = { ...state.snapshot, definitions: new Map([["configmaps", definition]]) };
    render(<Harness type="configmaps" />);
    fireEvent.click(screen.getByRole("button", { name: "Edit Choice" }));
    const choice = screen.getByRole<HTMLSelectElement>("combobox", { name: "Choice" });
    expect(choice.value).toBe("");
    expect(choice.selectedOptions[0]?.textContent).toBe("Choose a value");
    fireEvent.keyDown(choice, { key: "Enter" });
    expect(screen.getByRole("combobox", { name: "Choice" })).toBe(choice);
    const value = type === "boolean" ? "true" : "first";
    const option = [...choice.options].find((item) => item.textContent === value)!;
    fireEvent.change(choice, { target: { value: option.value } });
    expect(choice.selectedOptions[0]?.textContent).toBe(value);
    if (type === "enum") {
      const empty = [...choice.options].find((item) => item.textContent === "(empty string)")!;
      fireEvent.change(choice, { target: { value: empty.value } });
    }
    expect(choice.selectedOptions[0]?.textContent).toBe(type === "enum" ? "(empty string)" : value);
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(screen.getByRole("button", { name: "Edit Choice" }).textContent).toBe(
      type === "boolean" ? "true" : "",
    );
    fireEvent.click(screen.getByRole("tab", { name: /^YAML/ }));
    expect(
      (await screen.findByRole<HTMLTextAreaElement>("textbox", { name: "YAML draft" })).value,
    ).toContain(type === "boolean" ? "immutable: true" : 'example.dev/mode: ""');
  },
);

it("offers YAML for a changed read-only field rather than an inert revert action", async () => {
  render(<Harness facet="yaml" />);
  fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
  const yaml = await screen.findByRole<HTMLTextAreaElement>("textbox", { name: "YAML draft" });
  const changed = {
    ...deployment,
    metadata: { name: "web" },
    spec: {
      ...deployment.spec,
      template: { spec: { ...deployment.spec.template.spec, restartPolicy: "Never" } },
    },
  };
  fireEvent.change(yaml, { target: { value: JSON.stringify(changed) } });
  fireEvent.click(screen.getByRole("tab", { name: /^Overview/ }));
  expect(screen.getByText("Never")).toBeDefined();
  expect(screen.queryByRole("button", { name: "Revert Restart policy" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "View YAML" }));
  expect(screen.getByRole("tab", { name: /^YAML/ }).getAttribute("aria-selected")).toBe("true");
  expect(yaml.value).toBe(JSON.stringify(changed));
});

it("keeps a mounted Overview repairable when YAML becomes cyclic, including while hidden", async () => {
  render(<Harness />);
  fireEvent.click(screen.getByRole("button", { name: "Edit Replicas" }));
  fireEvent.click(screen.getByRole("button", { name: "Done" }));
  fireEvent.click(screen.getByRole("tab", { name: /^YAML/ }));
  const yaml = await screen.findByRole<HTMLTextAreaElement>("textbox", { name: "YAML draft" });
  const original = yaml.value;
  const cyclic = "apiVersion: apps/v1\nmetadata: {name: web}\nspec: &spec {replicas: *spec}\n";
  fireEvent.change(yaml, { target: { value: cyclic } });
  expect(yaml.value).toBe(cyclic);
  fireEvent.click(screen.getByRole("tab", { name: /^Overview/ }));
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "Review changes" }).disabled).toBe(
    true,
  );
  expect(
    screen.getByText(/Fix invalid YAML in the YAML Facet before editing inline/),
  ).toBeDefined();
  fireEvent.click(screen.getByRole("tab", { name: /^YAML/ }));
  fireEvent.change(yaml, { target: { value: original.replace("replicas: 1", "replicas: 3") } });
  fireEvent.click(screen.getByRole("tab", { name: /^Overview/ }));
  expect(screen.getByRole("button", { name: "Edit Replicas" }).textContent).toBe("3");
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "Review changes" }).disabled).toBe(
    false,
  );
});

it.each([
  [undefined, "deleted"],
  ["overview", "deleted"],
  [undefined, "error"],
  ["overview", "error"],
] as const)("releases unresolved Overview %s on a terminal Manifest %s", (facet, terminal) => {
  state.manifest = {};
  const view = render(<Harness facet={facet} />);
  expect(screen.getByText("Loading Overview")).toBeDefined();
  if (terminal === "deleted") state.manifest = { deleted: true };
  else state.error = "Manifest access denied";
  view.rerender(<Harness facet={facet} />);
  expect(screen.queryByText("Loading Overview")).toBeNull();
  expect(screen.getByRole("tab", { name: /^YAML/ })).toBeDefined();
  expect(screen.getByRole("tab", { name: /^Events/ })).toBeDefined();
  expect(
    screen.getAllByText(terminal === "deleted" ? "Not found" : "Manifest access denied").length,
  ).toBeGreaterThan(0);
});

it.each(["normal", "exact", "annotations", "metadata"])(
  "masks Secret last-applied through %s definitions without hiding safe annotations",
  (selection) => {
    const credential = "credential-from-last-applied";
    const annotation = "kubectl.kubernetes.io/last-applied-configuration";
    state.manifest = {
      object: {
        apiVersion: "v1",
        kind: "Secret",
        metadata: {
          uid: "u",
          annotations: {
            [annotation]: JSON.stringify({ stringData: { password: credential } }),
            note: "useful annotation",
          },
        },
      },
    };
    if (selection !== "normal") {
      const path =
        selection === "exact"
          ? `[metadata, annotations, ${annotation}]`
          : selection === "annotations"
            ? "[metadata, annotations]"
            : "[metadata]";
      state.snapshot = {
        ...state.snapshot,
        definitions: new Map([
          [
            "secrets",
            parseDefinition(
              `version: 1\nresourceType: secrets\ntitle: Secret\nsections:\n  - id: main\n    title: Main\n    fields:\n      - {id: selected, type: field, label: Selected, path: ${path}, format: text}\n`,
            ),
          ],
        ]),
      };
    }
    render(<Harness type="secrets" />);
    const overview = screen.getByRole("tabpanel", { name: /^Overview/ });
    expect(overview.textContent).not.toContain(credential);
    expect(overview.innerHTML).not.toContain(credential);
    expect(screen.queryByRole("button", { name: `Edit ${annotation}` })).toBeNull();
    const before = useUnsavedEdits.getState().entries.size;
    fireEvent.click(
      screen.getByRole("button", {
        name: selection === "normal" ? `Reveal ${annotation}` : "Reveal Selected",
      }),
    );
    expect(document.body.textContent).toContain(credential);
    expect(useUnsavedEdits.getState().entries.size).toBe(before);
  },
);

it("keeps the actual ResourcePanel YAML mounted during registry reload and refresh failure", async () => {
  state.manifest = { object: { apiVersion: "sample/v1", metadata: { uid: "u" } } };
  const watches: {
    data(setting: Setting): void;
    error(error: { code: string; message: string }): void;
  }[] = [];
  state.store = createRegistryStore({
    ...state.client,
    subscribe: (_method: string, _params: unknown, listener: (typeof watches)[number]) => {
      watches.push(listener);
      return { close: () => {}, update: () => {} };
    },
  } as unknown as EngineClient);
  render(<Harness type="custom.sample" />);
  expect(screen.getByText("Loading Overview")).toBeDefined();
  act(() => watches.at(-1)!.data({ key: "overview/definitions", value: null, revision: "" }));
  const yaml = await screen.findByRole("textbox", { name: "YAML draft" });
  fireEvent.click(screen.getByRole("button", { name: "Show managed fields" }));
  act(() => state.store!.retry());
  expect(screen.getByRole("textbox", { name: "YAML draft" })).toBe(yaml);
  expect(screen.getByRole("button", { name: "Hide managed fields" })).toBeDefined();
  act(() => watches.at(-1)!.error({ code: "unavailable", message: "refresh unavailable" }));
  expect(screen.getByText(/refresh unavailable/)).toBeDefined();
  expect(screen.getByRole("textbox", { name: "YAML draft" })).toBe(yaml);
});

it("keeps normal Secret annotations visible", () => {
  state.manifest = {
    object: {
      apiVersion: "v1",
      metadata: { uid: "u", annotations: { note: "useful annotation" } },
    },
  };
  render(<Harness type="secrets" />);
  expect(screen.getByText("useful annotation")).toBeDefined();
});
