// @vitest-environment jsdom

import type { ConnectionState, EngineClient, Setting, SettingPut } from "@hukube/engine-client";
import { EngineRequestError } from "@hukube/engine-client";
import { EngineProvider } from "@hukube/engine-client/react";
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, expect, it } from "vitest";

import { useOpenClusters } from "@/features/clusters/open-clusters.ts";

import { SettingsPage, type SettingsCategory } from "./settings-page.tsx";

interface PreferenceHarness {
  client: EngineClient;
  puts: SettingPut[];
  value(): unknown;
  conflictNextPut(value: unknown): void;
}

function preferenceHarness(
  initial: unknown = { version: 1 },
  connection: ConnectionState = "open",
): PreferenceHarness {
  let value = initial;
  let revisionNumber = 1;
  let revision = "r1";
  let conflictingValue: unknown;
  let hasConflictingValue = false;
  const puts: SettingPut[] = [];
  const watches: {
    closed: boolean;
    key: string;
    listener: { data(setting: Setting): void };
  }[] = [];
  const publish = (key: string, next: unknown) => {
    if (key === "app/preferences") {
      value = next;
      revision = `r${++revisionNumber}`;
    }
    for (const watch of watches)
      if (!watch.closed && watch.key === key)
        watch.listener.data({
          key,
          value: key === "app/preferences" ? value : null,
          revision: key === "app/preferences" ? revision : "",
        });
  };
  const client = {
    subscribe: (
      _method: string,
      params: { key: string },
      listener: { data(setting: Setting): void },
    ) => {
      const watch = { closed: false, key: params.key, listener };
      watches.push(watch);
      queueMicrotask(() => {
        if (!watch.closed)
          listener.data({
            key: params.key,
            value: params.key === "app/preferences" ? value : null,
            revision: params.key === "app/preferences" ? revision : "",
          });
      });
      return {
        update: () => {},
        close: () => {
          watch.closed = true;
        },
      };
    },
    request: async (_method: string, params: SettingPut) => {
      puts.push(params);
      if (hasConflictingValue) {
        const next = conflictingValue;
        hasConflictingValue = false;
        publish(params.key, next);
      }
      if (params.ifRevision !== revision)
        throw new EngineRequestError({ code: "conflict", message: "changed" });
      publish(params.key, params.value);
      return undefined;
    },
    getState: () => connection,
    onStateChange: () => () => {},
    openStream: () => {
      throw new Error("unexpected stream");
    },
    close: () => {},
  } as unknown as EngineClient;
  return {
    client,
    puts,
    value: () => value,
    conflictNextPut: (next) => {
      conflictingValue = next;
      hasConflictingValue = true;
    },
  };
}

async function mountPage(
  category: SettingsCategory,
  initial: unknown = { version: 1 },
  fromCluster?: string,
  connection: ConnectionState = "open",
) {
  const harness = preferenceHarness(initial, connection);
  let showCategory: ((category: SettingsCategory) => void) | undefined;
  const root = createRootRoute({ component: Outlet });
  const index = createRoute({ getParentRoute: () => root, path: "/", component: () => null });
  const settings = createRoute({
    getParentRoute: () => root,
    path: "/settings",
    component: function SettingsHarness() {
      const [activeCategory, setActiveCategory] = useState(category);
      showCategory = setActiveCategory;
      return <SettingsPage category={activeCategory} fromCluster={fromCluster} />;
    },
  });
  const router = createRouter({
    routeTree: root.addChildren([index, settings]),
    history: createMemoryHistory({ initialEntries: ["/settings"] }),
  });
  await router.load();
  render(
    <EngineProvider client={harness.client}>
      <RouterProvider router={router} />
    </EngineProvider>,
  );
  await act(async () => {});
  return {
    ...harness,
    showCategory: async (next: SettingsCategory) => {
      await act(async () => showCategory?.(next));
    },
  };
}

beforeEach(() => {
  window.scrollTo = () => {};
  localStorage.clear();
  sessionStorage.clear();
  useOpenClusters.setState({ ids: [] });
});

afterEach(() => cleanup());

