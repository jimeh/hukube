// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { EngineProvider } from "@hukube/engine-client/react";
import { EngineRequestError, type EngineClient, type Setting } from "@hukube/engine-client";
import { PreferenceField, PreferenceSectionStatus, ResetSection } from "./settings-page.tsx";
import { getPreferenceStore } from "./store.ts";
import { PreferenceRuntime } from "./preference-runtime.tsx";
import { useSettingsOpenWork } from "./open-work.ts";
import { useLogSettings } from "../logs/log-settings.ts";
import { UnsavedGuard } from "../edit/unsaved-guard.tsx";
import { HostProvider } from "@/lib/host.tsx";
import type { Host } from "@hukube/host";
import { defaults, type Preferences, type NumericField } from "./preferences.ts";
afterEach(() => {
  cleanup();
  useSettingsOpenWork.setState({ preferences: false, overview: false });
  vi.useRealTimers();
});

function fieldHarness() {
  let value: Preferences = { version: 1, logStreams: { maxLines: 80 } };
  let revision = "original";
  let refused = false;
  const watches = new Set<{ data(value: Setting): void }>();
  const put = vi.fn<(method: string, params: { value: Preferences }) => Promise<unknown>>(
    async (_method, params) => {
      if (refused) throw new EngineRequestError({ code: "internal", message: "Disk is full" });
      value = params.value;
      revision += "x";
      return {};
    },
  );
  const engine = {
    getState: () => "open",
    onStateChange: () => () => {},
    request: put,
    subscribe: (_method: string, _params: unknown, listener: { data(value: Setting): void }) => {
      watches.add(listener);
      queueMicrotask(() => {
        if (watches.has(listener)) listener.data({ key: "app/preferences", value, revision });
      });
      return { close: () => watches.delete(listener), update() {} };
    },
  } as unknown as EngineClient;
  return {
    engine,
    put,
    store: getPreferenceStore(engine),
    refuse: (next: boolean) => (refused = next),
    remote: (next: Preferences) => {
      value = next;
      revision += "r";
      for (const watch of watches) watch.data({ key: "app/preferences", value, revision });
    },
  };
}

it.each<NumericField>(["maxLines", "maxCharacters", "maxDecorations"])(
  "leaves composing Enter uncancelled and unsent for %s, then commits ordinary Enter once",
  async (field) => {
    const h = fieldHarness();
    const view = render(
      <EngineProvider client={h.engine}>
        <PreferenceField field={field} />
      </EngineProvider>,
    );
    try {
      await vi.waitFor(() => expect(h.store.getSnapshot().loaded).toBe(true));
      const input = view.container.querySelector("input")!;
      fireEvent.compositionStart(input);
      fireEvent.change(input, { target: { value: "1" } });
      const composing = new KeyboardEvent("keydown", {
        key: "Enter",
        isComposing: true,
        bubbles: true,
        cancelable: true,
      });
      fireEvent(input, composing);
      expect(h.put).not.toHaveBeenCalled();
      expect(composing.defaultPrevented).toBe(false);
      expect(h.store.getSnapshot().drafts[field]?.status).toBe("Not saved");
      fireEvent.compositionEnd(input);
      expect(h.put).not.toHaveBeenCalled();
      const enter = new KeyboardEvent("keydown", {
        key: "Enter",
        isComposing: false,
        bubbles: true,
        cancelable: true,
      });
      await act(async () => fireEvent(input, enter));
      expect(enter.defaultPrevented).toBe(true);
      expect(h.put).toHaveBeenCalledTimes(1);
      expect(h.put.mock.calls[0]![1].value.logStreams?.[field]).toBe(1);
      await vi.waitFor(() => expect(h.store.getSnapshot().values[field]).toBe(1));
      expect(h.put).toHaveBeenCalledTimes(1);
    } finally {
      view.unmount();
      h.store.dispose();
    }
  },
);

