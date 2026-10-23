// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";

import type { EngineClient, Subscription, SubscriptionListener } from "./client.ts";
import type { TopicMethod, Topics } from "./methods.gen.ts";
import type { Setting } from "./protocol.gen.ts";
import { EngineProvider, useSubscription } from "./react.tsx";

class FakeEngineClient implements EngineClient {
  openStream: EngineClient["openStream"] = () => {
    throw new Error("unexpected stream");
  };
  subscriptions: { method: TopicMethod; params: unknown }[] = [];
  updates: unknown[] = [];
  listener?: SubscriptionListener<Setting>;

  request: EngineClient["request"] = () => {
    throw new Error("unexpected request");
  };

  subscribe<M extends TopicMethod>(
    method: M,
    params: Topics[M]["params"],
    listener: SubscriptionListener<Topics[M]["data"]>,
  ): Subscription<Topics[M]["params"]> {
    this.subscriptions.push({ method, params });
    if (method !== "settings.watch") throw new Error("unexpected topic");
    this.listener = listener;
    return {
      update: (nextParams) => {
        this.updates.push(nextParams);
      },
      close: () => {},
    };
  }

  getState() {
    return "open" as const;
  }
  onStateChange() {
    return () => {};
  }
  close() {}
}

afterEach(cleanup);

function renderSubscription() {
  const client = new FakeEngineClient();
  const renders: { key: string; stale: boolean }[] = [];
  const hook = renderHook(
    ({ key }) => {
      const state = useSubscription("settings.watch", { key });
      renders.push({ key, stale: state.stale });
      return state;
    },
    {
      initialProps: { key: "a" },
      wrapper: ({ children }: { children: ReactNode }) => (
        <EngineProvider client={client}>{children}</EngineProvider>
      ),
    },
  );
  return { client, renders, ...hook };
}

describe("useSubscription", () => {
  it("is not stale before data or after the first data", () => {
    const { client, result } = renderSubscription();
    expect(client.subscriptions).toEqual([{ method: "settings.watch", params: { key: "a" } }]);
    expect(result.current.stale).toBe(false);
    expect(result.current.data).toBeUndefined();

    const data = { revision: "", key: "a", value: 1 };
    act(() => client.listener!.data(data));
    expect(result.current.stale).toBe(false);
    expect(result.current.data).toEqual(data);
  });

  it("is stale in the params-changing render until new data arrives", () => {
    const { client, renders, result, rerender } = renderSubscription();
    const oldData = { revision: "", key: "a", value: 1 };
    act(() => client.listener!.data(oldData));

    const firstChangedRender = renders.length;
    rerender({ key: "b" });
    expect(renders[firstChangedRender]).toEqual({ key: "b", stale: true });
    expect(result.current.stale).toBe(true);
    expect(result.current.data).toEqual(oldData);
    expect(client.updates).toEqual([{ key: "b" }]);
    expect(client.subscriptions).toHaveLength(1);

    const newData = { revision: "", key: "b", value: 2 };
    act(() => client.listener!.data(newData));
    expect(result.current.stale).toBe(false);
    expect(result.current.data).toEqual(newData);
  });

  it("is not stale when params return to those answered by the held data", () => {
    const { client, renders, result, rerender } = renderSubscription();
    const data = { revision: "", key: "a", value: 1 };
    act(() => client.listener!.data(data));

    rerender({ key: "b" });
    expect(result.current.stale).toBe(true);
    const firstRestoredRender = renders.length;
    rerender({ key: "a" });
    expect(renders[firstRestoredRender]).toEqual({ key: "a", stale: false });
    expect(result.current.stale).toBe(false);
    expect(result.current.data).toEqual(data);
    expect(client.updates).toEqual([{ key: "b" }, { key: "a" }]);
  });

  it("keeps old data stale when an update receives an error", () => {
    const { client, result, rerender } = renderSubscription();
    const data = { revision: "", key: "a", value: 1 };
    act(() => client.listener!.data(data));

    rerender({ key: "b" });
    expect(result.current.stale).toBe(true);
    expect(client.updates).toEqual([{ key: "b" }]);
    const error = { code: "internal" as const, message: "update failed" };
    act(() => client.listener!.error!(error));
    expect(result.current.stale).toBe(true);
    expect(result.current.data).toEqual(data);
    expect(result.current.error).toEqual(error);
  });
});
