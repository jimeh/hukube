import type { ResourceAddress } from "@hukube/k8s";

// A click on a related Resource opens a Preview Tab in the Pane the row is
// in, which replaces the content under the pointer. The second click of a
// double-click therefore lands in whatever the tab that opened shows, and no
// `dblclick` reaches the row. What a click opened is kept here, briefly, for
// the Resource tab that receives the second click.
const pointerOpenedFor = 1000;
let pointerOpened: { address: ResourceAddress; at: number } | undefined;

/** Records the Resource a click just opened as a Preview Tab. */
export function rememberPointerOpened(address: ResourceAddress): void {
  pointerOpened = { address, at: performance.now() };
}

/** Returns and forgets what the last click opened, when it was recent and in this Cluster. */
export function takePointerOpened(cluster: string): Omit<ResourceAddress, "cluster"> | undefined {
  const opened = pointerOpened;
  pointerOpened = undefined;
  if (!opened || performance.now() - opened.at >= pointerOpenedFor) return undefined;
  if (opened.address.cluster !== cluster) return undefined;
  const { type, namespace, name } = opened.address;
  return { type, namespace, name };
}
