// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { EngineProvider } from "@hukube/engine-client/react";
import type { EngineClient, Setting } from "@hukube/engine-client";
import { afterEach, expect, it } from "vitest";
import { KeyboardSettings } from "./keyboard-settings.tsx";
import { emptyDocument, type Rule } from "./keyboard.ts";
const rule: Rule = {
  id: "saved-theme",
  command: "appearance.setTheme",
  keys: ["F8"],
  when: "",
  scope: "app",
  enabled: true,
  args: { theme: "dark" },
};
afterEach(cleanup);
async function setup(rules: Rule[] = []) {
  const value = { ...emptyDocument, rules };
  const client = {
    getState: () => "open",
    onStateChange: () => () => {},
    subscribe: (_m: string, _p: unknown, l: { data(s: Setting): void }) => {
      queueMicrotask(() => l.data({ key: "app/keybindings", revision: "one", value }));
      return { close() {}, update() {} };
    },
  } as unknown as EngineClient;
  await act(async () => {
    render(
      <EngineProvider client={client}>
        <KeyboardSettings />
      </EngineProvider>,
    );
  });
  expect(screen.getByText("Shortcuts loaded")).toBeTruthy();
}
it("searches real default and saved rows by title while preserving unknown rules and drafts", async () => {
  await setup([rule, { ...rule, id: "future", command: "future.action", args: { retained: 1 } }]);
  const search = screen.getByLabelText("Search commands and bindings");
  fireEvent.change(search, { target: { value: "Set theme" } });
  expect(screen.getByRole("button", { name: "Edit / recordsaved-theme" })).toBeTruthy();
  fireEvent.change(search, { target: { value: "Go to Resource" } });
  expect(screen.getByRole("button", { name: "Disable defaultdefault.resource.app" })).toBeTruthy();
  fireEvent.change(search, { target: { value: "future.action" } });
  expect(screen.getByRole("button", { name: "Edit / recordfuture" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Edit / recordsaved-theme" })).toBeNull();
  fireEvent.change(search, { target: { value: "Set theme" } });
  fireEvent.click(screen.getByRole("button", { name: "Edit / recordsaved-theme" }));
  fireEvent.change(screen.getByLabelText("Condition (when)"), { target: { value: "workspace" } });
  fireEvent.change(search, { target: { value: "future.action" } });
  expect(screen.getByLabelText<HTMLInputElement>("Condition (when)").value).toBe("workspace");
  expect(screen.getByText("Rule ID: saved-theme")).toBeTruthy();
});
function submit() {
  fireEvent.click(screen.getByRole("button", { name: "Save rule" }));
}
function describedError(field: HTMLElement, text: string) {
  expect(field.getAttribute("aria-invalid")).toBe("true");
  expect(document.activeElement).toBe(field);
  const ids = field.getAttribute("aria-describedby")?.split(" ") ?? [];
  expect(ids.some((id) => document.getElementById(id)?.textContent === text)).toBe(true);
}
it.each([
  ["appearance.setTheme", "Theme (required)", { theme: "blue" }, "Theme: Choose light or dark."],
  ["logs.setWrap", "Enabled (required)", { enabled: "yes" }, "Enabled: Choose Yes or No."],
  ["resource.openType", "Resource Type (required)", { type: 3 }, "Resource Type: Enter text."],
  [
    "resource.open",
    "Resource URI (required)",
    { uri: "pod-name" },
    "Resource URI: Use a canonical Resource URI.",
  ],
] as const)(
  "associates supplied invalid %s arguments and focuses their field",
  async (command, label, args, message) => {
    await setup([{ ...rule, command, args: {} }]);
    fireEvent.click(screen.getByRole("button", { name: "Edit / recordsaved-theme" }));
    fireEvent.change(screen.getByLabelText("Named arguments (JSON object)"), {
      target: { value: JSON.stringify(args) },
    });
    submit();
    describedError(screen.getByLabelText(label), message);
    expect(screen.getByRole("form", { name: "Edit keyboard rule" })).toBeTruthy();
  },
);
it.each(["{", "null", "[]", "3", '{"unknown":true}'])(
  "retains invalid JSON %s and focuses its associated diagnostic",
  async (json) => {
    await setup([rule]);
    fireEvent.click(screen.getByRole("button", { name: "Edit / recordsaved-theme" }));
    const field = screen.getByLabelText("Named arguments (JSON object)");
    fireEvent.change(field, { target: { value: json } });
    submit();
    expect(field.getAttribute("aria-invalid")).toBe("true");
    expect(document.activeElement).toBe(field);
    expect(field.getAttribute("aria-describedby")).toBeTruthy();
    expect((field as HTMLTextAreaElement).value).toBe(json);
  },
);
it.each(["appearance.setTheme", "resource.openType", "logs.setWrap"])(
  "saves omitted prompted arguments for %s with stable rule identity",
  async (command) => {
    await setup([{ ...rule, command, args: {} }]);
    fireEvent.click(screen.getByRole("button", { name: "Edit / recordsaved-theme" }));
    submit();
    expect(screen.queryByRole("form", { name: "Edit keyboard rule" })).toBeNull();
    expect(screen.getByRole("button", { name: "Edit / recordsaved-theme" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Save shortcuts" }).hasAttribute("disabled")).toBe(
      false,
    );
  },
);

it("keeps optional choices omittable and preserves false rather than treating it as missing", async () => {
  await setup([{ ...rule, command: "resource.open", args: {} }]);
  fireEvent.click(screen.getByRole("button", { name: "Edit / recordsaved-theme" }));
  fireEvent.change(screen.getByLabelText("Preview Tab (optional)"), { target: { value: "false" } });
  submit();
  expect(screen.queryByRole("form", { name: "Edit keyboard rule" })).toBeNull();
  expect(screen.getByText(/args:.*\{"preview":false\}/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Edit / recordsaved-theme" }));
  fireEvent.change(screen.getByLabelText("Command"), { target: { value: "app.openSettings" } });
  const field = screen.getByLabelText("Settings category (optional)");
  fireEvent.change(field, { target: { value: "appearance" } });
  fireEvent.change(field, { target: { value: "" } });
  submit();
  expect(screen.queryByRole("form", { name: "Edit keyboard rule" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Edit / recordsaved-theme" }));
  expect(screen.getByLabelText<HTMLTextAreaElement>("Named arguments (JSON object)").value).toBe(
    "{}",
  );
});
it("keeps unknown commands recoverable without rendering known-command fields", async () => {
  await setup([{ ...rule, command: "future.action", args: { future: true } }]);
  fireEvent.click(screen.getByRole("button", { name: "Edit / recordsaved-theme" }));
  expect(screen.queryByLabelText("Theme (required)")).toBeNull();
  submit();
  expect(screen.queryByRole("form", { name: "Edit keyboard rule" })).toBeNull();
  expect(screen.getByText(/args:.*future.*true/)).toBeTruthy();
});
