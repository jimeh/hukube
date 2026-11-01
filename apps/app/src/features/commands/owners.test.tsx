// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { StrictMode, useLayoutEffect, useRef, useSyncExternalStore } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { DockviewApi, IDockviewPanel } from "dockview-react";
import type { WorkspaceValue } from "../workspace/workspace-context.tsx";
import { useCommandSurface } from "./owners.ts";
import { commands, type Surface } from "./runtime.ts";
import { compileKeymap, emptyDocument } from "./keyboard.ts";

const offs: (() => void)[] = [];
const config = {
  route: "/c/c",
  platform: "linux" as const,
  host: "web" as const,
  connection: "open",
  modalCount: 0,
  map: compileKeymap(emptyDocument, "linux"),
  preferencesReady: () => true,
  preference: () => {},
  settings: () => {},
};
beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([{}] as unknown as DOMRectList);
  commands.configure(config);
});
afterEach(() => {
  commands.closePalette(false);
  cleanup();
  for (const off of offs.splice(0)) off();
  commands.blur();
  vi.restoreAllMocks();
});

function Owner({
  kind,
  reason = "No changes",
  uid = "one",
  review = () => {},
  mounted = true,
  generation = 0,
}: {
  kind: ReturnType<Surface["read"]>["kind"];
  reason?: string;
  uid?: string;
  review?: () => void;
  mounted?: boolean;
  generation?: number;
}) {
  const element = useRef<HTMLTextAreaElement>(null);
  // ExecPanel subscribes to the same runtime that its owner hook refreshes.
  useSyncExternalStore(commands.subscribe, commands.getSnapshot);
  useCommandSurface(element, () => ({ kind, review, reviewReason: reason, uid }));
  return mounted ? <textarea key={generation} aria-label="Owner" ref={element} /> : null;
}
function PaletteObserver({ configuration = config }: { configuration?: typeof config }) {
  const view = useSyncExternalStore(commands.subscribe, commands.getSnapshot);
  // The root configures the runtime after every render, with fresh closures.
  useLayoutEffect(() => commands.configure({ ...configuration }));
  return view.palette ? (
    <>
      <output aria-label="Availability">
        {commands.reason("manifest.review", view.palette.origin) || "Available"}
      </output>
      <output aria-label="Preferences availability">
        {commands.reason("appearance.setTheme", view.palette.origin) || "Available"}
      </output>
      <output aria-label="Target">{view.palette.origin.panel?.api.title}</output>
      <output aria-label="Resource Types">
        {[...(view.palette.origin.workspace?.value.types.keys() ?? [])].join(", ")}
      </output>
      <output aria-label="Settings shortcut">
        {commands.label("app.openSettings", view.palette.origin)}
      </output>
    </>
  ) : null;
}

it.each(["terminal", "editor", "log", "resource"] as const)(
  "opens a palette with a mounted subscribed %s owner and publishes later availability",
  (kind) => {
    const view = render(
      <>
        <Owner kind={kind} />
        <PaletteObserver />
      </>,
    );
    const input = screen.getByRole("textbox", { name: "Owner" });
    input.focus();
    const origin = commands.capture();
    expect(origin.surface).toBeDefined();
    expect(() => act(() => commands.openPalette("commands", origin))).not.toThrow();
    expect(screen.getByLabelText("Availability").textContent).toBe("No changes");
    const published = commands.getSnapshot();
    const review = vi.fn<() => void>();
    view.rerender(
      <>
        <Owner kind={kind} review={review} />
        <PaletteObserver />
      </>,
    );
    expect(commands.getSnapshot()).toBe(published);
    expect(commands.capture(undefined, undefined, input).surface).toBe(origin.surface);
    view.rerender(
      <>
        <Owner kind={kind} review={review} reason="Permission denied" />
        <PaletteObserver />
      </>,
    );
    expect(screen.getByLabelText("Availability").textContent).toBe("Permission denied");
    view.rerender(
      <>
        <Owner kind={kind} review={review} reason="" />
        <PaletteObserver />
      </>,
    );
    expect(screen.getByLabelText("Availability").textContent).toBe("Available");
    act(() => {
      commands.invoke("manifest.review", {}, origin);
    });
    expect(review).toHaveBeenCalledOnce();
  },
);

