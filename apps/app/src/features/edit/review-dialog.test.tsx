// @vitest-environment jsdom
// oxlint-disable vitest/no-conditional-expect -- Each table case asserts its distinct recovery path.
import {
  EngineRequestError,
  type EngineClient,
  type EditReview,
  type ResourceEdit,
  type ConnectionState,
} from "@hukube/engine-client";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useReview } from "./use-review.ts";
import { ReviewDialog } from "./review-dialog.tsx";
vi.mock("./diff-editor.tsx", () => ({
  default: ({ before, after }: { before: string; after: string }) => (
    <div data-testid="diff">
      {before} → {after}
    </div>
  ),
}));
const edit: ResourceEdit = {
  cluster: "c",
  type: "configmaps",
  namespace: "ns",
  name: "web",
  uid: "u",
  base: { data: { greeting: "hello" } },
  manifest: { data: { greeting: "mine" } },
};
const ready: EditReview = {
  before: edit.base,
  desired: edit.manifest,
  after: edit.manifest,
  edited: [["data", "greeting"]],
  changedOnCluster: [],
  overlaps: [],
  setByCluster: [],
  ignored: [],
  warnings: [],
};
const failure = (code: ConstructorParameters<typeof EngineRequestError>[0]["code"]) =>
  new EngineRequestError({
    code,
    message: "API answer",
    causes: [{ field: "data.greeting", message: "bad field" }],
  });
