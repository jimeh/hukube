// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { EngineProvider } from "@hukube/engine-client/react";
import type { EngineClient, Setting } from "@hukube/engine-client";
import { PreferenceField, ResetSection } from "./settings-page.tsx";
import { getPreferenceStore } from "./store.ts";
afterEach(cleanup);
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