it("does not expand numeric syntax while allowing composition confirmation", async () => {
  const h = fieldHarness();
  const view = render(
    <EngineProvider client={h.engine}>
      <PreferenceField field="maxLines" />
    </EngineProvider>,
  );
  try {
    await vi.waitFor(() => expect(h.store.getSnapshot().loaded).toBe(true));
    const input = screen.getByLabelText("Maximum retained lines") as HTMLInputElement;
    fireEvent.compositionStart(input);
    fireEvent.change(input, { target: { value: "１" } });
    const composing = new KeyboardEvent("keydown", {
      key: "Enter",
      isComposing: true,
      bubbles: true,
      cancelable: true,
    });
    fireEvent(input, composing);
    expect(composing.defaultPrevented).toBe(false);
    fireEvent.compositionEnd(input);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(input.value).toBe("１");
    expect(h.store.getSnapshot().drafts.maxLines?.error).toContain("Enter a whole number");
    expect(h.put).not.toHaveBeenCalled();
    expect(h.store.getSnapshot().values.maxLines).toBe(80);
  } finally {
    view.unmount();
    h.store.dispose();
  }
});

it.each(
  (["maxLines", "maxCharacters", "maxDecorations"] as const).flatMap((field) =>
    (["forward", "reverse", "external"] as const).map((departure) => ({ field, departure })),
  ),
)(
  "commits $field once after $departure departure from its whole editing group",
  async ({ field, departure }) => {
    const h = fieldHarness();
    const view = render(
      <EngineProvider client={h.engine}>
        <button type="button">Previous control</button>
        <PreferenceField field={field} />
        <button type="button">Next control</button>
      </EngineProvider>,
    );
    try {
      await vi.waitFor(() => expect(h.store.getSnapshot().loaded).toBe(true));
      const input = view.container.querySelector("input")!;
      act(() => input.focus());
      fireEvent.change(input, { target: { value: "500" } });
      if (departure !== "external")
        act(() => screen.getByRole("button", { name: "Retry save" }).focus());
      expect(h.put).not.toHaveBeenCalled();
      if (departure !== "external")
        act(() => screen.getByRole("button", { name: "Use Engine value" }).focus());
      expect(h.put).not.toHaveBeenCalled();
      if (departure === "reverse") {
        act(() => screen.getByRole("button", { name: "Retry save" }).focus());
        act(() => input.focus());
      }
      expect(h.put).not.toHaveBeenCalled();
      if (departure === "reverse") {
        await act(async () => screen.getByRole("button", { name: "Previous control" }).focus());
      } else if (departure === "forward") {
        await act(async () => screen.getByRole("button", { name: "Next control" }).focus());
      } else await act(async () => input.blur());
      expect(h.put).toHaveBeenCalledTimes(1);
      expect(h.put.mock.calls[0]![1].value.logStreams?.[field]).toBe(500);
      await vi.waitFor(() => expect(h.store.getSnapshot().values[field]).toBe(500));
      expect(h.put).toHaveBeenCalledTimes(1);
    } finally {
      view.unmount();
      h.store.dispose();
    }
  },
);

it.each(["incomplete", "conflicted"])(
  "does not commit an %s draft on complete group departure",
  async (kind) => {
    const h = fieldHarness();
    const view = render(
      <EngineProvider client={h.engine}>
        <PreferenceField field="maxLines" />
        <button type="button">Next control</button>
      </EngineProvider>,
    );
    try {
      await vi.waitFor(() => expect(h.store.getSnapshot().loaded).toBe(true));
      const input = screen.getByLabelText("Maximum retained lines") as HTMLInputElement;
      act(() => input.focus());
      fireEvent.change(input, { target: { value: kind === "incomplete" ? "-" : "12" } });
      if (kind === "conflicted") act(() => h.remote({ version: 1, logStreams: { maxLines: 14 } }));
      act(() =>
        screen
          .getByRole("button", { name: kind === "incomplete" ? "Retry save" : "Keep my value" })
          .focus(),
      );
      act(() => screen.getByRole("button", { name: "Use Engine value" }).focus());
      expect(h.put).not.toHaveBeenCalled();
      await act(async () => screen.getByRole("button", { name: "Next control" }).focus());
      expect(h.put).not.toHaveBeenCalled();
      expect(input.value).toBe(kind === "incomplete" ? "-" : "12");
      expect(h.store.getSnapshot().drafts.maxLines?.status).toBe("Not saved");
      expect(h.store.getSnapshot().values.maxLines).toBe(kind === "incomplete" ? 80 : 14);
    } finally {
      view.unmount();
      h.store.dispose();
    }
  },
);

