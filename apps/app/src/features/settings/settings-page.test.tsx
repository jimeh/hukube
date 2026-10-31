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
afterEach(() => {
  cleanup();
  useSettingsOpenWork.setState({ preferences: false, overview: false });
  vi.useRealTimers();
});
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
