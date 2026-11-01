// @vitest-environment jsdom
/* oxlint-disable typescript/unbound-method -- Mock operations never use this. */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { DockviewApi, IDockviewPanel } from "dockview-react";
import type { WorkspaceValue } from "../workspace/workspace-context.tsx";
import { useUnsavedEdits } from "../edit/unsaved-edits.ts";
import { useExecSessions, type ExecSession } from "../exec/sessions.ts";
import { fakeTerminal } from "../exec/test-terminal.ts";
import { formatResourceUri } from "@hukube/k8s";
import { CommandRuntime, terminalVerdicts } from "./runtime.ts";
import { compileKeymap, emptyDocument, type Rule } from "./keyboard.ts";
const rects = () => [{}] as unknown as DOMRectList;
beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockImplementation(rects);
  vi.stubGlobal("requestAnimationFrame", (fn: () => void) => {
    fn();
    return 1;
  });
});
afterEach(() => {
  document.body.replaceChildren();
  useUnsavedEdits.setState({ entries: new Map(), guard: undefined });
  useExecSessions.setState({ entries: new Map() });
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function harness(rules: Rule[] = []) {
  const rt = new CommandRuntime(),
    settings = vi.fn<() => void>(),
    preference = vi.fn<() => void>();
  const config = {
    route: "/c/c",
    platform: "linux" as const,
    host: "web" as const,
    connection: "open",
    modalCount: 0,
    map: compileKeymap({ ...emptyDocument, rules }, "linux"),
    preferencesReady: () => true,
    preference,
    settings,
  };
  rt.configure(config);
  let panel = {
    id: "p",
    params: { uri: "k8s://c/namespaces/default/pods/p" },
    group: {},
    api: {
      component: "resource",
      title: "Pod",
      close: vi.fn<() => void>(),
      updateParameters: vi.fn<() => void>(),
    },
  } as unknown as IDockviewPanel;
  const api = {
    getPanel: (id: string) => (id === panel?.id ? panel : undefined),
    get activePanel() {
      return panel;
    },
  } as unknown as DockviewApi;
  const value = {
    active: true,
    cluster: "c",
    types: new Map(),
    openList: vi.fn<() => void>(),
    openResource: vi.fn<() => void>(),
  } as unknown as WorkspaceValue;
  const owner = { token: {}, api, value };
  rt.registerWorkspace("c", owner);
  const root = document.createElement("div");
  root.dataset["commandPanel"] = "p";
  const input = document.createElement("textarea");
  root.append(input);
  document.body.append(root);
  input.focus();
  let uid: string | undefined = "one";
  const find = vi.fn<() => void>(),
    review = vi.fn<() => void>();
  const unregister = rt.registerSurface({
    element: root,
    read: () => ({ kind: "editor", find, review, dirty: true, uid }),
  });
  return {
    rt,
    config,
    input,
    root,
    find,
    review,
    settings,
    preference,
    owner,
    unregister,
    panel: () => panel,
    replace: () => {
      panel = { ...panel };
    },
    uid: (v: string | undefined) => (uid = v),
  };
}
const key = (letter: string, code: string, extra: KeyboardEventInit = {}) =>
  new KeyboardEvent("keydown", { key: letter, code, cancelable: true, ctrlKey: true, ...extra });
it("captures exact owners, panel object, Pane, params and Resource UID", () => {
  const h = harness(),
    origin = h.rt.capture();
  expect(h.rt.valid(origin)).toBe(true);
  h.uid("two");
  expect(h.rt.invoke("manifest.review", {}, origin)).toBe(false);
  expect(h.review).not.toHaveBeenCalled();
  const next = h.rt.capture();
  h.replace();
  expect(h.rt.valid(next)).toBe(false);
  const third = h.rt.capture();
  Object.assign(h.panel(), { group: {} });
  expect(h.rt.valid(third)).toBe(false);
  const fourth = h.rt.capture();
  h.rt.registerWorkspace("c", { ...h.owner, token: {} });
  expect(h.rt.valid(fourth)).toBe(false);
});
it("guards close and rechecks stale targets inside delayed confirmation", () => {
  const h = harness();
  useUnsavedEdits.getState().set("p", { cluster: "c", label: "Pod", read: () => "dirty" });
  h.rt.dispatch("tab.close", {});
  expect(vi.mocked(h.panel().api.close)).not.toHaveBeenCalled();
  const proceed = useUnsavedEdits.getState().guard?.proceed;
  h.replace();
  proceed?.();
  expect(h.rt.getSnapshot().error).toContain("captured Tab changed");
  expect(vi.mocked(h.panel().api.close)).not.toHaveBeenCalled();
  h.rt.dispatch("tab.close", {});
  useUnsavedEdits.getState().dismiss();
  expect(vi.mocked(h.panel().api.close)).not.toHaveBeenCalled();
});
it("dispatches once with multiple Workspaces and consumes repeat, keypress, release", () => {
  const h = harness();
  h.rt.registerWorkspace("hidden", {
    ...h.owner,
    token: {},
    value: { ...h.owner.value, cluster: "hidden", active: false },
  });
  const event = key("f", "KeyF");
  h.rt.key(event);
  expect(event.defaultPrevented).toBe(true);
  expect(h.find).toHaveBeenCalledTimes(1);
  for (const type of ["keydown", "keypress", "keyup"]) {
    const e = new KeyboardEvent(type, {
      key: "f",
      code: "KeyF",
      ctrlKey: true,
      repeat: type === "keydown",
      cancelable: true,
    });
    h.rt.key(e);
    expect(e.defaultPrevented).toBe(true);
  }
  expect(h.find).toHaveBeenCalledTimes(1);
  h.unregister();
  const native = key("f", "KeyF");
  h.rt.key(native);
  expect(native.defaultPrevented).toBe(false);
});
it("prefilters composition, 229, Dead, AltGraph and recorder ownership", () => {
  const h = harness();
  for (const extra of [
    { isComposing: true },
    { keyCode: 229 },
    { key: "Dead" },
    { repeat: true },
  ]) {
    const e = key("f", "KeyF", extra);
    h.rt.key(e);
    expect(e.defaultPrevented).toBe(false);
  }
  const alt = key("f", "KeyF");
  vi.spyOn(alt, "getModifierState").mockReturnValue(true);
  h.rt.key(alt);
  h.rt.setRecording(true);
  h.rt.key(key("f", "KeyF"));
  expect(h.find).not.toHaveBeenCalled();
});
it("keeps native Find widget and diff Find; cancels eligible chords on boundaries", () => {
  const rule: Rule = {
    id: "user.chord",
    command: "app.openSettings",
    keys: ["Mod+G", "H"],
    when: "",
    scope: "app",
    enabled: true,
  };
  const h = harness([rule]);
  h.input.className = "find-widget";
  const native = key("f", "KeyF");
  h.rt.key(native);
  expect(native.defaultPrevented).toBe(false);
  h.input.className = "";
  h.rt.key(key("g", "KeyG"));
  expect(h.rt.chords.pending).toBeDefined();
  h.rt.blur();
  expect(h.rt.chords.pending).toBeUndefined();
  h.rt.key(key("g", "KeyG"));
  h.rt.configure({ ...h.config, modalCount: 1 });
  expect(h.rt.chords.pending).toBeUndefined();
  h.rt.configure(h.config);
  h.rt.blur();
  h.rt.key(key("g", "KeyG"));
  h.rt.configure({ ...h.config, map: compileKeymap(emptyDocument, "linux") });
  expect(h.rt.chords.pending).toBeUndefined();
});
it("terminal overrides are explicit, palette repeats do not dispatch twice and paste keeps native activation", () => {
  const app: Rule = {
    id: "generic",
    command: "app.openSettings",
    keys: ["Control+Q"],
    when: "",
    scope: "app",
    enabled: true,
  };
  const h = harness([app]),
    t = fakeTerminal().terminal;
  h.root.append(t.element);
  t.element.dataset["execSession"] = "s";
  const textarea = document.createElement("textarea");
  t.element.append(textarea);
  textarea.focus();
  Object.assign(h.panel(), { params: { sessionId: "s" } });
  useExecSessions.setState({
    entries: new Map([
      [
        "s",
        {
          params: { sessionId: "s" },
          terminal: t,
          state: { phase: "live" },
        } as unknown as ExecSession,
      ],
    ]),
  });
  h.rt.registerSurface({ element: t.element, read: () => ({ kind: "terminal", find: h.find }) });
  h.rt.key(key("q", "KeyQ"));
  expect(h.settings).not.toHaveBeenCalled();
  h.rt.configure({
    ...h.config,
    map: compileKeymap({ ...emptyDocument, rules: [{ ...app, scope: "terminal" }] }, "linux"),
  });
  h.rt.key(key("q", "KeyQ"));
  expect(h.settings).toHaveBeenCalledTimes(1);
  h.rt.blur();
  const paste = key("v", "KeyV");
  h.rt.key(paste);
  expect(paste.defaultPrevented).toBe(false);
  expect(terminalVerdicts.get(paste)).toBe("paste");
  h.rt.blur();
  h.rt.key(key("P", "KeyP", { shiftKey: true }));
  expect(h.rt.getSnapshot().palette?.mode).toBe("commands");
  h.rt.key(key("P", "KeyP", { shiftKey: true, repeat: true }));
  expect(h.rt.getSnapshot().palette?.mode).toBe("commands");
});

it("collects missing arguments inside the same palette and keeps the original target", () => {
  const h = harness(),
    origin = h.rt.capture();
  h.rt.openPalette("commands", origin);
  const paletteInput = document.createElement("input");
  document.body.append(paletteInput);
  paletteInput.focus();
  expect(h.rt.invoke("appearance.setTheme", {}, origin, "keyboard")).toBe(true);
  expect(h.rt.getSnapshot().palette?.origin).toBe(origin);
  expect(h.rt.getSnapshot().palette?.prompt?.id).toBe("appearance.setTheme");
  expect(h.preference).not.toHaveBeenCalled();
  expect(h.rt.invoke("appearance.setTheme", { theme: "invalid" }, origin)).toBe(false);
  expect(h.rt.invoke("appearance.setTheme", { theme: "light" }, origin)).toBe(true);
  expect(h.preference).toHaveBeenCalledWith("theme", "light");
});
it("unavailable Review leaves input alone and defaults can disable terminal exceptions", () => {
  const h = harness();
  h.unregister();
  h.rt.registerSurface({
    element: h.root,
    read: () => ({ kind: "editor", dirty: true, review: h.review, reviewReason: "Not permitted" }),
  });
  const save = key("s", "KeyS");
  h.rt.key(save);
  expect(save.defaultPrevented).toBe(false);
  expect(h.review).not.toHaveBeenCalled();
  const t = fakeTerminal().terminal;
  t.element.dataset["execSession"] = "s";
  h.root.append(t.element);
  const input = document.createElement("textarea");
  t.element.append(input);
  input.focus();
  Object.assign(h.panel(), { params: { sessionId: "s" } });
  useExecSessions.setState({
    entries: new Map([
      [
        "s",
        {
          cluster: "c",
          params: { sessionId: "s" },
          terminal: t,
          state: { phase: "live" },
        } as unknown as ExecSession,
      ],
    ]),
  });
  h.rt.registerSurface({ element: t.element, read: () => ({ kind: "terminal", find: h.find }) });
  h.rt.configure({
    ...h.config,
    map: compileKeymap(
      {
        ...emptyDocument,
        disabledDefaults: ["default.palette.terminal", "default.find.terminal.other"],
      },
      "linux",
    ),
  });
  const palette = key("P", "KeyP", { shiftKey: true });
  h.rt.key(palette);
  expect(palette.defaultPrevented).toBe(false);
  expect(h.rt.getSnapshot().palette).toBeUndefined();
  const find = key("F", "KeyF", { shiftKey: true });
  h.rt.key(find);
  expect(find.defaultPrevented).toBe(false);
  expect(h.find).not.toHaveBeenCalled();
  t.holdInput(true);
  h.rt.key(key("k", "KeyK"));
  expect(h.rt.getSnapshot().palette?.mode).toBe("resources");
});
it("completes chords once and cancels on target changes, Escape, recording and route loss", () => {
  const r: Rule = {
    id: "user.chord",
    command: "app.openSettings",
    keys: ["Mod+G", "H"],
    when: "",
    scope: "app",
    enabled: true,
  };
  const h = harness([r]);
  const release = () =>
    h.rt.key(
      new KeyboardEvent("keyup", { key: "g", code: "KeyG", ctrlKey: true, cancelable: true }),
    );
  h.rt.key(key("g", "KeyG"));
  release();
  h.rt.key(key("h", "KeyH", { ctrlKey: false }));
  expect(h.settings).toHaveBeenCalledTimes(1);
  h.rt.blur();
  h.rt.key(key("g", "KeyG"));
  release();
  h.replace();
  const second = key("h", "KeyH", { ctrlKey: false });
  h.rt.key(second);
  expect(second.defaultPrevented).toBe(false);
  expect(h.settings).toHaveBeenCalledTimes(1);
  h.rt.key(key("g", "KeyG"));
  release();
  const escape = key("Escape", "Escape", { ctrlKey: false });
  h.rt.key(escape);
  expect(escape.defaultPrevented).toBe(true);
  expect(h.rt.chords.pending).toBeUndefined();
  h.rt.blur();
  h.rt.key(key("g", "KeyG"));
  h.rt.setRecording(true);
  expect(h.rt.chords.pending).toBeUndefined();
  h.rt.setRecording(false);
  h.rt.blur();
  h.rt.key(key("g", "KeyG"));
  h.rt.configure({ ...h.config, route: "/settings/appearance" });
  expect(h.rt.chords.pending).toBeUndefined();
});
it.each(["Enter", "Escape"])(
  "waits for palette close completion after %s release before returning focus",
  (closingKey) => {
    const h = harness(),
      focus = vi.spyOn(h.input, "focus");
    h.rt.openPalette("commands", h.rt.capture());
    h.rt.key(new KeyboardEvent("keydown", { key: closingKey, code: closingKey, cancelable: true }));
    h.rt.closePalette();
    expect(focus).not.toHaveBeenCalled();
    for (const type of ["keydown", "keypress", "keyup"]) {
      const event = new KeyboardEvent(type, {
        key: closingKey,
        code: closingKey,
        repeat: type === "keydown",
        cancelable: true,
      });
      h.rt.key(event);
      expect(event.defaultPrevented).toBe(true);
      expect(terminalVerdicts.get(event)).toBe("handled");
    }
    expect(focus).not.toHaveBeenCalled();
    h.rt.paletteClosed();
    expect(focus).toHaveBeenCalledOnce();
  },
);
it.each(["Enter", "Escape"])("waits for %s release when the palette closes first", (closingKey) => {
  const h = harness(),
    focus = vi.spyOn(h.input, "focus");
  h.rt.openPalette("commands", h.rt.capture());
  h.rt.key(new KeyboardEvent("keydown", { key: closingKey, code: closingKey }));
  h.rt.closePalette();
  h.rt.paletteClosed();
  expect(focus).not.toHaveBeenCalled();
  h.rt.key(new KeyboardEvent("keyup", { key: closingKey, code: closingKey }));
  expect(focus).toHaveBeenCalledOnce();
});
function focusFrames() {
  const frames: FrameRequestCallback[] = [];
  vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) => {
    frames.push(fn);
    return frames.length;
  });
  return () => {
    for (const fn of frames.splice(0)) fn(0);
  };
}
it("ignores cancelled close completion and queued focus after a rapid reopen", () => {
  const frame = focusFrames(),
    h = harness(),
    focus = vi.spyOn(h.input, "focus");
  const origin = h.rt.capture();
  h.rt.openPalette("commands", origin);
  h.rt.closePalette();
  h.rt.paletteClosed();
  h.rt.openPalette("commands", origin);
  h.rt.paletteClosed();
  frame();
  expect(focus).not.toHaveBeenCalled();
  expect(h.rt.getSnapshot().palette).toBeDefined();
  h.rt.closePalette();
  frame();
  expect(focus).not.toHaveBeenCalled();
  h.rt.paletteClosed();
  frame();
  expect(focus).toHaveBeenCalledOnce();
});
it.each([
  "blur",
  "route",
  "workspace",
  "hidden",
  "panel",
  "pane",
  "params",
  "uid",
  "modal",
  "outdated",
])("invalidates queued palette focus on %s, even if that boundary later reverses", (boundary) => {
  const frame = focusFrames(),
    h = harness(),
    focus = vi.spyOn(h.input, "focus");
  h.rt.openPalette("commands", h.rt.capture());
  h.rt.closePalette();
  h.rt.paletteClosed();
  switch (boundary) {
    case "blur":
      h.rt.blur();
      break;
    case "route":
      h.rt.configure({ ...h.config, route: "/" });
      h.rt.configure(h.config);
      break;
    case "workspace":
      h.rt.registerWorkspace("c", { ...h.owner, token: {} });
      h.rt.registerWorkspace("c", h.owner);
      break;
    case "hidden":
      h.owner.value.active = false;
      h.rt.refreshAvailability();
      h.owner.value.active = true;
      break;
    case "outdated":
      h.rt.configure({ ...h.config, connection: "outdated" });
      h.rt.configure(h.config);
      break;
    case "panel":
      h.replace();
      h.rt.refreshAvailability();
      break;
    case "pane": {
      const group = h.panel().group;
      Object.assign(h.panel(), { group: {} });
      h.rt.refreshAvailability();
      Object.assign(h.panel(), { group });
      break;
    }
    case "params": {
      const params = h.panel().params;
      Object.assign(h.panel(), { params: {} });
      h.rt.refreshAvailability();
      Object.assign(h.panel(), { params });
      break;
    }
    case "uid":
      h.uid("two");
      h.rt.refreshAvailability();
      h.uid("one");
      break;
    case "modal":
      h.rt.configure({ ...h.config, modalCount: 1 });
      h.rt.configure(h.config);
      break;
  }
  frame();
  expect(focus).not.toHaveBeenCalled();
});
it.each(["app.openSettings", "manifest.review", "tab.close", "editor.find"] as const)(
  "does not steal focus from a %s handoff after close completion or key release",
  (command) => {
    const frame = focusFrames(),
      h = harness(),
      focus = vi.spyOn(h.input, "focus");
    const origin = h.rt.capture();
    h.rt.openPalette("commands", origin);
    h.rt.key(new KeyboardEvent("keydown", { key: "Enter", code: "Enter" }));
    h.rt.closePalette();
    h.rt.paletteClosed();
    expect(h.rt.invoke(command, {}, origin)).toBe(true);
    h.rt.key(new KeyboardEvent("keyup", { key: "Enter", code: "Enter" }));
    frame();
    expect(focus).not.toHaveBeenCalled();
  },
);
it("never returns to a connected element belonging to a replaced target", () => {
  const h = harness(),
    focus = vi.spyOn(h.input, "focus");
  h.rt.openPalette("commands", h.rt.capture());
  h.replace();
  const fallback = vi.fn<() => void>();
  h.rt.registerSurface({ element: h.root, read: () => ({ kind: "editor", focus: fallback }) });
  h.rt.closePalette();
  h.rt.paletteClosed();
  expect(focus).not.toHaveBeenCalled();
  expect(fallback).toHaveBeenCalledOnce();
});

