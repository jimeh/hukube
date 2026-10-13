import type { DockviewApi } from "dockview-react";
import { describe, expect, it, vi } from "vitest";

import { openPanel } from "./dock.ts";

function dock(preview = true) {
  const previous = {
    params: { type: "pods", preview },
    api: {
      close: vi.fn<() => void>(),
      setActive: vi.fn<() => void>(),
      updateParameters: vi.fn<() => void>(),
    },
  };
  const group = { panels: [previous], activePanel: previous as typeof previous | undefined };
  const addPanel = vi.fn<() => void>();
  const getPanel = vi.fn<(id: string) => typeof previous | undefined>();
  const api = { activeGroup: group, groups: [group], getPanel, addPanel } as unknown as DockviewApi;
  return { api, group, previous, addPanel, getPanel };
}

const options = {
  id: "list:configmaps",
  component: "list" as const,
  title: "configmaps",
  params: { type: "configmaps", preview: true },
  preview: true,
};

describe("openPanel active tab params", () => {
  it.each([true, false])(
    "derives params from the Pane's active tab (preview: %s) for a new pinned tab",
    (preview) => {
      const d = dock(preview);
      const derive = vi.fn<
        (
          params: typeof options.params,
          previous: unknown,
        ) => typeof options.params & { inheritedType: string }
      >((params, previous) => ({ ...params, inheritedType: (previous as { type: string }).type }));
      openPanel(d.api, { ...options, preview: false, deriveActiveTabParams: derive });
      expect(derive).toHaveBeenCalledWith(options.params, d.previous.params);
      expect(d.addPanel).toHaveBeenCalledWith(
        expect.objectContaining({
          params: { type: "configmaps", inheritedType: "pods", preview: false },
        }),
      );
      expect(d.previous.api.close).not.toHaveBeenCalled();
    },
  );
  it("derives from the active tab even when replacing a different, inactive Preview Tab", () => {
    const d = dock();
    const active = { ...d.previous, params: { type: "services", preview: false } };
    d.group.panels.push(active);
    d.group.activePanel = active;
    const derive = vi.fn<
      (
        params: typeof options.params,
        activeParams: unknown,
      ) => typeof options.params & { activeParams: unknown }
    >((params, activeParams) => ({
      ...params,
      activeParams,
    }));
    openPanel(d.api, { ...options, deriveActiveTabParams: derive });
    expect(derive).toHaveBeenCalledWith(options.params, active.params);
    expect(d.addPanel).toHaveBeenCalledWith(
      expect.objectContaining({ params: { ...options.params, activeParams: active.params } }),
    );
    expect(d.previous.api.close).toHaveBeenCalledOnce();
  });
  it("derives from the destination Pane rather than the list the panel opens beside", () => {
    const d = dock(false);
    const sourceGroup = { panels: [] };
    const source = { ...d.previous, group: sourceGroup };
    d.getPanel.mockImplementation((id?: string) => (id === "source" ? source : undefined));
    (d.api as unknown as { groups: unknown[]; activeGroup: unknown }).groups = [
      sourceGroup,
      d.group,
    ];
    (d.api as unknown as { activeGroup: unknown }).activeGroup = sourceGroup;
    const derive = vi.fn<(params: typeof options.params) => typeof options.params>(
      (params) => params,
    );
    openPanel(d.api, { ...options, beside: "source", deriveActiveTabParams: derive });
    expect(derive).toHaveBeenCalledWith(options.params, d.previous.params);
    expect(d.addPanel).toHaveBeenCalledWith(
      expect.objectContaining({ position: { referenceGroup: d.group } }),
    );
  });
  it("keeps the supplied params without a derivation rule", () => {
    const d = dock();
    openPanel(d.api, options);
    expect(d.addPanel).toHaveBeenCalledWith(expect.objectContaining({ params: options.params }));
  });
  it("does not derive params when the Pane has no active tab", () => {
    const d = dock(false);
    d.group.activePanel = undefined;
    const derive =
      vi.fn<(params: typeof options.params, previous: unknown) => typeof options.params>();
    openPanel(d.api, { ...options, deriveActiveTabParams: derive });
    expect(derive).not.toHaveBeenCalled();
    expect(d.previous.api.close).not.toHaveBeenCalled();
    expect(d.addPanel).toHaveBeenCalledWith(expect.objectContaining({ params: options.params }));
  });
  it("focuses an existing panel without deriving or replacing its params", () => {
    const d = dock();
    d.getPanel.mockReturnValue(d.previous);
    const derive =
      vi.fn<(params: typeof options.params, previous: unknown) => typeof options.params>();
    openPanel(d.api, { ...options, deriveActiveTabParams: derive });
    expect(d.previous.api.setActive).toHaveBeenCalledOnce();
    expect(derive).not.toHaveBeenCalled();
    expect(d.addPanel).not.toHaveBeenCalled();
    expect(d.previous.api.close).not.toHaveBeenCalled();
  });
});

it("opens in the named panel's Pane, inherits its active tab, and replaces its preview", () => {
  const d = dock();
  const source = { ...d.previous, group: d.group };
  const other = { panels: [], activePanel: undefined };
  (d.api as unknown as { activeGroup: unknown }).activeGroup = other;
  d.getPanel.mockImplementation((id) => (id === "source" ? source : undefined));
  const derive = vi.fn<(params: typeof options.params, active: unknown) => typeof options.params>(
    (params) => params,
  );
  openPanel(d.api, { ...options, pane: "source", deriveActiveTabParams: derive });
  expect(d.addPanel).toHaveBeenCalledWith(
    expect.objectContaining({ position: { referenceGroup: d.group, index: 0 } }),
  );
  expect(derive).toHaveBeenCalledWith(options.params, d.previous.params);
  expect(d.previous.api.close).toHaveBeenCalledOnce();
});
