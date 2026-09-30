import type { Host } from "@hukube/host";
import { createContext, use, type ReactNode } from "react";

const HostContext = createContext<Host | null>(null);

export function HostProvider({ host, children }: { host: Host; children: ReactNode }) {
  return <HostContext value={host}>{children}</HostContext>;
}

export function useHost(): Host {
  const host = use(HostContext);
  if (!host) throw new Error("useHost must be used inside a HostProvider");
  return host;
}
