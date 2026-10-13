// @vitest-environment jsdom
import { EngineProvider } from "@hukube/engine-client/react";
import type { EngineClient, ResourceAccess } from "@hukube/engine-client";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { useResourceAccess } from "./use-access.ts";
const ref = { cluster: "c", type: "configmaps", namespace: "ns", name: "web" };
afterEach(cleanup);
it("asks once after the first Manifest and keeps the access reason", async () => {
  const access: ResourceAccess = {
    exec: { allowed: false },
    edit: { allowed: false, reason: "The Engine is read-only." },
    delete: { allowed: false, reason: "Not permitted" },
  };
  const request = vi.fn<EngineClient["request"]>(() => Promise.resolve(access));
  const client = { request } as unknown as EngineClient;
  const wrapper = ({ children }: { children: ReactNode }) => (
    <EngineProvider client={client}>{children}</EngineProvider>
  );
  const hook = renderHook(({ arrived }) => useResourceAccess(ref, arrived), {
    initialProps: { arrived: false },
    wrapper,
  });
  expect(request).not.toHaveBeenCalled();
  hook.rerender({ arrived: true });
  await waitFor(() => expect(hook.result.current).toEqual(access));
  hook.rerender({ arrived: true });
  expect(request).toHaveBeenCalledOnce();
});
it("aborts access when the tab closes and treats an access failure as indeterminate", async () => {
  const request = vi.fn<EngineClient["request"]>(() => Promise.reject(new Error("unavailable")));
  const client = { request } as unknown as EngineClient;
  const wrapper = ({ children }: { children: ReactNode }) => (
    <EngineProvider client={client}>{children}</EngineProvider>
  );
  const hook = renderHook(() => useResourceAccess(ref, true), { wrapper });
  const signal = request.mock.calls[0]?.[2]?.signal;
  hook.unmount();
  expect(signal?.aborted).toBe(true);
  const retry = renderHook(() => useResourceAccess(ref, true), { wrapper });
  await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
  expect(retry.result.current).toBeUndefined();
});