it("toggles the terminal's Go to Resource shortcut and switches mode after palette focus moves", () => {
  const h = harness(),
    t = fakeTerminal().terminal;
  t.element.dataset["execSession"] = "s";
  h.root.append(t.element);
  const input = document.createElement("textarea");
  t.element.append(input);
  input.focus();
  Object.assign(h.panel(), { params: { sessionId: "s" } });
  useExecSessions.setState({
    entries: new Map([
      [
        "s",
        {
          cluster: "c",
          params: { sessionId: "s" },
          terminal: t,
          state: { phase: "live" },
        } as unknown as ExecSession,
      ],
    ]),
  });
  h.rt.registerSurface({ element: t.element, read: () => ({ kind: "terminal", find: h.find }) });
  const open = () => h.rt.key(key("K", "KeyK", { shiftKey: true }));
  const release = () =>
    h.rt.key(
      new KeyboardEvent("keyup", {
        key: "K",
        code: "KeyK",
        ctrlKey: true,
        shiftKey: true,
        cancelable: true,
      }),
    );
  open();
  release();
  expect(h.rt.getSnapshot().palette?.mode).toBe("resources");
  const paletteInput = document.createElement("input");
  document.body.append(paletteInput);
  paletteInput.focus();
  open();
  release();
  expect(h.rt.getSnapshot().palette).toBeUndefined();
  input.focus();
  open();
  release();
  paletteInput.focus();
  h.rt.key(key("P", "KeyP", { shiftKey: true }));
  expect(h.rt.getSnapshot().palette?.mode).toBe("commands");
});

