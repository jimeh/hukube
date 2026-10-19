import type { DockviewApi } from "dockview-react";
import { commandMaxLength } from "./command.ts";
import { endSession, type ExecSessionParams } from "./sessions.ts";

interface SessionTab {
  params: ExecSessionParams;
  title: string;
}
const storageKey = (cluster: string) => `hukube.exec.tabs/${cluster}`;

/** Window-local Tabs supplement the last layout another window saved. */
export function readSessionTabs(cluster: string): SessionTab[] {
  try {
    const stored: unknown = JSON.parse(sessionStorage.getItem(storageKey(cluster)) ?? "null");
    if (!Array.isArray(stored)) return [];
    const tabs = new Map<string, SessionTab>();
    for (const entry of stored) {
      if (!entry || typeof entry !== "object" || typeof entry.title !== "string") continue;
      const params = entry.params;
      if (!params || typeof params !== "object") continue;
      const { sessionId, namespace, pod, uid, container, commandLine } = params;
      if (
        ![sessionId, namespace, pod, uid, container].every(
          (s) => typeof s === "string" && s.length > 0,
        )
      )
        continue;
      // The command line is kept as typed, so Start again runs the same command.
      const line =
        typeof commandLine === "string" && commandLine.length <= commandMaxLength
          ? { commandLine }
          : {};
      tabs.set(sessionId, {
        title: entry.title,
        params: { sessionId, namespace, pod, uid, container, ...line, preview: false },
      });
    }
    return [...tabs.values()];
  } catch {
    return [];
  }
}
function writeSessionTabs(cluster: string, tabs: SessionTab[]): void {
  try {
    sessionStorage.setItem(storageKey(cluster), JSON.stringify(tabs));
  } catch {
    // Storage may be unavailable or full; shared layout persistence still works.
  }
}
export function rememberSessionTab(cluster: string, tab: SessionTab): void {
  const tabs = readSessionTabs(cluster).filter(
    (entry) => entry.params.sessionId !== tab.params.sessionId,
  );
  writeSessionTabs(cluster, [...tabs, tab]);
}
export function forgetSessionTab(cluster: string, id: string): void {
  writeSessionTabs(
    cluster,
    readSessionTabs(cluster).filter((entry) => entry.params.sessionId !== id),
  );
}
/** A user closing a Tab ends its session and removes this window's record. */
export function closeSessionTab(cluster: string, id: string): void {
  forgetSessionTab(cluster, id);
  endSession(id);
}
export function restoreSessionTabs(api: DockviewApi, cluster: string): void {
  const group = api.activeGroup ?? api.groups[0];
  for (const { params, title } of readSessionTabs(cluster)) {
    const id = `exec:${params.sessionId}`;
    if (api.getPanel(id)) continue;
    api.addPanel({
      id,
      component: "exec",
      tabComponent: "tab",
      title,
      params,
      inactive: true,
      ...(group ? { position: { referenceGroup: group } } : {}),
    });
  }
}