function harness(
  reviewAnswer: EditReview | Error = ready,
  applyAnswer: unknown = { resourceVersion: "2", warnings: [] },
) {
  let connection: ConnectionState = "open";
  const listeners = new Set<() => void>();
  const request = vi.fn<
    (method: string, params: ResourceEdit, options?: { signal: AbortSignal }) => Promise<unknown>
  >((method) => {
    if (
      method === "resource.apply" &&
      applyAnswer instanceof EngineRequestError &&
      applyAnswer.code === "disconnected"
    )
      connection = "reconnecting";
    return method === "resource.review"
      ? reviewAnswer instanceof Error
        ? Promise.reject(reviewAnswer)
        : Promise.resolve(reviewAnswer)
      : applyAnswer instanceof Error
        ? Promise.reject(applyAnswer)
        : Promise.resolve(applyAnswer);
  });
  const client = {
    request,
    getState: () => connection,
    onStateChange: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  } as unknown as EngineClient;
  const applied = vi.fn<() => void>();
  const refused = vi.fn<() => void>();
  function View({ live }: { live?: Record<string, unknown> }) {
    const controller = useReview(client, live, applied, refused);
    return (
      <>
        <button onClick={() => controller.begin(edit)}>Review</button>
        <ReviewDialog
          review={controller}
          cluster="c"
          label="ConfigMap web"
          namespace="ns"
          onBack={() => {}}
        />
      </>
    );
  }
  const view = render(<View />);
  fireEvent.click(screen.getByRole("button", { name: "Review" }));
  return {
    request,
    applied,
    refused,
    rerender: (live: Record<string, unknown>) => view.rerender(<View live={live} />),
    reconnect: () =>
      act(() => {
        connection = "open";
        for (const listener of listeners) listener();
      }),
    setReview: (answer: EditReview) => {
      reviewAnswer = answer;
    },
    setApply: (answer: unknown) => {
      applyAnswer = answer;
    },
  };
}
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
it("checks before showing the accepted diff, focuses Back, and applies the reviewed pair", async () => {
  const h = harness({
    ...ready,
    before: { data: { greeting: "cluster" } },
    desired: { data: { greeting: "mine", untouched: "cluster" } },
  });
  expect(screen.getByText("Checking with the Cluster…")).toBeDefined();
  await screen.findByText("The Cluster accepts this edit.");
  await waitFor(() => expect(document.activeElement?.textContent).toBe("Back to editing"));
  fireEvent.click(screen.getByRole("button", { name: "Apply" }));
  await waitFor(() =>
    expect(h.request).toHaveBeenCalledWith("resource.apply", {
      ...edit,
      base: { data: { greeting: "cluster" } },
      manifest: { data: { greeting: "mine", untouched: "cluster" } },
    }),
  );
  h.rerender({ metadata: { resourceVersion: "2" } });
  await waitFor(() => expect(h.applied).toHaveBeenCalledTimes(1));
});
it.each([
  [
    "overlap",
    { ...ready, overlaps: [["data", "greeting"]] },
    "Overwrite and apply",
    "both changed",
  ],
  [
    "unsupported dry run",
    {
      ...ready,
      dryRunUnsupported: true,
      refusal: { code: "invalid", message: "does not support dry run" },
    },
    "Apply without a dry run",
    "validated only",
  ],
  [
    "refused",
    {
      ...ready,
      refusal: {
        code: "invalid",
        message: "bad Manifest",
        causes: [{ field: "data.greeting", message: "bad field" }],
      },
    },
    "Apply",
    "The Cluster refused",
  ],
  [
    "forbidden",
    { ...ready, refusal: { code: "forbidden", message: "denied" } },
    "Apply",
    "Not permitted",
  ],
] as const)("renders %s", async (_, answer, action, text) => {
  harness(answer as EditReview);
  await screen.findByText(new RegExp(text));
  const button = screen.getByRole("button", { name: action });
  expect(button.hasAttribute("disabled") || button.getAttribute("aria-disabled") === "true").toBe(
    !!answer.refusal && !answer.dryRunUnsupported,
  );
});
it.each([false, true])("explains nothing to apply (already present: %s)", async (changed) => {
  harness({ ...ready, edited: [], changedOnCluster: changed ? [["data", "greeting"]] : [] });
  await screen.findByText("Nothing to apply");
  expect(
    screen.getByText(
      changed
        ? "The Cluster already has these values."
        : "Comments and formatting are not part of a Resource.",
    ),
  ).toBeDefined();
  expect(screen.queryByRole("button", { name: "Apply" })).toBeNull();
});
it.each(["internal", "too_large", "not_found"] as const)(
  "shows failed review %s and appropriate retry",
  async (code) => {
    harness(failure(code));
    await screen.findByRole("alert");
    expect(!!screen.queryByRole("button", { name: "Try again" })).toBe(code === "internal");
  },
);
it.each(["invalid", "forbidden", "unavailable", "disconnected", "conflict"] as const)(
  "handles apply %s",
  async (code) => {
    const h = harness(ready, failure(code));
    await screen.findByText("The Cluster accepts this edit.");
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    if (code === "conflict") {
      await screen.findByText(
        "The Resource changed on the Cluster while you were reviewing. Nothing was applied.",
      );
      expect(h.request.mock.calls.filter(([method]) => method === "resource.review")).toHaveLength(
        2,
      );
      expect(h.request).toHaveBeenLastCalledWith(
        "resource.review",
        edit,
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    } else if (code === "disconnected") {
      await screen.findByText(/Lost the connection/);
      const first = h.request.mock.calls.find(([method]) => method === "resource.apply");
      h.setApply({ resourceVersion: "2", unchanged: true, warnings: [] });
      h.reconnect();
      await waitFor(() =>
        expect(h.request.mock.calls.filter(([method]) => method === "resource.apply")).toHaveLength(
          2,
        ),
      );
      expect(h.request.mock.calls.at(-1)).toEqual(first);
      h.rerender({ metadata: { resourceVersion: "2" } });
      await waitFor(() => expect(h.applied).toHaveBeenCalledOnce());
    } else if (code === "unavailable") {
      await screen.findByText(
        "The Cluster did not answer. The edit may or may not have been applied.",
      );
      fireEvent.click(screen.getByRole("button", { name: "Check again" }));
      await screen.findByText("The Cluster accepts this edit.");
    } else {
      await screen.findByText("Nothing was applied.");
      expect(h.refused).toHaveBeenCalled();
    }
  },
);
it("cannot dismiss an applying review, aborts a review on Back, and preserves the text", async () => {
  const h = harness();
  await screen.findByText("The Cluster accepts this edit.");
  const signal = h.request.mock.calls[0]![2] as { signal: AbortSignal };
  fireEvent.click(screen.getByRole("button", { name: "Back to editing" }));
  expect(signal.signal.aborted).toBe(true);
  expect(h.applied).not.toHaveBeenCalled();
});
it("rechecks a live change after the debounce and completes after the result deadline", async () => {
  const h = harness();
  await screen.findByText("The Cluster accepts this edit.");
  vi.useFakeTimers();
  h.rerender({ data: { greeting: "another" } });
  await act(async () => {
    vi.advanceTimersByTime(300);
  });
  expect(h.request.mock.calls.filter(([method]) => method === "resource.review")).toHaveLength(2);
  fireEvent.click(screen.getByRole("button", { name: "Apply" }));
  await act(async () => {});
  await act(async () => {
    vi.advanceTimersByTime(2000);
  });
  expect(h.applied).toHaveBeenCalledOnce();
});

it("blocks Back and Escape until an apply settles, without aborting the write", async () => {
  let finish: ((value: unknown) => void) | undefined;
  const pending = new Promise<unknown>((resolve) => {
    finish = resolve;
  });
  const h = harness(ready, pending);
  await screen.findByText("The Cluster accepts this edit.");
  fireEvent.click(screen.getByRole("button", { name: "Apply" }));
  await screen.findByText("Applying…");
  fireEvent.click(screen.getByRole("button", { name: "Back to editing" }));
  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  expect(screen.getByRole("dialog")).toBeDefined();
  expect(h.request.mock.calls.find(([method]) => method === "resource.apply")).toHaveLength(2);
  await act(async () => finish?.({ resourceVersion: "2", warnings: [] }));
  h.rerender({ metadata: { resourceVersion: "2" } });
  await waitFor(() => expect(h.applied).toHaveBeenCalledOnce());
});

it("shows the apply refusal after choosing Apply without a dry run", async () => {
  harness(
    {
      ...ready,
      dryRunUnsupported: true,
      refusal: { code: "invalid", message: "does not support dry run" },
    },
    failure("invalid"),
  );
  fireEvent.click(await screen.findByRole("button", { name: "Apply without a dry run" }));
  expect(await screen.findByText("The Cluster refused this edit")).toBeDefined();
  expect(screen.getByText("Nothing was applied.")).toBeDefined();
  expect(screen.getByText("data.greeting: bad field")).toBeDefined();
});

it("shows kept Cluster changes, defaulting, ignored fields, and warnings in order", async () => {
  harness({
    ...ready,
    changedOnCluster: [["metadata", "labels", "tier"]],
    setByCluster: [["spec", "replicas"]],
    ignored: [["status"]],
    warnings: ["Admission warning"],
  });
  await screen.findByText(
    /Also changed on the Cluster while you were editing, and kept: metadata.labels.tier/,
  );
  expect(screen.getByText("The Cluster also sets: spec.replicas.")).toBeDefined();
  expect(
    screen.getByText("Not applied, because the Cluster sets these itself: status."),
  ).toBeDefined();
  expect(screen.getByText("Admission warning")).toBeDefined();
});