it.each<NumericField>(["maxLines", "maxCharacters", "maxDecorations"])(
  "discards %s through its recovery actions without a blur write, then preserves ordinary blur and Enter commits",
  async (field) => {
    const h = fieldHarness();
    const view = render(
      <EngineProvider client={h.engine}>
        <PreferenceField field={field} />
        <button type="button">Another control</button>
      </EngineProvider>,
    );
    try {
      await vi.waitFor(() => expect(h.store.getSnapshot().loaded).toBe(true));
      const input = view.container.querySelector("input")!;
      act(() => input.focus());
      fireEvent.change(input, { target: { value: "1" } });
      const discard = screen.getByRole("button", { name: "Use Engine value" });
      act(() => discard.focus());
      expect(h.put).not.toHaveBeenCalled();
      expect(input.value).toBe("1");
      fireEvent.click(discard);
      expect(h.put).not.toHaveBeenCalled();
      expect(input.value).toBe(String(field === "maxLines" ? 80 : defaults[field]));
      expect(document.activeElement).toBe(input);

      act(() => input.focus());
      fireEvent.change(input, { target: { value: "2" } });
      await act(async () => screen.getByRole("button", { name: "Another control" }).focus());
      await vi.waitFor(() => expect(h.store.getSnapshot().values[field]).toBe(2));
      expect(h.put).toHaveBeenCalledTimes(1);
      fireEvent.change(input, { target: { value: "3" } });
      await act(async () => fireEvent.keyDown(input, { key: "Enter" }));
      await vi.waitFor(() => expect(h.store.getSnapshot().values[field]).toBe(3));
      expect(h.put).toHaveBeenCalledTimes(2);
    } finally {
      view.unmount();
      h.store.dispose();
    }
  },
);

it("keeps recovery focus unsent until explicit Retry or Keep my value and leaves incomplete input discardable", async () => {
  const h = fieldHarness();
  const view = render(
    <EngineProvider client={h.engine}>
      <PreferenceField field="maxLines" />
    </EngineProvider>,
  );
  try {
    await vi.waitFor(() => expect(h.store.getSnapshot().loaded).toBe(true));
    const input = screen.getByLabelText("Maximum retained lines") as HTMLInputElement;
    act(() => input.focus());
    fireEvent.change(input, { target: { value: "12" } });
    const retry = screen.getByRole("button", { name: "Retry save" });
    act(() => retry.focus());
    expect(h.put).not.toHaveBeenCalled();
    await act(async () => fireEvent.click(retry));
    await vi.waitFor(() => expect(h.store.getSnapshot().values.maxLines).toBe(12));
    expect(h.put).toHaveBeenCalledTimes(1);

    act(() => input.focus());
    fireEvent.change(input, { target: { value: "15" } });
    act(() => h.remote({ version: 1, logStreams: { maxLines: 14 } }));
    const keep = screen.getByRole("button", { name: "Keep my value" });
    act(() => keep.focus());
    expect(h.put).toHaveBeenCalledTimes(1);
    await act(async () => fireEvent.click(keep));
    await vi.waitFor(() => expect(h.store.getSnapshot().values.maxLines).toBe(15));
    expect(h.put).toHaveBeenCalledTimes(2);

    act(() => input.focus());
    fireEvent.change(input, { target: { value: "-" } });
    const discard = screen.getByRole("button", { name: "Use Engine value" });
    act(() => discard.focus());
    fireEvent.click(discard);
    expect(input.value).toBe("15");
    expect(h.put).toHaveBeenCalledTimes(2);
  } finally {
    view.unmount();
    h.store.dispose();
  }
});

