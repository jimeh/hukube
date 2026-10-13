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
  const group = { panels: [previous] };
  const addPanel = vi.fn<() => void>();
  const getPanel = vi.fn<() => typeof previous | undefined>();
  const api = { activeGroup: group, groups: [group], getPanel, addPanel } as unknown as DockviewApi;
  return { api, previous, addPanel, getPanel };
}

const options = {
  id: "list:configmaps",
  component: "list" as const,
  title: "configmaps",
  params: { type: "configmaps", preview: true },
  preview: true,
};

describe("openPanel Preview Tab params", () => {
  it("lets the caller derive params from the replaced Preview Tab for any component", () => {
    const d = dock();
    const derive = vi.fn<
      (
        params: typeof options.params,
        previous: unknown,
      ) => typeof options.params & { inheritedType: string }
    >((params, previous) => ({ ...params, inheritedType: (previous as { type: string }).type }));
    openPanel(d.api, { ...options, replacePreviewParams: derive });
    expect(derive).toHaveBeenCalledWith(options.params, d.previous.params);
    expect(d.addPanel).toHaveBeenCalledWith(
      expect.objectContaining({
        params: { type: "configmaps", inheritedType: "pods", preview: true },
      }),
    );
    expect(d.previous.api.close).toHaveBeenCalledOnce();
  });
  it("keeps the supplied params without a derivation rule", () => {
    const d = dock();
    openPanel(d.api, options);
    expect(d.addPanel).toHaveBeenCalledWith(expect.objectContaining({ params: options.params }));
  });
  it("does not derive params when there is no Preview Tab to replace", () => {
    const d = dock(false);
    const derive =
      vi.fn<(params: typeof options.params, previous: unknown) => typeof options.params>();
    openPanel(d.api, { ...options, replacePreviewParams: derive });
    expect(derive).not.toHaveBeenCalled();
    expect(d.previous.api.close).not.toHaveBeenCalled();
    expect(d.addPanel).toHaveBeenCalledWith(expect.objectContaining({ params: options.params }));
  });
  it("focuses an existing panel without deriving or replacing its params", () => {
    const d = dock();
    d.getPanel.mockReturnValue(d.previous);
    const derive =
      vi.fn<(params: typeof options.params, previous: unknown) => typeof options.params>();
    openPanel(d.api, { ...options, replacePreviewParams: derive });
    expect(d.previous.api.setActive).toHaveBeenCalledOnce();
    expect(derive).not.toHaveBeenCalled();
    expect(d.addPanel).not.toHaveBeenCalled();
    expect(d.previous.api.close).not.toHaveBeenCalled();
  });
});
