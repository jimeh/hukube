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

it.each([
  { modifiers: ["Control"], flags: { ctrlKey: true } },
  { modifiers: ["Control", "Alt"], flags: { ctrlKey: true, altKey: true } },
  { modifiers: ["Meta", "Shift"], flags: { ctrlKey: false, metaKey: true, shiftKey: true } },
])(
  "retains the chord deadline and origin across $modifiers release/re-press",
  ({ modifiers, flags }) => {
    vi.useFakeTimers();
    try {
      const h = harness([
        {
          id: "released",
          command: "app.openSettings",
          keys: [modifiers.join("+") + "+G", modifiers.join("+") + "+H"],
          when: "",
          scope: "app",
          enabled: true,
        },
      ]);
      h.rt.key(key("g", "KeyG", flags));
      const pending = h.rt.chords.pending;
      expect(pending).toBeDefined();
      h.rt.key(new KeyboardEvent("keyup", { key: "g", code: "KeyG" }));
      for (const modifier of modifiers)
        h.rt.key(new KeyboardEvent("keyup", { key: modifier, code: modifier + "Left" }));
      vi.advanceTimersByTime(500);
      for (const modifier of modifiers) {
        h.rt.key(key(modifier, modifier + "Left", flags));
        expect(h.rt.chords.pending).toBe(pending);
      }
      h.rt.key(key("h", "KeyH", flags));
      expect(h.settings).toHaveBeenCalledExactlyOnceWith("appearance", pending!.origin);
      for (const type of ["keydown", "keypress", "keyup"]) {
        const event = new KeyboardEvent(type, {
          key: "h",
          code: "KeyH",
          repeat: type === "keydown",
          cancelable: true,
          ...flags,
        });
        h.rt.key(event);
        expect(event.defaultPrevented).toBe(true);
      }
      expect(h.settings).toHaveBeenCalledOnce();
      h.rt.key(key("g", "KeyG", flags));
      h.rt.key(new KeyboardEvent("keyup", { key: "g", code: "KeyG" }));
      vi.advanceTimersByTime(999);
      for (const modifier of modifiers) h.rt.key(key(modifier, modifier + "Left", flags));
      expect(h.rt.chords.pending).toBeDefined();
      vi.advanceTimersByTime(1);
      expect(h.rt.chords.pending).toBeUndefined();
      h.rt.key(key("h", "KeyH", flags));
      expect(h.settings).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  },
);
it.each([
  "panel",
  "pane",
  "params",
  "uid",
  "workspace",
  "hidden",
  "route",
  "modal",
  "map",
  "recording",
  "blur",
  "reserved",
  "escape",
])("modifier input cannot bypass %s chord cancellation", (boundary) => {
  const h = harness([
    {
      id: "cancel",
      command: "app.openSettings",
      keys: ["Control+G", "Control+H"],
      scope: "app",
      when: "",
      enabled: true,
    },
  ]);
  h.rt.key(key("g", "KeyG"));
  h.rt.key(new KeyboardEvent("keyup", { key: "g", code: "KeyG" }));
  expect(h.rt.chords.pending).toBeDefined();
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
    case "uid":
      h.uid("new");
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
    case "modal":
      h.rt.configure({ ...h.config, modalCount: 1 });
      break;
    case "map":
      h.rt.configure({ ...h.config, map: compileKeymap(emptyDocument, "linux") });
      break;
    case "recording":
      h.rt.setRecording(true);
      break;
    case "blur":
      h.rt.blur();
      break;
    case "reserved":
      h.rt.key(key("j", "KeyJ"));
      break;
    case "escape":
      h.rt.key(key("Escape", "Escape", { ctrlKey: false }));
      break;
  }
  h.rt.key(key("Control", "ControlLeft"));
  expect(h.rt.chords.pending).toBeUndefined();
  h.rt.key(key("h", "KeyH"));
  expect(h.settings).not.toHaveBeenCalled();
});