it.each(["wrap", "timestamps"] as const)(
  "withholds toolbar retry for a %s conflict, retains the error and restores genuine failure recovery",
  async (field) => {
    const h = fieldHarness();
    const original = useLogSettings.getState();
    const view = render(
      <EngineProvider client={h.engine}>
        <PreferenceRuntime />
      </EngineProvider>,
    );
    try {
      await vi.waitFor(() => expect(h.store.getSnapshot().loaded).toBe(true));
      h.refuse(true);
      await act(async () => h.store.change(field, !defaults[field]));
      await vi.waitFor(() => expect(useLogSettings.getState().saveError).toBe("Disk is full"));
      expect(useLogSettings.getState().retrySave).toEqual(expect.any(Function));
      act(() => h.remote({ version: 1, logStreams: { maxLines: 80, [field]: defaults[field] } }));
      expect(h.store.getSnapshot().drafts[field]?.conflict).toBe(true);
      expect(useLogSettings.getState().saveError).toBe("Disk is full");
      expect(useLogSettings.getState().retrySave).toBeUndefined();
      expect(h.put).toHaveBeenCalledTimes(1);

      act(() => h.store.discard([field]));
      await act(async () => h.store.change(field, !defaults[field]));
      await vi.waitFor(() => expect(useLogSettings.getState().saveError).toBe("Disk is full"));
      h.refuse(false);
      await act(async () => useLogSettings.getState().retrySave?.());
      await vi.waitFor(() => expect(h.store.getSnapshot().values[field]).toBe(!defaults[field]));
      expect(useLogSettings.getState().saveError).toBeUndefined();
      expect(h.put).toHaveBeenCalledTimes(3);
    } finally {
      view.unmount();
      h.store.dispose();
      useLogSettings.setState(original);
    }
  },
);
it("keeps incomplete numeric text on typing/navigation, commits Enter/blur only, and confirms or cancels section reset", async () => {
  let value: unknown = null,
    revision = "";
  const put = vi.fn<(...args: unknown[]) => Promise<unknown>>(async (...args) => {
    const params = args[1] as { value: unknown };
    value = params.value;
    revision += "x";
    return {};
  });
  const engine = {
    getState: () => "open",
    onStateChange: () => () => {},
    request: put,
    subscribe: (_m: string, _p: unknown, listener: { data(value: Setting): void }) => {
      queueMicrotask(() => listener.data({ key: "app/preferences", value, revision }));
      return { close() {}, update() {} };
    },
  } as unknown as EngineClient;
  const view = render(
    <EngineProvider client={engine}>
      <PreferenceField field="maxLines" />
      <PreferenceField field="maxCharacters" />
      <ResetSection section="logStreams" />
    </EngineProvider>,
  );
  const store = getPreferenceStore(engine);
  try {
    await act(async () => {
      await Promise.resolve();
    });
    const lines = screen.getByLabelText("Maximum retained lines");
    fireEvent.change(lines, { target: { value: "" } });
    expect(put).not.toHaveBeenCalled();
    fireEvent.keyDown(lines, { key: "Enter" });
    expect(put).not.toHaveBeenCalled();
    expect((lines as HTMLInputElement).value).toBe("");
    fireEvent.change(lines, { target: { value: " 0012 " } });
    expect(put).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.keyDown(lines, { key: "Enter" });
    });
    expect(put).toHaveBeenCalledTimes(1);
    expect((lines as HTMLInputElement).value).toBe("12");
    fireEvent.change(lines, { target: { value: "13" } });
    await act(async () => {
      fireEvent.blur(lines);
    });
    expect(put).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole("button", { name: "Reset Log Streams" }));
    const dialog = screen.getByRole("alertdialog");
    expect(dialog).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(put).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole("button", { name: "Reset Log Streams" }));
    await act(async () => {
      fireEvent.click(screen.getAllByRole("button", { name: "Reset Log Streams" }).at(-1)!);
    });
    expect(put).toHaveBeenCalledTimes(3);
    expect((lines as HTMLInputElement).value).toBe("50000");
  } finally {
    view.unmount();
    store.dispose();
  }
});