it("opens validated Resources in the captured Workspace and forwards beside to its Tab", () => {
  const h = harness();
  Object.assign(h.owner.value, { types: new Map([["pods", {}]]) });
  const origin = h.rt.capture();
  expect(
    h.rt.invoke(
      "resource.openType",
      { type: "pods", preview: true, beside: true },
      origin,
      "pointer",
    ),
  ).toBe(true);
  expect(h.owner.value.openList).toHaveBeenCalledWith("pods", {
    preview: true,
    beside: "p",
    pane: undefined,
  });
  const uri = formatResourceUri({ cluster: "c", type: "pods", namespace: "ns", name: "pod" });
  expect(h.rt.invoke("resource.open", { uri, beside: true }, origin, "pointer")).toBe(true);
  expect(h.owner.value.openResource).toHaveBeenCalledWith(
    expect.objectContaining({ cluster: "c", type: "pods", namespace: "ns", name: "pod" }),
    { preview: false, beside: "p", pane: undefined },
  );
  expect(
    h.rt.invoke(
      "resource.open",
      { uri: formatResourceUri({ cluster: "other", type: "pods", namespace: "ns", name: "pod" }) },
      origin,
      "pointer",
    ),
  ).toBe(false);
});

it("keeps logical Mod+J reserved even if another physical binding matches it", () => {
  const r: Rule = {
    id: "user.physical",
    command: "app.openSettings",
    keys: ["Mod+[KeyX]"],
    when: "",
    scope: "app",
    enabled: true,
  };
  const h = harness([r]);
  const e = key("j", "KeyX");
  h.rt.key(e);
  expect(e.defaultPrevented).toBe(false);
  expect(h.settings).not.toHaveBeenCalled();
});