it("works without a Cluster and saves and resets the Engine-shared theme after read-back", async () => {
  const h = await mountPage("appearance");
  expect(screen.getByRole("heading", { level: 1, name: "Settings" })).toBeDefined();
  expect(screen.getByRole("heading", { level: 2, name: "Appearance" })).toBeDefined();
  expect(screen.getByRole("button", { name: "Back to clusters" })).toBeDefined();
  expect(screen.getByRole("link", { name: "Appearance" }).getAttribute("aria-current")).toBe(
    "page",
  );
  expect(screen.getByLabelText("Category")).toBeDefined();

  fireEvent.click(screen.getByRole("radio", { name: "Light" }));
  await act(async () => {});
  expect(h.value()).toEqual({ version: 1, appearance: { theme: "light" } });
  expect(screen.getByText("Theme: Saved")).toBeDefined();
  expect(document.documentElement.classList.contains("dark")).toBe(false);

  fireEvent.click(screen.getByRole("button", { name: "Reset section" }));
  await act(async () => {});
  expect(h.value()).toEqual({ version: 1 });
  expect(screen.getByRole("radio", { name: "Dark" }).hasAttribute("checked")).toBe(true);
});

it("explains an unavailable Engine while keeping last-known preferences visible", async () => {
  await mountPage(
    "appearance",
    { version: 1, appearance: { theme: "light" } },
    undefined,
    "reconnecting",
  );
  expect(screen.getByRole("alert").textContent).toContain("Connection to the Engine lost");
  expect(screen.getByRole("alert").textContent).toContain("Last-known preferences remain active");
  expect(screen.getByRole("radio", { name: "Light" }).matches(":checked")).toBe(true);
});

it("preserves invalid numeric drafts, sends no request, confirms reductions, and ignores Escape", async () => {
  const h = await mountPage("logs");
  const lines = screen.getByRole("textbox", { name: /Retained lines/ });
  const apply = screen.getByRole("button", { name: /^Apply$/ });
  fireEvent.change(lines, { target: { value: "" } });
  expect(lines.getAttribute("value")).toBe("");
  expect(screen.getByText(/base-10 whole number/)).toBeDefined();
  expect(apply.hasAttribute("disabled")).toBe(true);
  expect(h.puts).toHaveLength(0);

  fireEvent.change(lines, { target: { value: "10" } });
  expect(apply.hasAttribute("disabled")).toBe(false);
  apply.focus();
  fireEvent.click(apply);
  let dialog = screen.getByRole("alertdialog", { name: "Reduce retained Log Stream entries?" });
  expect(within(dialog).getByText(/cannot be restored/)).toBeDefined();
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  expect(document.activeElement).toBe(apply);
  fireEvent.click(apply);
  dialog = screen.getByRole("alertdialog", { name: "Reduce retained Log Stream entries?" });
  fireEvent.click(within(dialog).getByRole("button", { name: "Apply lower limits" }));
  await act(async () => {});
  expect(h.value()).toEqual({ version: 1, logStreams: { maxLines: 10 } });
  expect(screen.getByText("Retained lines: Saved")).toBeDefined();

  fireEvent.change(lines, { target: { value: "0" } });
  expect(screen.queryByText("Retained lines: Saved")).toBeNull();
  expect(screen.queryByText("Unsaved changes")).toBeNull();
  expect(apply.hasAttribute("disabled")).toBe(true);

  fireEvent.change(lines, { target: { value: "10" } });
  expect(screen.getByText("Retained lines: Saved")).toBeDefined();
  expect(apply.hasAttribute("disabled")).toBe(true);

  fireEvent.change(lines, { target: { value: "20" } });
  expect(screen.getByText("Unsaved changes")).toBeDefined();
  fireEvent.keyDown(lines, { key: "Escape" });
  expect(lines.getAttribute("value")).toBe("20");
  expect(screen.getByText("Unsaved changes")).toBeDefined();
  expect(
    screen.getByText(
      /Monaco styled ranges, including ANSI styles, timestamps, origins, and notices\/markers/,
    ),
  ).toBeDefined();
});

