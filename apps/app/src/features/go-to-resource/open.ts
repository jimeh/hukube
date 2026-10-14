const eventName = "hukube:go-to-resource";

/** Opens the Go to Resource palette of a Cluster's Workspace, as its shortcut does. */
export function openGoToResource(cluster: string): void {
  window.dispatchEvent(new CustomEvent(eventName, { detail: cluster }));
}

/** Calls fn when the palette of the given Cluster is asked for. */
export function onOpenGoToResource(cluster: string, fn: () => void): () => void {
  const listener = (event: Event) => {
    if ((event as CustomEvent<string>).detail === cluster) fn();
  };
  window.addEventListener(eventName, listener);
  return () => window.removeEventListener(eventName, listener);
}