it("cancels pending chords immediately when the captured surface disappears or its UID changes", () => {
  const r: Rule = {
    id: "user.chord",
    command: "app.openSettings",
    keys: ["Mod+G", "H"],
    when: "",
    scope: "app",
    enabled: true,
  };
  const h = harness([r]);
  h.rt.key(key("g", "KeyG"));
  h.uid("replacement");
  h.rt.refreshAvailability();
  expect(h.rt.chords.pending).toBeUndefined();
  h.rt.blur();
  h.rt.key(key("g", "KeyG"));
  h.unregister();
  expect(h.rt.chords.pending).toBeUndefined();
});

it("returns focus to a surviving owner when the original surface disappears", () => {
  const h = harness();
  h.rt.openPalette("commands", h.rt.capture());
  h.unregister();
  h.input.remove();
  const focus = vi.fn<() => void>();
  const next = document.createElement("div");
  h.root.append(next);
  h.rt.registerSurface({ element: next, read: () => ({ kind: "editor", focus }) });
  h.rt.closePalette();
  h.rt.paletteClosed();
  expect(focus).toHaveBeenCalledOnce();
});

it("requires actual editor text focus for default Review and Find, leaving toolbar inputs native", () => {
  const h = harness();
  h.unregister();
  h.rt.registerSurface({
    element: h.input,
    read: () => ({ kind: "editor", find: h.find, review: h.review, dirty: true }),
  });
  const button = document.createElement("button");
  h.root.append(button);
  button.focus();
  const save = key("s", "KeyS");
  h.rt.key(save);
  expect(save.defaultPrevented).toBe(false);
  expect(h.review).not.toHaveBeenCalled();
  const field = document.createElement("input");
  h.root.append(field);
  field.focus();
  const find = key("f", "KeyF");
  h.rt.key(find);
  expect(find.defaultPrevented).toBe(false);
  expect(h.find).not.toHaveBeenCalled();
});