it("keeps unapplied retention drafts while switching Settings categories", async () => {
  const h = await mountPage("logs");
  fireEvent.change(screen.getByRole("textbox", { name: /Retained lines/ }), {
    target: { value: "60000" },
  });
  expect(screen.getByText("Unsaved changes")).toBeDefined();

  await h.showCategory("appearance");
  expect(screen.getByRole("heading", { level: 2, name: "Appearance" })).toBeDefined();
  await h.showCategory("logs");

  expect(screen.getByRole("textbox", { name: /Retained lines/ }).getAttribute("value")).toBe(
    "60000",
  );
  expect(screen.getByText("Unsaved changes")).toBeDefined();
  expect(h.puts).toHaveLength(0);
});

it("finishes a stale retention retry as Saved without leaving confirmed drafts dirty", async () => {
  const h = await mountPage("logs");
  const lines = screen.getByRole("textbox", { name: /Retained lines/ });
  const apply = screen.getByRole("button", { name: /^Apply$/ });
  fireEvent.change(lines, { target: { value: "60000" } });
  h.conflictNextPut({ version: 1, logStreams: { maxLines: 55_000 } });

  fireEvent.click(apply);
  await screen.findByText(/Not saved: changed in another window/);
  expect(lines.getAttribute("value")).toBe("60000");

  fireEvent.click(screen.getByRole("button", { name: "Retry with my value" }));
  await screen.findByText("Retained lines: Saved");
  expect(h.value()).toEqual({ version: 1, logStreams: { maxLines: 60_000 } });
  expect(lines.getAttribute("value")).toBe("60000");
  expect(apply.hasAttribute("disabled")).toBe(true);
  expect(screen.queryByText("Unsaved changes")).toBeNull();
});