it("keeps registration live through Strict Mode, late mounting, replacement and unmount", () => {
  const view = render(
    <StrictMode>
      <Owner kind="editor" mounted={false} />
      <PaletteObserver />
    </StrictMode>,
  );
  act(() => commands.openPalette("commands"));
  view.rerender(
    <StrictMode>
      <Owner kind="editor" />
      <PaletteObserver />
    </StrictMode>,
  );
  const input = screen.getByRole("textbox", { name: "Owner" });
  const origin = commands.capture(undefined, undefined, input);
  expect(origin.surface).toBeDefined();
  act(() => {
    commands.closePalette(false);
    commands.openPalette("commands", origin);
  });
  view.rerender(
    <StrictMode>
      <Owner kind="editor" generation={1} />
      <PaletteObserver />
    </StrictMode>,
  );
  expect(screen.getByLabelText("Availability").textContent).toContain("captured target changed");
  expect(commands.valid(origin)).toBe(false);
  view.rerender(
    <StrictMode>
      <Owner kind="editor" mounted={false} />
      <PaletteObserver />
    </StrictMode>,
  );
  expect(commands.capture(undefined, undefined, input).surface).toBeUndefined();
});

it("restores a mounted owner's registration after Strict Mode replays effects", () => {
  render(
    <StrictMode>
      <Owner kind="editor" />
    </StrictMode>,
  );
  expect(commands.capture(undefined, undefined, screen.getByRole("textbox")).surface).toBeDefined();
});

it("refreshes configured preference availability and shortcut labels without render feedback", () => {
  const view = render(
    <>
      <Owner kind="editor" />
      <PaletteObserver />
    </>,
  );
  act(() =>
    commands.openPalette(
      "commands",
      commands.capture(undefined, undefined, screen.getByRole("textbox")),
    ),
  );
  expect(screen.getByLabelText("Preferences availability").textContent).toBe("Available");
  const configuration = {
    ...config,
    preferencesReady: () => false,
    map: compileKeymap(
      {
        ...emptyDocument,
        rules: [
          {
            id: "user.settings",
            command: "app.openSettings",
            keys: ["Mod+Alt+U"],
            when: "",
            scope: "app",
            enabled: true,
          },
        ],
      },
      "linux",
    ),
  };
  view.rerender(
    <>
      <Owner kind="editor" />
      <PaletteObserver configuration={configuration} />
    </>,
  );
  expect(screen.getByLabelText("Preferences availability").textContent).toBe(
    "App preferences are not available.",
  );
  expect(screen.getByLabelText("Settings shortcut").textContent).toContain("U");
  const published = commands.getSnapshot();
  view.rerender(
    <>
      <Owner kind="editor" />
      <PaletteObserver configuration={{ ...configuration }} />
    </>,
  );
  expect(commands.getSnapshot()).toBe(published);
  view.rerender(
    <>
      <Owner kind="editor" />
      <PaletteObserver configuration={{ ...configuration, connection: "outdated" }} />
    </>,
  );
  expect(commands.getSnapshot().palette).toBeUndefined();
});

it("refreshes Workspace title, params, Resource Type choices and removal without replacing its token", () => {
  const panel = {
    id: "p",
    params: {},
    group: {},
    api: { title: "Original" },
  } as unknown as IDockviewPanel;
  const workspace = {
    token: {},
    api: { activePanel: panel, getPanel: () => panel } as unknown as DockviewApi,
    value: { active: true, cluster: "c", types: new Map() } as unknown as WorkspaceValue,
  };
  const off = commands.registerWorkspace("c", workspace);
  offs.push(off);
  render(<PaletteObserver />);
  const origin = commands.capture();
  act(() => commands.openPalette("commands", origin));
  Object.assign(panel.api, { title: "Renamed" });
  act(() => commands.refreshAvailability());
  expect(screen.getByLabelText("Target").textContent).toBe("Renamed");
  workspace.value = {
    ...workspace.value,
    types: new Map([
      [
        "pods",
        {
          key: "pods",
          group: "",
          version: "v1",
          resource: "pods",
          kind: "Pod",
          namespaced: true,
          verbs: ["get", "list"],
          state: "ready",
          count: 0,
        },
      ],
    ]),
  };
  act(() => commands.refreshAvailability());
  expect(screen.getByLabelText("Resource Types").textContent).toBe("pods");
  expect(commands.capture().workspace?.token).toBe(origin.workspace?.token);
  Object.assign(panel, { params: { preview: true } });
  act(() => commands.refreshAvailability());
  expect(screen.getByLabelText("Availability").textContent).toContain("captured target changed");
  act(() => {
    commands.closePalette(false);
    commands.openPalette("resources", commands.capture());
  });
  act(off);
  expect(commands.getSnapshot().palette).toBeUndefined();
});