// Navigation owns the Workspace and captured placement, not the source Manifest.
it.each(["resource.open", "resource.openType"] as const)(
  "%s stays usable while the source Resource hydrates or its surface remounts",
  (command) => {
    const h = harness();
    Object.assign(h.owner.value, { types: new Map([["pods", {}]]) });
    h.uid(undefined);
    const origin = h.rt.capture();
    h.rt.openPalette("resources", origin);
    h.uid("hydrated");
    h.rt.refreshAvailability();
    expect(h.rt.getSnapshot().palette?.mode).toBe("resources");
    expect(h.rt.invoke("manifest.review", {}, origin)).toBe(false);
    h.unregister();
    h.rt.registerSurface({
      element: h.root,
      read: () => ({ kind: "editor", uid: "hydrated", review: h.review }),
    });
    h.rt.refreshAvailability();
    expect(h.rt.getSnapshot().palette?.mode).toBe("resources");
    const args =
      command === "resource.openType"
        ? { type: "pods" }
        : { uri: formatResourceUri({ cluster: "c", type: "pods", namespace: "ns", name: "next" }) };
    expect(h.rt.invoke(command, args, origin, "pointer")).toBe(true);
    expect(
      command === "resource.openType" ? h.owner.value.openList : h.owner.value.openResource,
    ).toHaveBeenCalledOnce();
  },
);
it.each(["panel", "pane", "params", "workspace", "hidden", "route"])(
  "Workspace navigation still refuses a changed captured %s, including explicit placement",
  (boundary) => {
    const h = harness();
    const origin = h.rt.capture();
    h.rt.openPalette("resources", origin);
    switch (boundary) {
      case "panel":
        h.replace();
        break;
      case "pane":
        Object.assign(h.panel(), { group: {} });
        break;
      case "params":
        Object.assign(h.panel(), { params: {} });
        break;
      case "workspace":
        h.rt.registerWorkspace("c", { ...h.owner, token: {} });
        break;
      case "hidden":
        h.owner.value.active = false;
        break;
      case "route":
        h.rt.configure({ ...h.config, route: "/" });
        break;
    }
    h.rt.refreshAvailability();
    expect(h.rt.getSnapshot().palette).toBeUndefined();
    for (const placement of [{}, { beside: true }]) {
      expect(
        h.rt.dispatch(
          "resource.open",
          {
            uri: formatResourceUri({ cluster: "c", type: "pods", namespace: "ns", name: "next" }),
            ...placement,
          },
          origin,
        ),
      ).toBe(false);
    }
    origin.openPane = "p";
    expect(h.rt.dispatch("resource.openType", { type: "pods" }, origin)).toBe(false);
    expect(h.owner.value.openList).not.toHaveBeenCalled();
    expect(h.owner.value.openResource).not.toHaveBeenCalled();
  },
);
it.each(["resource.open", "resource.openType"] as const)(
  "%s retains captured placement when another Tab becomes active",
  (command) => {
    const h = harness();
    Object.assign(h.owner.value, { types: new Map([["pods", {}]]) });
    const origin = h.rt.capture();
    Object.defineProperty(h.owner.api, "activePanel", { get: () => ({ id: "other", group: {} }) });
    const args =
      command === "resource.openType"
        ? { type: "pods", beside: true }
        : {
            uri: formatResourceUri({ cluster: "c", type: "pods", namespace: "ns", name: "next" }),
            beside: true,
          };
    expect(h.rt.invoke(command, args, origin, "pointer")).toBe(true);
    const open =
      command === "resource.openType" ? h.owner.value.openList : h.owner.value.openResource;
    expect(open).toHaveBeenLastCalledWith(expect.anything(), {
      preview: false,
      beside: "p",
      pane: undefined,
    });
    origin.openPane = "p";
    expect(h.rt.invoke(command, { ...args, beside: false }, origin, "pointer")).toBe(true);
    expect(open).toHaveBeenLastCalledWith(expect.anything(), {
      preview: false,
      beside: undefined,
      pane: "p",
    });
  },
);

