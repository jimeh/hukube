import {
  createContext,
  use,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";

import type { ConnectionState, EngineClient, Subscription } from "./client.ts";
import type { TopicMethod, Topics } from "./methods.ts";
import type { ErrorDetail } from "./protocol.gen.ts";

const EngineContext = createContext<EngineClient | null>(null);

export function EngineProvider({
  client,
  children,
}: {
  client: EngineClient;
  children: ReactNode;
}) {
  return <EngineContext value={client}>{children}</EngineContext>;
}

export function useEngine(): EngineClient {
  const client = use(EngineContext);
  if (!client) throw new Error("useEngine must be used inside an EngineProvider");
  return client;
}

export function useConnectionState(): ConnectionState {
  const client = useEngine();
  return useSyncExternalStore(
    (onChange) => client.onStateChange(onChange),
    () => client.getState(),
  );
}

export interface SubscriptionState<T> {
  data?: T;
  error?: ErrorDetail;
}

/**
 * Subscribes to a topic while params are defined. Changing params updates the
 * subscription in place and keeps showing the previous data until new data
 * arrives, which suits scrolling windows. Remount with a new React key when
 * the previous data would be misleading, such as when switching Resources.
 */
export function useSubscription<M extends TopicMethod>(
  method: M,
  params: Topics[M]["params"] | undefined,
): SubscriptionState<Topics[M]["data"]> {
  const client = useEngine();
  const [state, setState] = useState<SubscriptionState<Topics[M]["data"]>>({});
  const key = params === undefined ? undefined : JSON.stringify(params);
  const enabled = key !== undefined;
  const subRef = useRef<Subscription<Topics[M]["params"]> | null>(null);
  const sentKeyRef = useRef<string | undefined>(undefined);
  const currentKey = useEffectEvent(() => key);

  useEffect(() => {
    if (!enabled) return;
    const initial = currentKey();
    if (initial === undefined) return;
    sentKeyRef.current = initial;
    const sub = client.subscribe(method, JSON.parse(initial) as Topics[M]["params"], {
      data: (data) => setState({ data }),
      error: (error) => setState((prev) => ({ data: prev.data, error })),
    });
    subRef.current = sub;
    return () => {
      sub.close();
      subRef.current = null;
      sentKeyRef.current = undefined;
      setState({});
    };
  }, [client, method, enabled]);

  useEffect(() => {
    if (key === undefined || key === sentKeyRef.current || !subRef.current) return;
    sentKeyRef.current = key;
    subRef.current.update(JSON.parse(key) as Topics[M]["params"]);
  }, [key]);

  return state;
}