function unloadProtected() {
  const event = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}
it.each(["maxLines", "wrap"] as const)(
  "renders discarded %s as last confirmed, checks the section and protects unload until fresh reconciliation",
  async (field) => {
    vi.useFakeTimers();
    let holdReads = false;
    let value = { version: 1, logStreams: { maxLines: 80, wrap: true } };
    let revision = "original";
    const watches: { data(value: Setting): void; error(error: { message: string }): void }[] = [];
    const pending = Promise.withResolvers<void>();
    const put = vi.fn<(...args: unknown[]) => Promise<void>>(() => pending.promise);
    const engine = {
      getState: () => "open",
      onStateChange: () => () => {},
      request: put,
      subscribe: (_m: string, _p: unknown, listener: (typeof watches)[number]) => {
        watches.push(listener);
        queueMicrotask(() => {
          if (!holdReads) listener.data({ key: "app/preferences", value, revision });
        });
        return { close() {}, update() {} };
      },
    } as unknown as EngineClient;
    const reportOpenWork = vi.fn<(work: { edits: number; sessions: number }) => void>();
    const host: Host = {
      kind: "web",
      engine: async () => ({ url: "", token: "" }),
      openWindow() {},
      openExternal() {},
      reportOpenWork,
    };
    const view = render(
      <EngineProvider client={engine}>
        <HostProvider host={host}>
          <PreferenceRuntime />
          <PreferenceField field={field} />
          <PreferenceSectionStatus fields={[field]} />
          <UnsavedGuard />
        </HostProvider>
      </EngineProvider>,
    );
    const store = getPreferenceStore(engine);
    const status = () => view.container.querySelector(`#preference-${field}-status`)!.textContent;
    const summary = () => view.container.querySelector("output")!.textContent;
    try {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(status()).toBe("Saved");
      expect(summary()).toBe("Saved");
      await act(async () => {
        store.change(field, field === "maxLines" ? "1" : false);
        await vi.advanceTimersByTimeAsync(10000);
      });
      fireEvent.click(screen.getByRole("button", { name: "Use Engine value" }));
      expect(store.getSnapshot().drafts[field]).toBeUndefined();
      expect(status()).toBe("Last confirmed value. Checking…");
      expect(summary()).toBe("Checking preferences…");
      expect(unloadProtected()).toBe(true);
      expect(reportOpenWork).toHaveBeenLastCalledWith({ edits: 1, sessions: 0 });
      expect(useLogSettings.getState()).toMatchObject({
        wrap: true,
        saveStatus: field === "wrap" ? "Checking preferences…" : "",
      });
      await act(async () => {
        // This watch is still from before the sent request finished.
        watches[0]!.data({ key: "app/preferences", value, revision });
        holdReads = true;
        value = (put.mock.calls[0]![1] as { value: typeof value }).value;
        revision = "landed";
        pending.reject(new EngineRequestError({ code: "disconnected", message: "unknown" }));
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(watches).toHaveLength(2);
      expect(status()).toBe("Last confirmed value. Checking…");
      expect(summary()).toBe("Checking preferences…");
      await act(async () => {
        watches.at(-1)!.error({ message: "Controlled readback failure" });
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(status()).toBe("Last confirmed value. Checking…");
      expect(summary()).toBe("Checking preferences…");
      expect(unloadProtected()).toBe(true);
      await act(async () => {
        holdReads = false;
        store.retry();
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(status()).toBe("Saved");
      expect(summary()).toBe("Saved");
      expect(unloadProtected()).toBe(false);
      expect(reportOpenWork).toHaveBeenLastCalledWith({ edits: 0, sessions: 0 });
      expect(store.getSnapshot().values[field]).toBe(field === "maxLines" ? 1 : false);
      expect(useLogSettings.getState()).toMatchObject({
        wrap: field === "maxLines",
        saveStatus: "",
        saveError: undefined,
      });
      expect(put).toHaveBeenCalledTimes(1);
    } finally {
      view.unmount();
      store.dispose();
    }
  },
);