it("supersedes palette input ownership only on intentional view transitions", () => {
  const h = harness();
  h.rt.openPalette("commands");
  const search = h.rt.getSnapshot().palette!;
  expect(h.rt.ownsPaletteInput(search)).toBe(true);
  h.rt.refreshAvailability();
  h.rt.configure(h.config);
  expect(h.rt.getSnapshot().palette).toBe(search);
  expect(h.rt.ownsPaletteInput(search)).toBe(true);
  h.rt.editArguments("resource.open", search.origin);
  const prompt = h.rt.getSnapshot().palette!;
  expect(h.rt.ownsPaletteInput(search)).toBe(false);
  expect(h.rt.ownsPaletteInput(prompt)).toBe(true);
  h.rt.backToSearch();
  expect(h.rt.ownsPaletteInput(prompt)).toBe(false);
  const back = h.rt.getSnapshot().palette!;
  expect(h.rt.ownsPaletteInput(back)).toBe(true);
  h.rt.closePalette();
  expect(h.rt.ownsPaletteInput(back)).toBe(false);
});

it.each([
  "blur",
  "recording",
  "route",
  "modal",
  "outdated",
  "hidden",
  "workspace",
  "panel",
  "pane",
  "params",
])("invalidates active input ownership on %s even if the boundary reverses", (boundary) => {
  const h = harness();
  h.rt.openPalette("commands");
  const palette = h.rt.getSnapshot().palette!;
  switch (boundary) {
    case "blur":
      h.rt.blur();
      break;
    case "recording":
      h.rt.setRecording(true);
      h.rt.setRecording(false);
      break;
    case "route":
      h.rt.configure({ ...h.config, route: "/" });
      h.rt.configure(h.config);
      break;
    case "modal":
      h.rt.configure({ ...h.config, modalCount: 2 });
      h.rt.configure(h.config);
      break;
    case "outdated":
      h.rt.configure({ ...h.config, connection: "outdated" });
      h.rt.configure(h.config);
      break;
    case "hidden":
      h.owner.value.active = false;
      h.rt.refreshAvailability();
      h.owner.value.active = true;
      break;
    case "workspace":
      h.rt.registerWorkspace("c", { ...h.owner, token: {} });
      h.rt.registerWorkspace("c", h.owner);
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
  }
  expect(h.rt.ownsPaletteInput(palette)).toBe(false);
});

it.each(["hydration", "deletion", "replacement", "remount"])(
  "palette input follows placement through Resource %s without authorizing old actions",
  (boundary) => {
    const h = harness();
    if (boundary === "hydration") h.uid(undefined);
    const origin = h.rt.capture();
    h.rt.openPalette("commands", origin);
    const initial = h.rt.getSnapshot().palette!;
    h.rt.editArguments("resource.open", origin);
    const prompt = h.rt.getSnapshot().palette!;
    if (boundary === "remount") {
      h.unregister();
      h.rt.registerSurface({
        element: h.root,
        read: () => ({ kind: "editor", uid: "one", review: h.review }),
      });
    } else h.uid(boundary === "deletion" ? undefined : "replacement");
    h.rt.refreshAvailability();
    expect(h.rt.ownsPaletteInput(prompt)).toBe(true);
    expect(h.rt.valid(origin)).toBe(false);
    h.rt.backToSearch();
    expect(h.rt.ownsPaletteInput(h.rt.getSnapshot().palette!)).toBe(true);
    // Exercise the real arbiter's availability check as well as pointer switching.
    h.rt.key(key("k", "KeyK"));
    expect(h.rt.getSnapshot().palette?.mode).toBe("resources");
    h.rt.key(new KeyboardEvent("keyup", { key: "k", code: "KeyK" }));
    h.rt.key(key("P", "KeyP", { shiftKey: true }));
    expect(h.rt.getSnapshot().palette?.mode).toBe("commands");
    h.rt.key(new KeyboardEvent("keyup", { key: "P", code: "KeyP" }));
    for (const mode of ["resources", "commands"] as const) {
      h.rt.openPalette(mode, origin);
      const current = h.rt.getSnapshot().palette!;
      expect(current.mode).toBe(mode);
      expect(current.origin).toBe(origin);
      expect(h.rt.ownsPaletteInput(current)).toBe(true);
    }
    expect(h.rt.ownsPaletteInput(initial)).toBe(false);
    expect(h.rt.ownsPaletteInput(prompt)).toBe(false);
    for (const id of ["manifest.review", "editor.find", "tab.close", "tab.pin"] as const) {
      expect(h.rt.invoke(id, {}, origin)).toBe(false);
      expect(h.rt.getSnapshot().error).toContain("captured target changed");
    }
    expect(h.review).not.toHaveBeenCalled();
    expect(h.find).not.toHaveBeenCalled();
    expect(h.panel().api.close).not.toHaveBeenCalled();
  },
);