it("keeps Resource UID validation for edit and Tab actions when the editor itself survives", () => {
  const h = harness();
  const resource = document.createElement("section");
  resource.dataset["commandPanel"] = "p";
  h.root.before(resource);
  resource.append(h.root);
  let uid = "old";
  h.rt.registerSurface({ element: resource, read: () => ({ kind: "resource", uid }) });
  const origin = h.rt.capture();
  expect(origin.resource?.element).toBe(resource);
  expect(origin.surface?.element).toBe(h.root);
  uid = "replacement";
  for (const command of ["manifest.review", "editor.find", "tab.close", "tab.pin"] as const)
    expect(h.rt.invoke(command, {}, origin)).toBe(false);
  expect(h.review).not.toHaveBeenCalled();
  expect(h.find).not.toHaveBeenCalled();
  expect(h.panel().api.close).not.toHaveBeenCalled();
});
it("refuses an explicit Pane that was absent at capture instead of using the active Pane", () => {
  const h = harness();
  const origin = h.rt.capture("c", "missing");
  origin.openPane = "missing";
  expect(
    h.rt.dispatch(
      "resource.open",
      {
        uri: formatResourceUri({ cluster: "c", type: "pods", namespace: "ns", name: "next" }),
      },
      origin,
    ),
  ).toBe(false);
  expect(h.owner.value.openResource).not.toHaveBeenCalled();
});
it("uses Workspace validation through prompted Resource arguments after source hydration", () => {
  const h = harness();
  const origin = h.rt.capture();
  h.rt.openPalette("commands", origin);
  h.uid("hydrated");
  expect(h.rt.invoke("resource.open", {}, origin, "keyboard")).toBe(true);
  expect(h.rt.getSnapshot().palette?.prompt?.id).toBe("resource.open");
  expect(
    h.rt.invoke(
      "resource.open",
      {
        uri: formatResourceUri({ cluster: "c", type: "pods", namespace: "ns", name: "next" }),
      },
      origin,
      "pointer",
    ),
  ).toBe(true);
  expect(h.owner.value.openResource).toHaveBeenCalledOnce();
});
