// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { EngineProvider } from "@hukube/engine-client/react";
import { type EngineClient, type EditReview, type ResourceData } from "@hukube/engine-client";
import { usePanelEdit } from "./use-panel-edit.ts";
import { useUnsavedEdits } from "./unsaved-edits.ts";
import { bundledDefinitions } from "../overview/bundled.ts";
import { parseManifest } from "./yaml.ts";
const live = {
  apiVersion: "apps/v1",
  kind: "Deployment",
  metadata: { name: "web", uid: "u", resourceVersion: "1" },
  spec: { replicas: 1 },
};
const definition = bundledDefinitions.get("deployments.apps")!;
const path = ["spec", "replicas"];
const control = { type: "integer" as const, min: 0 };
afterEach(() => {
  cleanup();
  useUnsavedEdits.setState({ entries: new Map(), guard: undefined });
});
function setup() {
  let resolveApply: ((result: unknown) => void) | undefined;
  const request = vi.fn<(method: string, params: unknown) => Promise<unknown>>(
    async (method, params) => {
      if (method === "resource.review") {
        const edit = params as { base: Record<string, unknown>; manifest: Record<string, unknown> };
        return {
          before: edit.base,
          desired: edit.manifest,
          after: edit.manifest,
          edited: [path],
          changedOnCluster: [],
          overlaps: [],
          setByCluster: [],
          ignored: [],
          warnings: [],
        } satisfies EditReview;
      }
      return new Promise((resolve) => {
        resolveApply = resolve;
      });
    },
  );
  const client = {
    request,
    getState: () => "open",
    onStateChange: () => () => {},
  } as unknown as EngineClient;
  const onEdit = vi.fn<() => void>();
  const initial = {
    address: { cluster: "c", type: "deployments.apps", namespace: "ns", name: "web" },
    kind: "Deployment",
    manifest: { stale: false, data: { object: live } as ResourceData },
    panelId: "panel",
    onEdit,
  };
  const hook = renderHook((props) => usePanelEdit(props), {
    initialProps: initial,
    wrapper: ({ children }: { children: ReactNode }) => (
      <EngineProvider client={client}>{children}</EngineProvider>
    ),
  });
  return {
    ...hook,
    initial,
    onEdit,
    request,
    resolveApply: (value: unknown) => {
      if (!resolveApply) throw new Error("Apply has not started");
      resolveApply(value);
    },
  };
}
it("keeps form-origin raw text, freezes live following, and uses one unsaved registration", async () => {
  const h = setup();
  await act(async () => {
    h.result.current.beginField(path, "Replicas", control, definition);
  });
  await act(async () => h.result.current.input("2."));
  expect(h.result.current.field?.raw).toBe("2.");
  expect(parseManifest(h.result.current.session!.text).object?.["spec"]).toEqual({ replicas: 2 });
  expect(h.onEdit).toHaveBeenCalledOnce();
  expect(useUnsavedEdits.getState().entries.size).toBe(1);
  await act(async () => h.result.current.input("-"));
  expect(h.result.current.reviewReason).toContain("Replicas");
  expect(h.result.current.field?.raw).toBe("-");
  h.rerender({
    ...h.initial,
    manifest: { stale: false, data: { object: { ...live, spec: { replicas: 5 } } } },
  });
  expect(h.result.current.field?.raw).toBe("-");
  expect(h.result.current.session?.text).toContain("replicas: 2");
  await act(async () => h.result.current.reviewChanges());
  expect(h.request).not.toHaveBeenCalled();
  await act(async () => h.result.current.finishField(true));
  expect(h.result.current.dirty).toBe(false);
  expect(useUnsavedEdits.getState().entries.size).toBe(0);
});
it("YAML changes replace pending form input only if its own draft value changes", async () => {
  const h = setup();
  await act(async () => h.result.current.beginField(path, "Replicas", control, definition));
  await act(async () => h.result.current.input("2."));
  await act(async () =>
    h.result.current.changeText(h.result.current.session!.text + "# comment\n"),
  );
  expect(h.result.current.field?.raw).toBe("2.");
  await act(async () =>
    h.result.current.changeText(
      h.result.current.session!.text.replace("replicas: 2", "replicas: 3"),
    ),
  );
  expect(h.result.current.field).toBeUndefined();
  expect(h.result.current.parsed?.object?.["spec"]).toEqual({ replicas: 3 });
});
it("pending untouched text counts as unsaved and pins the definition; cancellation clears both", async () => {
  const h = setup();
  await act(async () => h.result.current.beginField(path, "Replicas", control, definition));
  expect(h.result.current.dirty).toBe(true);
  expect(h.result.current.definition).toBe(definition);
  expect(useUnsavedEdits.getState().entries.size).toBe(1);
  await act(async () => h.result.current.cancel());
  const guard = useUnsavedEdits.getState().guard;
  expect(guard).toBeDefined();
  await act(async () => guard!.proceed());
  expect(h.result.current.session).toBeUndefined();
  expect(h.result.current.field).toBeUndefined();
  expect(useUnsavedEdits.getState().entries.size).toBe(0);
});
it("late apply success cannot clear newer invalid input even when submitted draft text is unchanged", async () => {
  const h = setup();
  await act(async () => h.result.current.beginField(path, "Replicas", control, definition));
  await act(async () => h.result.current.input("2"));
  await act(async () => h.result.current.reviewChanges());
  await waitFor(() => expect(h.result.current.review.state?.phase).toBe("ready"));
  await act(async () => h.result.current.review.apply());
  await waitFor(() => expect(h.request).toHaveBeenCalledWith("resource.apply", expect.anything()));
  await act(async () => h.result.current.beginField(path, "Replicas", control, definition));
  await act(async () => h.result.current.input("-"));
  h.rerender({
    ...h.initial,
    manifest: {
      stale: false,
      data: {
        object: {
          ...live,
          metadata: { ...live.metadata, resourceVersion: "2" },
          spec: { replicas: 2 },
        },
      },
    },
  });
  await act(async () => h.resolveApply({ resourceVersion: "2", unchanged: false }));
  await waitFor(() => expect(h.result.current.applied).toBe(true));
  expect(h.result.current.field?.raw).toBe("-");
  expect(h.result.current.session).toBeDefined();
  expect(useUnsavedEdits.getState().entries.size).toBe(1);
});
it("review flushes valid pending input and a matching apply clears the edit", async () => {
  const h = setup();
  await act(async () => h.result.current.beginField(path, "Replicas", control, definition));
  await act(async () => h.result.current.input("2"));
  await act(async () => h.result.current.reviewChanges());
  expect(h.result.current.field).toBeUndefined();
  await waitFor(() => expect(h.result.current.review.state?.phase).toBe("ready"));
  await act(async () => h.result.current.review.apply());
  h.rerender({
    ...h.initial,
    manifest: {
      stale: false,
      data: {
        object: {
          ...live,
          metadata: { ...live.metadata, resourceVersion: "2" },
          spec: { replicas: 2 },
        },
      },
    },
  });
  await act(async () => h.resolveApply({ resourceVersion: "2", unchanged: false }));
  await waitFor(() => expect(h.result.current.session).toBeUndefined());
  expect(useUnsavedEdits.getState().entries.size).toBe(0);
});
it("refuses inline starts when access or connection prevents editing", async () => {
  const h = setup();
  h.rerender({
    ...h.initial,
    editAccess: { allowed: false, reason: "Read-only" },
  } as typeof h.initial);
  await act(async () => h.result.current.beginField(path, "Replicas", control, definition));
  expect(h.result.current.session).toBeUndefined();
});

it("reverting another field preserves newer pending raw input and its unsaved guard", async () => {
  const h = setup();
  await act(async () =>
    h.result.current.setFieldValue(
      ["spec", "other"],
      "staged",
      { type: "string", remove: true },
      definition,
    ),
  );
  await act(async () => h.result.current.beginField(path, "Replicas", control, definition));
  await act(async () => h.result.current.input("-"));
  await act(async () =>
    h.result.current.setFieldValue(
      ["spec", "other"],
      undefined,
      { type: "string", remove: true },
      definition,
    ),
  );
  expect(h.result.current.field?.raw).toBe("-");
  expect(h.result.current.reviewReason).toContain("Replicas");
  expect(useUnsavedEdits.getState().entries.size).toBe(1);
});