function pasteHarness(keys: string[], disabledDefaults: string[] = []) {
  const h = harness(),
    t = fakeTerminal().terminal;
  t.element.dataset["execSession"] = "s";
  const input = document.createElement("textarea");
  t.element.append(input);
  h.root.append(t.element);
  input.focus();
  Object.assign(h.panel(), { params: { sessionId: "s" } });
  useExecSessions.setState({
    entries: new Map([
      [
        "s",
        {
          terminal: t,
          params: { sessionId: "s" },
          state: { phase: "live" },
        } as unknown as ExecSession,
      ],
    ]),
  });
  h.rt.registerSurface({ element: t.element, read: () => ({ kind: "terminal" }) });
  h.rt.configure({
    ...h.config,
    map: compileKeymap(
      {
        ...emptyDocument,
        disabledDefaults,
        rules: [
          {
            id: "paste",
            command: "terminal.paste",
            keys,
            when: "",
            scope: "terminal",
            enabled: true,
          },
        ],
      },
      "linux",
    ),
  });
  const readText = vi.fn<() => Promise<string>>(async () => "fixture-only");
  vi.stubGlobal("navigator", { clipboard: { readText } });
  return { ...h, t, readText };
}
it("consumes native Paste prefixes without granting a pending chord clipboard access", () => {
  const h = pasteHarness(["Control+V", "G"], ["default.paste.terminal.other"]);
  const prefix = key("v", "KeyV");
  h.rt.key(prefix);
  expect(h.rt.chords.pending).toBeDefined();
  expect(prefix.defaultPrevented).toBe(true);
  expect(terminalVerdicts.get(prefix)).toBe("handled");
  h.rt.blur();
  expect(h.readText).not.toHaveBeenCalled();
});
it.each([["F8"], ["Control+Alt+V"], ["F8", "G"]])(
  "executes custom Paste %j once through the clipboard boundary",
  async (...keys) => {
    const h = pasteHarness(keys);
    const first =
      keys[0] === "F8" ? key("F8", "F8", { ctrlKey: false }) : key("v", "KeyV", { altKey: true });
    h.rt.key(first);
    expect(first.defaultPrevented).toBe(true);
    expect(terminalVerdicts.get(first)).toBe("handled");
    if (keys.length === 2) {
      h.rt.key(key("g", "KeyG", { ctrlKey: false }));
    }
    await Promise.resolve();
    expect(h.readText).toHaveBeenCalledTimes(1);
    expect(h.t.paste).toHaveBeenCalledExactlyOnceWith("fixture-only");
  },
);
it("does not paste custom clipboard results into a replaced panel", async () => {
  const h = pasteHarness(["F8"]);
  let finish!: (text: string) => void;
  h.readText.mockImplementation(
    () =>
      new Promise<string>((r) => {
        finish = r;
      }),
  );
  h.rt.key(key("F8", "F8", { ctrlKey: false }));
  expect(h.readText).toHaveBeenCalledTimes(1);
  h.replace();
  finish("fixture-only");
  await Promise.resolve();
  expect(h.t.paste).not.toHaveBeenCalled();
});
it("suppresses labels shadowed by a different available command", () => {
  const h = harness([
    {
      id: "override",
      command: "app.openSettings",
      keys: ["Mod+Shift+P"],
      when: "",
      scope: "app",
      enabled: true,
    },
  ]);
  expect(h.rt.label("app.commandPalette")).toBeUndefined();
  expect(h.rt.label("app.openSettings")).toBe("Ctrl+Shift+P");
  h.rt.key(key("P", "KeyP", { shiftKey: true }));
  expect(h.settings).toHaveBeenCalledTimes(1);
});
it("preserves a palette native control's keypress default while guarding repeat and release", () => {
  const h = harness();
  h.rt.openPalette("commands");
  const button = document.createElement("button");
  document.body.append(button);
  button.focus();
  const send = (type: string, repeat = false) => {
    const e = new KeyboardEvent(type, { key: "Enter", code: "Enter", cancelable: true, repeat });
    button.dispatchEvent(e);
    h.rt.key(e);
    return e;
  };
  expect(send("keydown").defaultPrevented).toBe(false);
  expect(send("keypress").defaultPrevented).toBe(false);
  expect(send("keydown", true).defaultPrevented).toBe(true);
  expect(send("keyup").defaultPrevented).toBe(true);
});

