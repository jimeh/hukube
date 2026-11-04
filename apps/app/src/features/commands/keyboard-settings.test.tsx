// @vitest-environment jsdom
import { useLayoutEffect } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { EngineProvider } from "@hukube/engine-client/react";
import type { EngineClient, Setting } from "@hukube/engine-client";
import { afterEach, expect, it, vi } from "vitest";
import { KeyboardSettings } from "./keyboard-settings.tsx";
import { Dialog, DialogContent, DialogTitle } from "@hukube/ui/components/dialog";
import { commands } from "./runtime.ts";
import { useKeybindings } from "./store.ts";
import { compileKeymap, emptyDocument, type Rule } from "./keyboard.ts";
const rule: Rule = {
  id: "saved-theme",
  command: "appearance.setTheme",
  keys: ["F8"],
  when: "",
  scope: "app",
  enabled: true,
  args: { theme: "dark" },
};
afterEach(() => {
  cleanup();
  commands.setRecording(false);
  commands.blur();
});
async function setup(rules: Rule[] = [], visible = true) {
  let value = { ...emptyDocument, rules };
  let revision = "one";
  let listener!: { data(s: Setting): void };
  let current!: ReturnType<typeof useKeybindings>;
  function Probe() {
    const bindings = useKeybindings();
    useLayoutEffect(() => {
      current = bindings;
    });
    return null;
  }
  const writes = vi.fn<(_method: string, params: { value: typeof value }) => Promise<void>>(
    async (_method, params) => {
      value = params.value;
      revision = "saved";
    },
  );
  const client = {
    request: writes,
    getState: () => "open",
    onStateChange: () => () => {},
    subscribe: (_m: string, _p: unknown, l: { data(s: Setting): void }) => {
      listener = l;
      queueMicrotask(() => l.data({ key: "app/keybindings", revision, value }));
      return { close() {}, update() {} };
    },
  } as unknown as EngineClient;
  let view!: ReturnType<typeof render>;
  const content = (shown: boolean, modal = false) => (
    <EngineProvider client={client}>
      <KeyboardSettings visible={shown} />
      <Probe />
      <input aria-label="Outside" />
      <Dialog open={modal}>
        <DialogContent>
          <DialogTitle>Other owner</DialogTitle>
          <input aria-label="Modal input" />
        </DialogContent>
      </Dialog>
    </EngineProvider>
  );
  await act(async () => {
    view = render(content(visible));
  });
  expect(screen.getByText("Shortcuts loaded")).toBeTruthy();
  return {
    get snapshot() {
      return current.snapshot;
    },
    get store() {
      return current.store;
    },
    writes,
    receive: (next: typeof value) =>
      act(() => {
        value = next;
        revision = "two";
        listener.data({ key: "app/keybindings", revision, value });
      }),
    modal: (open: boolean) => view.rerender(content(true, open)),
    hide: () => view.rerender(content(false)),
    show: () => view.rerender(content(true)),
  };
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

it("releases a hidden recorder and preserves its draft without resuming", async () => {
  const h = await setup([rule]);
  fireEvent.click(screen.getByRole("button", { name: "Edit / recordsaved-theme" }));
  fireEvent.change(screen.getByLabelText("Condition (when)"), { target: { value: "workspace" } });
  fireEvent.click(screen.getByRole("button", { name: "Record shortcut" }));
  expect(commands.getSnapshot().recording).toBe(true);
  h.hide();
  const input = screen.getByLabelText("Outside");
  input.focus();
  const e = new KeyboardEvent("keydown", {
    key: "x",
    code: "KeyX",
    cancelable: true,
    bubbles: true,
  });
  fireEvent(input, e);
  expect(e.defaultPrevented).toBe(false);
  expect(commands.getSnapshot().recording).toBe(false);
  h.show();
  expect(screen.getByRole("button", { name: "Record shortcut" })).toBeTruthy();
  expect(screen.getByLabelText<HTMLInputElement>("Condition (when)").value).toBe("workspace");
});
it("refreshes effective rule status on actual DOM focus changes", async () => {
  const rules = [{ ...rule, when: "focus == 'input'" }];
  commands.configure({
    route: "/settings/keyboard-shortcuts",
    platform: "linux",
    host: "web",
    connection: "open",
    modalCount: 0,
    map: compileKeymap({ ...emptyDocument, rules }, "linux"),
    preferencesReady: () => true,
    preference() {},
    settings() {},
  });
  await setup(rules);
  const input = screen.getByLabelText("Search commands and bindings");
  fireEvent.change(input, { target: { value: "saved-theme" } });
  act(() => input.focus());
  expect(document.activeElement).toBe(input);
  expect(screen.getByText("Effective in this context")).toBeTruthy();
  act(() => screen.getByRole("button", { name: "Edit / recordsaved-theme" }).focus());
  expect(screen.getByText("Condition does not match this context")).toBeTruthy();
});

it("destroys the real recorder when another Dialog takes input and never resumes its draft", async () => {
  const root = document.createElement("div");
  root.id = "root";
  document.body.append(root);
  const h = await setup([rule]);
  fireEvent.click(screen.getByRole("button", { name: "Edit / recordsaved-theme" }));
  fireEvent.change(screen.getByLabelText("Condition (when)"), { target: { value: "workspace" } });
  fireEvent.click(screen.getByRole("button", { name: "Record shortcut" }));
  expect(commands.getSnapshot().recording).toBe(true);
  h.modal(true);
  const input = screen.getByLabelText("Modal input");
  for (const letter of "hello") {
    const e = new KeyboardEvent("keydown", {
      key: letter,
      code: `Key${letter.toUpperCase()}`,
      bubbles: true,
      cancelable: true,
    });
    fireEvent(input, e);
    expect(e.defaultPrevented).toBe(false);
  }
  expect(commands.getSnapshot().recording).toBe(false);
  h.modal(false);
  expect(screen.getByRole("button", { name: "Record shortcut" })).toBeTruthy();
  expect(
    screen.getByLabelText<HTMLInputElement>("One or two strokes (space separated)").value,
  ).toBe("F8");
  expect(screen.getByLabelText<HTMLInputElement>("Condition (when)").value).toBe("workspace");
  expect(screen.getByText("Rule ID: saved-theme")).toBeTruthy();
  root.remove();
});

it("shows a possible shifted conflict instead of claiming whole-layout shadowing", async () => {
  const rules: Rule[] = [
    { ...rule, id: "glyph", keys: ["!"] },
    { ...rule, id: "position", keys: ["Shift+[Digit1]"], command: "app.openSettings", args: {} },
  ];
  commands.configure({
    route: "/settings/keyboard-shortcuts",
    platform: "linux",
    host: "web",
    connection: "open",
    modalCount: 0,
    map: compileKeymap({ ...emptyDocument, rules }, "linux"),
    preferencesReady: () => true,
    preference() {},
    settings() {},
  });
  await setup(rules);
  expect(
    screen.getByText("May be shadowed here by position, for some matching input"),
  ).toBeTruthy();
  expect(screen.getByText(/position may overlap glyph/)).toBeTruthy();
  expect(screen.getAllByText("Effective in this context").length).toBeGreaterThan(0);
});

it("keeps partially available physical Paste readable without calling it effective", async () => {
  const { commandTestWorkspace } = await import("./test-runtime.ts");
  const { useExecSessions } = await import("../exec/sessions.ts");
  const { fakeTerminal } = await import("../exec/test-terminal.ts");
  const { commandPlatform } = await import("@/lib/platform.ts");
  const terminal = fakeTerminal().terminal;
  const input = document.createElement("textarea");
  terminal.element.dataset["execSession"] = "partial";
  terminal.element.dataset["commandPanel"] = "partial-panel";
  terminal.element.append(input);
  document.body.append(terminal.element);
  input.focus();
  const panelApi = { id: "partial-panel", component: "exec" };
  const off = commandTestWorkspace(panelApi, () => ({
    sessionId: "partial",
  }));
  const surfaceOff = commands.registerSurface({
    element: terminal.element,
    read: () => ({ kind: "terminal" }),
  });
  useExecSessions.setState({ entries: new Map([["partial", { terminal } as never]]) });
  vi.stubGlobal("navigator", { clipboard: undefined });
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([{}] as unknown as DOMRectList);
  try {
    commands.configure({
      route: "/c/c",
      platform: commandPlatform,
      host: "web",
      connection: "open",
      modalCount: 0,
      map: compileKeymap(emptyDocument, commandPlatform),
      preferencesReady: () => true,
      preference: () => {},
      settings: () => {},
    });
    const keys = [commandPlatform === "mac" ? "Meta+[KeyB]" : "Control+[KeyB]"];
    await setup([
      { ...rule, id: "partial", command: "terminal.paste", args: {}, keys, scope: "terminal" },
    ]);
    expect(
      screen.getByText("Available only for some matching input via native Paste"),
    ).toBeTruthy();
  } finally {
    cleanup();
    surfaceOff();
    off();
    terminal.element.remove();
    useExecSessions.setState({ entries: new Map() });
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});

it.each([
  ["edit", false],
  ["edit", true],
  ["add", false],
  ["add", true],
] as const)(
  "cancels %s-only work (changed %s) without retaining a document draft",
  async (kind, changed) => {
    const h = await setup([rule]);
    fireEvent.click(
      screen.getByRole("button", {
        name: kind === "edit" ? "Edit / recordsaved-theme" : /Add binding.*Open Settings/,
      }),
    );
    expect(h.snapshot.draft).toBeDefined();
    if (changed)
      fireEvent.change(screen.getByLabelText("Condition (when)"), {
        target: { value: "workspace" },
      });
    fireEvent.click(screen.getByRole("button", { name: "Cancel rule" }));
    expect(screen.queryByRole("form", { name: "Edit keyboard rule" })).toBeNull();
    expect(h.snapshot.draft).toBeUndefined();
    expect(h.snapshot.conflict).toBe(false);
    expect(h.writes).not.toHaveBeenCalled();
  },
);
it.each([false, true])(
  "releases only form-owned work after concurrent Engine updates (reload %s)",
  async (reload) => {
    const h = await setup([rule]);
    fireEvent.click(screen.getByRole("button", { name: "Edit / recordsaved-theme" }));
    const latest = { ...emptyDocument, rules: [{ ...rule, args: { theme: "light" } }] };
    h.receive(latest);
    expect(h.snapshot.conflict).toBe(true);
    if (reload) await act(async () => h.store.retry());
    expect(screen.getByLabelText<HTMLSelectElement>("Theme (required)").value).toBe("dark");
    fireEvent.click(screen.getByRole("button", { name: "Cancel rule" }));
    await act(async () => {});
    expect(h.snapshot.document).toEqual(latest);
    expect(h.snapshot.draft).toBeUndefined();
    expect(h.snapshot.conflict).toBe(false);
    expect(h.snapshot.active.rules.find((r) => r.id === rule.id)?.args).toEqual({ theme: "light" });
  },
);
it.each(["preexisting", "independent", "conflicted"] as const)(
  "retains %s set work when cancelling a form",
  async (kind) => {
    const h = await setup([rule, { ...rule, id: "other", keys: ["F9"] }]);
    if (kind !== "independent")
      fireEvent.click(screen.getByRole("button", { name: "Disablesaved-theme" }));
    if (kind === "conflicted") h.receive({ ...emptyDocument, rules: [{ ...rule, keys: ["F10"] }] });
    fireEvent.click(screen.getByRole("button", { name: "Edit / recordsaved-theme" }));
    fireEvent.change(screen.getByLabelText("Condition (when)"), { target: { value: "workspace" } });
    if (kind !== "conflicted")
      fireEvent.click(screen.getByRole("button", { name: "Move down saved-theme" }));
    const draft = h.snapshot.draft;
    h.receive({ ...emptyDocument, rules: [{ ...rule, keys: ["F11"] }] });
    await act(async () => h.store.retry());
    fireEvent.click(screen.getByRole("button", { name: "Cancel rule" }));
    expect(h.snapshot.draft).toEqual(draft);
    expect(h.snapshot.conflict).toBe(true);
    expect(h.writes).not.toHaveBeenCalled();
  },
);
it("saves a same-ID form into the reordered set and activates only after document Save", async () => {
  const h = await setup([rule, { ...rule, id: "other", keys: ["F9"] }]);
  fireEvent.click(screen.getByRole("button", { name: "Edit / recordsaved-theme" }));
  fireEvent.change(screen.getByLabelText("Condition (when)"), { target: { value: "workspace" } });
  fireEvent.click(screen.getByRole("button", { name: "Move down saved-theme" }));
  submit();
  expect(h.snapshot.draft?.rules.map((r) => r.id)).toEqual(["other", rule.id]);
  expect(h.snapshot.draft?.rules[1]?.when).toBe("workspace");
  expect(h.snapshot.active.rules.find((r) => r.id === rule.id)?.when).toBe("");
  fireEvent.click(screen.getByRole("button", { name: "Save shortcuts" }));
  await act(async () => {});
  expect(h.writes).toHaveBeenCalledTimes(1);
  expect(h.snapshot.draft).toBeUndefined();
  expect(h.snapshot.active.rules.find((r) => r.id === rule.id)?.when).toBe("workspace");
});
it.each(["cancel", "reset", "remove"] as const)(
  "keeps explicit set %s semantics after form work",
  async (operation) => {
    const h = await setup([rule]);
    fireEvent.click(screen.getByRole("button", { name: "Edit / recordsaved-theme" }));
    fireEvent.change(screen.getByLabelText("Condition (when)"), { target: { value: "workspace" } });
    if (operation === "cancel") {
      submit();
      fireEvent.click(screen.getByRole("button", { name: "Cancel changes" }));
    } else if (operation === "reset") {
      fireEvent.click(screen.getByRole("button", { name: "Reset keyboard shortcuts" }));
    } else {
      fireEvent.click(screen.getByRole("button", { name: "Removesaved-theme" }));
      fireEvent.click(screen.getByRole("button", { name: "Cancel rule" }));
    }
    expect(screen.queryByRole("form", { name: "Edit keyboard rule" })).toBeNull();
    expect(h.snapshot.draft?.rules).toEqual(operation === "cancel" ? undefined : []);
    expect(h.writes).not.toHaveBeenCalled();
  },
);