it("confirms a stale retry from its retained change after the visible draft changes", async () => {
  const h = await mountPage("logs");
  const lines = screen.getByRole("textbox", { name: /Retained lines/ });
  fireEvent.change(lines, { target: { value: "60000" } });
  h.conflictNextPut({ version: 1, logStreams: { maxLines: 65_000 } });

  fireEvent.click(screen.getByRole("button", { name: /^Apply$/ }));
  await screen.findByText(/Not saved: changed in another window/);
  fireEvent.change(lines, { target: { value: "70000" } });
  fireEvent.click(screen.getByRole("button", { name: "Retry with my value" }));

  const dialog = screen.getByRole("alertdialog", {
    name: "Reduce retained Log Stream entries?",
  });
  expect(h.value()).toEqual({ version: 1, logStreams: { maxLines: 65_000 } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Apply lower limits" }));
  await act(async () => {});
  expect(h.value()).toEqual({ version: 1, logStreams: { maxLines: 60_000 } });
  expect(lines.getAttribute("value")).toBe("70000");
  expect(screen.getByText("Unsaved changes")).toBeDefined();
});

it("confirms a conflicted Reset from its retained defaults after the visible draft changes", async () => {
  const h = await mountPage("logs", {
    version: 1,
    logStreams: { maxLines: 80_000 },
  });
  const lines = screen.getByRole("textbox", { name: /Retained lines/ });
  h.conflictNextPut({ version: 1, logStreams: { maxLines: 70_000 } });

  fireEvent.click(screen.getAllByRole("button", { name: "Reset section" })[0]!);
  let dialog = screen.getByRole("alertdialog", { name: "Reduce retained Log Stream entries?" });
  fireEvent.click(within(dialog).getByRole("button", { name: "Apply lower limits" }));
  await screen.findByText(/Not saved: changed in another window/);
  fireEvent.change(lines, { target: { value: "90000" } });
  fireEvent.click(screen.getByRole("button", { name: "Retry with my value" }));

  dialog = screen.getByRole("alertdialog", { name: "Reduce retained Log Stream entries?" });
  expect(h.value()).toEqual({ version: 1, logStreams: { maxLines: 70_000 } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Apply lower limits" }));
  await act(async () => {});
  expect(h.value()).toEqual({ version: 1 });
  expect(lines.getAttribute("value")).toBe("90000");
  expect(screen.getByText("Unsaved changes")).toBeDefined();
});

it("uses labelled display controls and persists their shared defaults", async () => {
  const h = await mountPage("logs");
  const wrap = screen.getByRole("checkbox", { name: "Wrap long lines" });
  const timestamps = screen.getByRole("checkbox", { name: "Show timestamps" });
  expect(wrap.getAttribute("data-checked")).not.toBeNull();
  expect(timestamps.getAttribute("data-checked")).toBeNull();
  fireEvent.click(wrap);
  fireEvent.click(timestamps);
  await act(async () => {});
  expect(h.value()).toEqual({
    version: 1,
    logStreams: { wrap: false, timestamps: true },
  });
  expect(screen.getByText("Wrap, Timestamps: Saved")).toBeDefined();
});

it("confirms a Reset that lowers an effective retention budget", async () => {
  const h = await mountPage("logs", {
    version: 1,
    logStreams: { maxLines: 80_000, maxCharacters: 1_000_000 },
  });
  const lines = screen.getByRole("textbox", { name: /Retained lines/ });
  fireEvent.change(lines, { target: { value: "70000" } });
  fireEvent.click(screen.getAllByRole("button", { name: "Reset section" })[0]!);
  const dialog = screen.getByRole("alertdialog", { name: "Reduce retained Log Stream entries?" });
  expect(h.puts).toHaveLength(0);
  fireEvent.click(within(dialog).getByRole("button", { name: "Apply lower limits" }));
  await act(async () => {});
  expect(h.value()).toEqual({ version: 1 });
  expect(lines.getAttribute("value")).toBe("50000");
  expect(
    screen.getByText(/Retained lines, Retained characters, Styled ranges: Saved/),
  ).toBeDefined();
});

it("repairs an invalid stored budget with its effective default without resetting siblings", async () => {
  const h = await mountPage("logs", {
    version: 1,
    logStreams: { maxLines: 0, maxCharacters: 1_000_000 },
  });
  const lines = screen.getByRole("textbox", { name: /Retained lines/ });
  const characters = screen.getByRole("textbox", { name: /Retained characters/ });
  const apply = screen.getByRole("button", { name: /^Apply$/ });
  expect(lines.getAttribute("value")).toBe("50000");
  expect(lines.getAttribute("aria-invalid")).toBe("true");
  expect(characters.getAttribute("value")).toBe("1000000");

  fireEvent.change(lines, { target: { value: "" } });
  fireEvent.change(lines, { target: { value: "50000" } });
  expect(screen.getByText("Unsaved changes")).toBeDefined();
  expect(apply.hasAttribute("disabled")).toBe(false);
  fireEvent.click(apply);
  await screen.findByText("Retained lines: Saved");

  expect(h.value()).toEqual({
    version: 1,
    logStreams: { maxLines: 50_000, maxCharacters: 1_000_000 },
  });
  expect(lines.getAttribute("aria-invalid")).toBe("false");
  expect(characters.getAttribute("value")).toBe("1000000");
});

it("requires explicit confirmation before replacing a malformed preference document", async () => {
  const h = await mountPage("appearance", { version: 2, future: "keep" });
  expect(screen.getByRole("alert").textContent).toContain("cannot be read");
  expect(screen.getByRole("radio", { name: "Light" }).matches(":disabled")).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Replace stored preferences" }));
  const dialog = screen.getByRole("alertdialog", { name: "Replace stored app preferences?" });
  fireEvent.click(within(dialog).getByRole("button", { name: "Replace stored preferences" }));
  await act(async () => {});
  expect(h.value()).toEqual({ version: 1 });
  expect(screen.getByText("Stored preferences replaced")).toBeDefined();
});

it("returns to the originating Workspace only while its Cluster tab remains open", async () => {
  useOpenClusters.setState({ ids: ["dev"] });
  await mountPage("appearance", { version: 1 }, "dev");
  expect(screen.getByRole("button", { name: "Back to dev" })).toBeDefined();
  cleanup();
  useOpenClusters.setState({ ids: [] });
  await mountPage("appearance", { version: 1 }, "dev");
  expect(screen.getByRole("button", { name: "Back to clusters" })).toBeDefined();
});