it.each(["Escape", "timeout", "mismatch", "blur", "recording", "map", "stale"])(
  "never reads or pastes after a Paste prefix is cancelled by %s",
  async (boundary) => {
    vi.useFakeTimers();
    try {
      const h = pasteHarness(["Control+V", "G"], ["default.paste.terminal.other"]);
      const prefix = key("v", "KeyV");
      h.rt.key(prefix);
      expect(prefix.defaultPrevented).toBe(true);
      expect(h.rt.chords.pending).toBeDefined();
      h.rt.key(new KeyboardEvent("keyup", { key: "v", code: "KeyV" }));
      if (boundary === "Escape") h.rt.key(key("Escape", "Escape", { ctrlKey: false }));
      if (boundary === "timeout") vi.advanceTimersByTime(1000);
      if (boundary === "mismatch") h.rt.key(key("x", "KeyX", { ctrlKey: false }));
      if (boundary === "blur") h.rt.blur();
      if (boundary === "recording") h.rt.setRecording(true);
      if (boundary === "map") h.rt.configure(h.config);
      if (boundary === "stale") h.replace();
      h.rt.key(key("g", "KeyG", { ctrlKey: false }));
      await Promise.resolve();
      expect(h.rt.chords.pending).toBeUndefined();
      expect(h.readText).not.toHaveBeenCalled();
      expect(h.t.paste).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  },
);
it("keeps only a completed actual native Paste gesture on its native path", () => {
  const h = pasteHarness(["F8", "Control+V"], ["default.paste.terminal.other"]);
  h.rt.key(key("F8", "F8", { ctrlKey: false }));
  expect(h.rt.chords.pending).toBeDefined();
  const e = key("v", "KeyV");
  h.rt.key(e);
  expect(h.rt.chords.pending).toBeUndefined();
  expect(e.defaultPrevented).toBe(false);
  expect(terminalVerdicts.get(e)).toBe("paste");
  expect(h.readText).not.toHaveBeenCalled();
});
it.each(["held", "replaced"])("refuses async custom Paste into a %s terminal", async (boundary) => {
  const h = pasteHarness(["F8"]);
  let finish!: (text: string) => void;
  h.readText.mockImplementation(
    () =>
      new Promise<string>((r) => {
        finish = r;
      }),
  );
  h.rt.key(key("F8", "F8", { ctrlKey: false }));
  expect(h.readText).toHaveBeenCalledTimes(1);
  if (boundary === "replaced") useExecSessions.setState({ entries: new Map() });
  else h.t.holdInput(true);
  finish("fixture-only");
  await Promise.resolve();
  expect(h.t.paste).not.toHaveBeenCalled();
});
it("reports rejected or unavailable clipboard access without reading for availability", async () => {
  const h = pasteHarness(["F8"]);
  const origin = h.rt.capture();
  h.readText.mockRejectedValue(Error("fixture clipboard denied"));
  expect(h.rt.reason("terminal.paste", origin)).toBeUndefined();
  expect(h.readText).not.toHaveBeenCalled();
  h.rt.key(key("F8", "F8", { ctrlKey: false }));
  await Promise.resolve();
  await Promise.resolve();
  expect(h.rt.getSnapshot().error).toContain("fixture clipboard denied");
  expect(h.t.paste).not.toHaveBeenCalled();
  vi.stubGlobal("navigator", {});
  expect(h.rt.reason("terminal.paste", origin)).toContain("Clipboard reading is unavailable");
  expect(h.rt.invoke("terminal.paste", {}, origin, "keyboard")).toBe(false);
});
it("resolves normalized chord winners with conditions and availability across commands", () => {
  const rules: Rule[] = [
    {
      id: "first",
      command: "app.openSettings",
      keys: ["Control+G", "H"],
      when: "",
      enabled: true,
      scope: "app",
    },
    {
      id: "last",
      command: "manifest.review",
      keys: ["Mod+G", "[KeyH]"],
      when: "focus == 'editor'",
      enabled: true,
      scope: "app",
    },
  ];
  const h = harness(rules);
  expect(h.rt.label("app.openSettings")).toBeUndefined();
  expect(h.rt.label("manifest.review")).toBe("Ctrl+G H");
  h.rt.key(key("g", "KeyG"));
  h.rt.key(key("h", "KeyH", { ctrlKey: false }));
  expect(h.review).toHaveBeenCalledTimes(1);
  expect(h.settings).not.toHaveBeenCalled();
  h.unregister();
  h.rt.blur();
  expect(h.rt.label("app.openSettings")).toBe("Ctrl+G H");
});
it("keeps Exec menu labels tied to the supplied terminal capture after DOM focus moves", () => {
  const h = pasteHarness(["F8"]),
    origin = h.rt.capture(),
    context = h.rt.context(origin);
  const button = document.createElement("button");
  document.body.append(button);
  button.focus();
  h.rt.configure({
    ...h.config,
    map: compileKeymap(
      {
        ...emptyDocument,
        rules: [
          {
            id: "override",
            command: "terminal.clear",
            keys: ["Control+V"],
            scope: "terminal",
            when: "",
            enabled: true,
          },
        ],
      },
      "linux",
    ),
  });
  expect(h.rt.labelFor("terminal.paste", context, origin)).toBe("Ctrl+Shift+V");
  expect(h.rt.labelFor("terminal.clear", context, origin)).toBe("Ctrl+V");
});

it("publishes context changes so labels recover after a palette exit releases its modal", () => {
  const h = harness();
  h.rt.configure({ ...h.config, modalCount: 1 });
  expect(h.rt.label("app.commandPalette")).toBeUndefined();
  const changed = vi.fn<() => void>();
  const off = h.rt.subscribe(changed);
  h.rt.configure(h.config);
  expect(changed).toHaveBeenCalledTimes(1);
  expect(h.rt.label("app.commandPalette")).toBe("Ctrl+Shift+P");
  off();
});

it.each([
  {
    platform: "mac",
    keys: ["Meta+V"],
    ctrlKey: false,
    metaKey: true,
    shiftKey: false,
    native: true,
  },
  {
    platform: "mac",
    keys: ["Meta+Shift+V"],
    ctrlKey: false,
    metaKey: true,
    shiftKey: true,
    native: false,
  },
  {
    platform: "linux",
    keys: ["Control+V"],
    ctrlKey: true,
    metaKey: false,
    shiftKey: false,
    native: true,
  },
  {
    platform: "linux",
    keys: ["Control+Shift+V"],
    ctrlKey: true,
    metaKey: false,
    shiftKey: true,
    native: true,
  },
  {
    platform: "windows",
    keys: ["Control+V"],
    ctrlKey: true,
    metaKey: false,
    shiftKey: false,
    native: true,
  },
  {
    platform: "windows",
    keys: ["Control+Shift+V"],
    ctrlKey: true,
    metaKey: false,
    shiftKey: true,
    native: true,
  },
] as const)(
  "respects completed $platform $keys Paste gesture policy",
  async ({ platform, keys, native, ...modifiers }) => {
    const h = pasteHarness(["F8"]);
    h.rt.configure({
      ...h.config,
      platform,
      map: compileKeymap(
        {
          ...emptyDocument,
          rules: [
            {
              id: "paste",
              command: "terminal.paste",
              keys: [...keys],
              when: "",
              scope: "terminal",
              enabled: true,
            },
          ],
        },
        platform,
      ),
    });
    const event = key("v", "KeyV", modifiers);
    h.rt.key(event);
    await Promise.resolve();
    expect(event.defaultPrevented).toBe(!native);
    expect(terminalVerdicts.get(event)).toBe(native ? "paste" : "handled");
    expect(h.readText).toHaveBeenCalledTimes(native ? 0 : 1);
  },
);

it.each([
  { logical: "F8", physical: "[F8]", key: "F8", code: "F8" },
  { logical: "8", physical: "[Digit8]", key: "8", code: "Digit8" },
  { logical: "/", physical: "[Slash]", key: "/", code: "Slash" },
])(
  "resolves logical $logical and physical $physical presentation through the same matcher",
  ({ logical, physical, key: letter, code }) => {
    const h = harness([
      {
        id: "logical",
        command: "app.openSettings",
        keys: [logical],
        when: "",
        scope: "app",
        enabled: true,
      },
      {
        id: "physical",
        command: "appearance.setTheme",
        keys: [physical],
        when: "",
        scope: "app",
        enabled: true,
        args: { theme: "dark" },
      },
    ]);
    expect(h.rt.label("app.openSettings")).toBeUndefined();
    h.rt.key(key(letter, code, { ctrlKey: false }));
    expect(h.preference).toHaveBeenCalledExactlyOnceWith("theme", "dark");
    expect(h.settings).not.toHaveBeenCalled();
  },
);

it.each(["open", "dispatch", "arguments", "missing"])(
  "refuses recorder palette opening via %s",
  (path) => {
    const h = harness();
    h.rt.setRecording(true);
    if (path === "open") h.rt.openPalette("commands");
    if (path === "dispatch") h.rt.dispatch("app.commandPalette", {});
    if (path === "arguments") h.rt.editArguments("appearance.setTheme", h.rt.capture());
    if (path === "missing") h.rt.invoke("appearance.setTheme", {}, h.rt.capture(), "keyboard");
    expect(h.rt.getSnapshot().palette).toBeUndefined();
    expect(h.rt.getSnapshot().error).toContain("Stop or cancel shortcut recording");
    expect(h.rt.getSnapshot().recording).toBe(true);
  },
);
it.each(["mac", "linux", "windows"] as const)(
  "preserves %s non-Latin native Paste fallback",
  (platform) => {
    const h = pasteHarness(["F8"]);
    vi.stubGlobal("navigator", {});
    h.rt.configure({ ...h.config, platform, map: compileKeymap(emptyDocument, platform) });
    const e = key("м", "KeyV", { ctrlKey: platform !== "mac", metaKey: platform === "mac" });
    h.rt.key(e);
    expect(e.defaultPrevented).toBe(false);
    expect(terminalVerdicts.get(e)).toBe("paste");
    expect(h.t.paste).not.toHaveBeenCalled();
  },
);
it.each([false, true])(
  "uses the actual physical Paste completion before selecting a competitor (chord=%s)",
  (chord) => {
    const h = pasteHarness(["F8"]);
    vi.stubGlobal("navigator", {});
    const rules: Rule[] = [
      {
        id: "clear",
        command: "terminal.clear",
        keys: chord ? ["F9", "Control+V"] : ["Control+V"],
        when: "",
        enabled: true,
        scope: "terminal",
      },
      {
        id: "paste",
        command: "terminal.paste",
        keys: chord ? ["F9", "Control+[KeyB]"] : ["Control+[KeyB]"],
        when: "",
        enabled: true,
        scope: "terminal",
      },
    ];
    h.rt.configure({ ...h.config, map: compileKeymap({ ...emptyDocument, rules }, "linux") });
    const prefix = key("F9", "F9", { ctrlKey: false });
    if (chord) h.rt.key(prefix);
    expect(prefix.defaultPrevented).toBe(chord);
    expect(!!h.rt.chords.pending).toBe(chord);
    const e = key("v", "KeyB");
    h.rt.key(e);
    expect(h.t.clear).not.toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(false);
    expect(terminalVerdicts.get(e)).toBe("paste");
  },
);
it.each([false, true])(
  "leaves an unavailable actual custom Paste completion unconsumed (chord=%s)",
  (chord) => {
    const h = pasteHarness(chord ? ["F9", "Control+[KeyV]"] : ["Control+[KeyV]"]);
    vi.stubGlobal("navigator", {});
    const prefix = key("F9", "F9", { ctrlKey: false });
    if (chord) h.rt.key(prefix);
    expect(prefix.defaultPrevented).toBe(chord);
    expect(!!h.rt.chords.pending).toBe(chord);
    const e = key("b", "KeyV");
    h.rt.key(e);
    expect(e.defaultPrevented).toBe(false);
    expect(terminalVerdicts.get(e)).toBeUndefined();
    expect(h.t.paste).not.toHaveBeenCalled();
  },
);
it.each([
  ["!", "Shift+[Digit1]", "!", "Digit1"],
  ["?", "Shift+[Slash]", "?", "Slash"],
])(
  "does not advertise a possible shifted %s loser as effective",
  (logical, physical, glyph, code) => {
    for (const position of ["single", "first", "second"]) {
      const sequence = (stroke: string) =>
        position === "single" ? [stroke] : position === "first" ? [stroke, "H"] : ["G", stroke];
      const h = harness([
        {
          id: "logical",
          command: "app.openSettings",
          keys: sequence(logical),
          when: "",
          scope: "app",
          enabled: true,
        },
        {
          id: "physical",
          command: "appearance.setTheme",
          keys: sequence(physical),
          when: "",
          scope: "app",
          enabled: true,
          args: { theme: "dark" },
        },
      ]);
      if (position === "second") h.rt.key(key("g", "KeyG", { ctrlKey: false }));
      h.rt.key(key(glyph, code, { ctrlKey: false, shiftKey: true }));
      if (position === "first") h.rt.key(key("h", "KeyH", { ctrlKey: false }));
      expect(h.preference).toHaveBeenCalledExactlyOnceWith("theme", "dark");
      expect(h.settings).not.toHaveBeenCalled();
      expect(h.rt.label("app.openSettings")).toBeUndefined();
      h.rt.blur();
    }
  },
);

it.each([false, true])(
  "dispatches a custom physical Paste using only the completed actual event (chord=%s)",
  async (chord) => {
    const h = pasteHarness(chord ? ["F9", "Control+[KeyV]"] : ["Control+[KeyV]"]);
    const prefix = key("F9", "F9", { ctrlKey: false });
    if (chord) h.rt.key(prefix);
    expect(prefix.defaultPrevented).toBe(chord);
    expect(h.readText).not.toHaveBeenCalled();
    const e = key("b", "KeyV");
    h.rt.key(e);
    expect(e.defaultPrevented).toBe(true);
    expect(h.readText).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    expect(h.t.paste).toHaveBeenCalledTimes(1);
  },
);
it.each([false, true])(
  "chooses the available competitor when actual custom Paste is unavailable (chord=%s)",
  (chord) => {
    const h = pasteHarness(["F8"]);
    vi.stubGlobal("navigator", {});
    const keys = chord ? ["F9", "Control+[KeyV]"] : ["Control+[KeyV]"];
    const rules: Rule[] = [
      { id: "clear", command: "terminal.clear", keys, when: "", enabled: true, scope: "terminal" },
      { id: "paste", command: "terminal.paste", keys, when: "", enabled: true, scope: "terminal" },
    ];
    h.rt.configure({ ...h.config, map: compileKeymap({ ...emptyDocument, rules }, "linux") });
    if (chord) h.rt.key(key("F9", "F9", { ctrlKey: false }));
    const e = key("b", "KeyV");
    h.rt.key(e);
    expect(h.t.clear).toHaveBeenCalledTimes(1);
    expect(e.defaultPrevented).toBe(true);
    expect(h.readText).not.toHaveBeenCalled();
  },
);
it.each(["mac", "linux", "windows"] as const)(
  "never grants %s native Paste for excluded modifier/composition input",
  (platform) => {
    for (const patch of [
      { altKey: true },
      { isComposing: true },
      { keyCode: 229 },
      { getModifierState: (name: string) => name === "AltGraph" },
    ]) {
      const h = pasteHarness(["F8"]);
      vi.stubGlobal("navigator", {});
      h.rt.configure({ ...h.config, platform, map: compileKeymap(emptyDocument, platform) });
      const e = key("м", "KeyV", {
        ctrlKey: platform !== "mac",
        metaKey: platform === "mac",
        ...patch,
      });
      if ("getModifierState" in patch)
        Object.defineProperty(e, "getModifierState", { value: patch.getModifierState });
      h.rt.key(e);
      expect(e.defaultPrevented).toBe(false);
      expect(terminalVerdicts.get(e)).toBeUndefined();
      expect(h.t.paste).not.toHaveBeenCalled();
    }
  },
);
it.each(["commands", "resources"] as const)(
  "refuses direct recorder %s mode without losing ownership",
  (mode) => {
    const h = harness();
    h.rt.setRecording(true);
    h.rt.openPalette(mode);
    expect(h.rt.getSnapshot().palette).toBeUndefined();
    expect(h.rt.getSnapshot().error).toContain("Stop or cancel shortcut recording");
    expect(h.rt.getSnapshot().recording).toBe(true);
  },
);

it.each([false, true])(
  "keeps partial physical Paste availability out of definite labels (chord=%s)",
  (chord) => {
    const h = pasteHarness(["F8"]);
    vi.stubGlobal("navigator", {});
    const keys = chord ? ["F10", "Control+[KeyB]"] : ["Control+[KeyB]"];
    const clear: Rule = {
      id: "clear",
      command: "terminal.clear",
      keys,
      when: "",
      scope: "terminal",
      enabled: true,
    };
    const paste: Rule = { ...clear, id: "paste", command: "terminal.paste" };
    const map = compileKeymap({ ...emptyDocument, rules: [clear, paste] }, "linux");
    h.rt.configure({ ...h.config, map });
    const origin = h.rt.capture();
    expect(h.rt.label("terminal.paste", origin)).toBe("Ctrl+Shift+V");
    expect(h.rt.resolveRule(map.rules.at(-1)!, map, origin)).toMatchObject({ partial: true });
    expect(h.rt.label("terminal.clear", origin)).toBeUndefined();
    if (chord) h.rt.key(key("F10", "F10", { ctrlKey: false }));
    h.rt.key(key("b", "KeyB"));
    expect(h.t.clear).toHaveBeenCalledOnce();
    expect(h.t.paste).not.toHaveBeenCalled();
    h.rt.blur();
    // A complete read API makes the same class definite; rejection stays execution-owned.
    vi.stubGlobal("navigator", { clipboard: { readText: h.readText } });
    expect(h.rt.label("terminal.paste", origin)).toBe(chord ? "F10 Ctrl+B" : "Ctrl+B");
    expect(h.rt.winnerFor(map.rules.at(-2)!, map, origin)).toBe(map.rules.at(-1));
    vi.stubGlobal("navigator", {});
    const later = compileKeymap(
      { ...emptyDocument, rules: [paste, { ...clear, id: "last" }] },
      "linux",
    );
    expect(h.rt.resolveRule(later.rules.at(-2)!, later, origin).winner?.id).toBe("last");
  },
);
