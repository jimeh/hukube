// @vitest-environment jsdom
import {
  EngineRequestError,
  type EngineClient,
  type ConnectionState,
  type EditReview,
} from "@hukube/engine-client";
import { EngineProvider } from "@hukube/engine-client/react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useImperativeHandle, useRef, type Ref } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { YamlFacet } from "./yaml-facet.tsx";
import type { FacetProps } from "./facet-props.ts";
import type { YamlEditorHandle } from "./yaml-editor.tsx";
import { createBrowserHost } from "@hukube/host";
import { HostProvider } from "@/lib/host.tsx";
import { UnsavedGuard } from "../edit/unsaved-guard.tsx";
import { useUnsavedEdits } from "../edit/unsaved-edits.ts";

function MockEditor({
  value,
  onChange,
  ref,
}: {
  value: string;
  onChange: (text: string) => void;
  ref: Ref<YamlEditorHandle>;
}) {
  const input = useRef<HTMLTextAreaElement>(null);
  useImperativeHandle(ref, () => ({ focus: () => input.current?.focus(), search: () => {} }));
  return (
    <textarea
      ref={input}
      aria-label="Manifest"
      value={value}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}
vi.mock("./yaml-editor.tsx", () => ({ default: MockEditor }));
vi.mock("../edit/diff-editor.tsx", () => ({ default: () => <div>Diff</div> }));
vi.mock("../edit/clipboard.ts", () => ({
  copyText: vi.fn<() => Promise<void>>(() => Promise.resolve()),
}));
const live = {
  apiVersion: "v1",
  kind: "ConfigMap",
  metadata: { name: "web", uid: "u", resourceVersion: "1" },
  data: { greeting: "hello" },
};
const review: EditReview = {
  before: live,
  desired: { ...live, data: { greeting: "mine" } },
  after: live,
  edited: [["data", "greeting"]],
  changedOnCluster: [],
  overlaps: [],
  setByCluster: [],
  ignored: [],
  warnings: [],
};
afterEach(() => {
  cleanup();
  useUnsavedEdits.setState({ entries: new Map(), guard: undefined });
  vi.useRealTimers();
});
function setup() {
  let connection: ConnectionState = "open";
  let answer: unknown = new EngineRequestError({ code: "disconnected", message: "lost" });
  let checked: EditReview = review;
  const listeners = new Set<() => void>();
  const request = vi.fn<(method: string, params: unknown) => Promise<unknown>>((method) => {
    if (method === "resource.review") return Promise.resolve(checked);
    if (answer instanceof EngineRequestError && answer.code === "disconnected") {
      connection = "reconnecting";
      for (const listener of listeners) listener();
    }
    return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
  });
  const client = {
    request,
    getState: () => connection,
    onStateChange: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  } as unknown as EngineClient;
  const controls = document.createElement("div");
  document.body.append(controls);
  const props: FacetProps = {
    address: { cluster: "c", type: "configmaps", namespace: "ns", name: "web" },
    kind: "ConfigMap",
    manifest: { data: { object: live }, stale: false },
    lastObject: live,
    showing: true,
    visible: true,
    controls,
    panelId: "p",
    events: { stale: false },
    related: { stale: false },
  };
  const view = render(
    <EngineProvider client={client}>
      <YamlFacet {...props} />
      <HostProvider host={createBrowserHost()}>
        <UnsavedGuard />
      </HostProvider>
    </EngineProvider>,
  );
  const rerender = () =>
    view.rerender(
      <EngineProvider client={client}>
        <YamlFacet {...props} />
        <HostProvider host={createBrowserHost()}>
          <UnsavedGuard />
        </HostProvider>
      </EngineProvider>,
    );
  return {
    request,
    controls,
    props,
    rerender,
    unmount: () => {
      view.unmount();
      controls.remove();
    },
    setReview: (value: EditReview) => {
      checked = value;
    },
    setApply: (value: unknown) => {
      answer = value;
    },
    reconnect: () =>
      act(() => {
        connection = "open";
        for (const listener of listeners) listener();
      }),
  };
}
async function editText() {
  fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
  const input = await screen.findByRole("textbox", { name: "Manifest" });
  fireEvent.change(input, {
    target: { value: (input as HTMLTextAreaElement).value.replace("hello", "mine") },
  });
}
async function pendingApply() {
  await editText();
  fireEvent.click(screen.getByRole("button", { name: "Review changes" }));
  fireEvent.click(await screen.findByRole("button", { name: "Apply" }));
  await screen.findByText(/Lost the connection to the Engine while applying/);
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
}
it("shows a pending apply and drops it when the edit is discarded", async () => {
  const h = setup();
  await pendingApply();
  const notice = screen.getByText(/An apply of this edit was in flight/);
  expect(notice.closest("[data-notice]")?.getAttribute("data-notice")).toBe("warning");
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(
    screen.getByText(
      "An apply of these edits may already have reached the Cluster. Discarding stops hukube from checking the result.",
    ),
  ).toBeDefined();
  fireEvent.click(screen.getByRole("button", { name: "Discard edits" }));
  await waitFor(() =>
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Edit" })),
  );
  h.setApply({ resourceVersion: "2", warnings: [] });
  h.reconnect();
  await act(async () => {});
  expect(h.request.mock.calls.filter(([method]) => method === "resource.apply")).toHaveLength(1);
  h.unmount();
});
it("retains the pending apply when only its dialog closes and repeats its exact params", async () => {
  const h = setup();
  await pendingApply();
  h.setApply({ resourceVersion: "2", warnings: [] });
  h.reconnect();
  await waitFor(() =>
    expect(h.request.mock.calls.filter(([method]) => method === "resource.apply")).toHaveLength(2),
  );
  const writes = h.request.mock.calls.filter(([method]) => method === "resource.apply");
  expect(writes[1]).toEqual(writes[0]);
  h.props.manifest = {
    stale: false,
    data: { object: { ...live, metadata: { ...live.metadata, resourceVersion: "2" } } },
  };
  h.rerender();
  await waitFor(() =>
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Edit" })),
  );
  expect(screen.getByRole("status").textContent).toContain("Applied");
  expect(h.controls.textContent).not.toContain("Applied");
  h.unmount();
});
it("shows no refusal after a closed dialog's repeat conflicted and the next review is accepted", async () => {
  const h = setup();
  await pendingApply();
  h.setApply(new EngineRequestError({ code: "conflict", message: "The Resource changed" }));
  h.reconnect();
  await screen.findByText(/hukube could not confirm/);
  // The same text is reviewed again and accepted, so nothing is left to refuse.
  fireEvent.click(screen.getByRole("button", { name: "Review changes" }));
  await within(screen.getByRole("dialog")).findByText("The Cluster accepts this edit.");
  fireEvent.click(screen.getByRole("button", { name: "Back to editing" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(screen.queryByText("This edit cannot be applied")).toBeNull();
  expect(screen.queryByText(/The Resource changed/)).toBeNull();
  expect(document.querySelector("[data-notice]")?.getAttribute("data-notice")).toBe("neutral");
  h.unmount();
});
it("drops the pending apply when the Facet unmounts", async () => {
  const h = setup();
  await pendingApply();
  h.unmount();
  h.reconnect();
  await act(async () => {});
  expect(h.request.mock.calls.filter(([method]) => method === "resource.apply")).toHaveLength(1);
});
it.each(["conflict", "forbidden", "not_found"] as const)(
  "keeps a warning without a background review when a closed dialog's repeat answers %s",
  async (code) => {
    const h = setup();
    await pendingApply();
    h.setApply(new EngineRequestError({ code, message: "API answer" }));
    h.reconnect();
    const warning = await screen.findByText(
      "hukube could not confirm whether your apply went through. Review changes shows the Cluster as it is now.",
    );
    expect(warning.closest("[data-notice]")?.getAttribute("data-notice")).toBe("warning");
    expect(h.request.mock.calls.filter(([method]) => method === "resource.review")).toHaveLength(1);
    expect(screen.queryByRole("dialog")).toBeNull();
    h.props.manifest = { stale: false, data: { deleted: true } };
    h.rerender();
    expect(screen.getByText(/hukube could not confirm/)).toBeDefined();
    h.props.manifest = { stale: false, data: { object: live } };
    h.rerender();
    fireEvent.change(screen.getByRole("textbox", { name: "Manifest" }), {
      target: { value: "data:\n  greeting: next\n" },
    });
    expect(screen.getByText(/hukube could not confirm/)).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Review changes" }));
    await within(screen.getByRole("dialog")).findByText("The Cluster accepts this edit.");
    expect(screen.queryByText(/hukube could not confirm/)).toBeNull();
    h.unmount();
  },
);
it("keeps the review closed for a non-finite Manifest and focuses its issue", async () => {
  const h = setup();
  await editText();
  fireEvent.change(screen.getByRole("textbox", { name: "Manifest" }), {
    target: { value: "spec:\n  replicas: .inf\n" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Review changes" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(h.request).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Manifest" }));
  expect(screen.getByText(/A Manifest cannot hold this number/)).toBeDefined();
  h.unmount();
});
it("returns focus to Edit after a clean Cancel", async () => {
  const h = setup();
  fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Edit" }));
  h.unmount();
});
it("gives hints, Cluster changes, and refusals their three notice styles", async () => {
  const h = setup();
  await editText();
  expect(
    screen
      .getByText(/Editing\. Fields/)
      .closest("[data-notice]")
      ?.getAttribute("data-notice"),
  ).toBe("neutral");
  expect(
    screen
      .getByText(/Editing\. Fields/)
      .closest("[data-notice]")
      ?.classList.contains("bg-muted/40"),
  ).toBe(true);
  h.props.manifest = { stale: false, data: { object: { ...live, data: { greeting: "theirs" } } } };
  h.rerender();
  expect(
    screen
      .getByText(/changed on the Cluster while/)
      .closest("[data-notice]")
      ?.getAttribute("data-notice"),
  ).toBe("warning");
  expect(
    screen
      .getByText(/changed on the Cluster while/)
      .closest("[data-notice]")
      ?.classList.contains("bg-warning/10"),
  ).toBe(true);
  expect(
    screen
      .getByText(/changed on the Cluster while/)
      .closest("[data-notice]")
      ?.querySelector("svg.text-warning"),
  ).not.toBeNull();
  h.setReview({ ...review, refusal: { code: "invalid", message: "identity changed" } });
  fireEvent.click(screen.getByRole("button", { name: "Review changes" }));
  await within(screen.getByRole("dialog")).findByText("This edit cannot be applied");
  fireEvent.click(screen.getByRole("button", { name: "Back to editing" }));
  expect(
    screen
      .getByText("This edit cannot be applied")
      .closest("[data-notice]")
      ?.getAttribute("data-notice"),
  ).toBe("error");
  expect(
    screen
      .getByText("This edit cannot be applied")
      .closest("[data-notice]")
      ?.classList.contains("bg-destructive/10"),
  ).toBe(true);
  expect(
    screen
      .getByText("This edit cannot be applied")
      .closest("[data-notice]")
      ?.querySelector("svg.text-destructive"),
  ).not.toBeNull();
  h.unmount();
});
it("announces Copied for two seconds after copying a deleted Resource's edits", async () => {
  const h = setup();
  await editText();
  h.props.manifest = { stale: false, data: { deleted: true } };
  h.rerender();
  vi.useFakeTimers();
  fireEvent.click(screen.getByRole("button", { name: "Copy YAML" }));
  await act(async () => {});
  expect(
    screen.getByRole("button", { name: "Copied" }).querySelector('[aria-live="polite"]'),
  ).not.toBeNull();
  await act(() => vi.advanceTimersByTime(2000));
  expect(screen.getByRole("button", { name: "Copy YAML" })).toBeDefined();
  h.unmount();
});
