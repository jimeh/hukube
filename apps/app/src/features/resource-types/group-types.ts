import type { ResourceType } from "@hukube/engine-client";

export interface TypeGroup {
  /** The API group; empty for the core group. */
  group: string;
  label: string;
  types: ResourceType[];
}

export interface GroupOptions {
  /** Case-insensitive text matched against kind, resource, short names, and group. */
  filter: string;
  /** Include types with no Resources. Ignored while filtering, which shows everything that matches. */
  showEmpty: boolean;
}

/**
 * Groups Resource Types for the sidebar: the core group first, then built-in
 * Kubernetes groups, then everything else such as CRD groups, each sorted by
 * name, with types sorted by kind.
 */
export function groupTypes(
  types: readonly ResourceType[],
  { filter, showEmpty }: GroupOptions,
): TypeGroup[] {
  const needle = filter.trim().toLowerCase();
  const groups = new Map<string, ResourceType[]>();
  for (const t of types) {
    if (needle ? !matches(t, needle) : !showEmpty && t.count === 0) continue;
    const list = groups.get(t.group);
    if (list) list.push(t);
    else groups.set(t.group, [t]);
  }
  return [...groups]
    .map(([group, list]) => ({
      group,
      label: group || "core",
      types: list.toSorted((a, b) => a.kind.localeCompare(b.kind)),
    }))
    .toSorted((a, b) => tier(a.group) - tier(b.group) || a.group.localeCompare(b.group));
}

function tier(group: string): number {
  if (group === "") return 0;
  if (!group.includes(".") || group.endsWith(".k8s.io")) return 1;
  return 2;
}

function matches(t: ResourceType, needle: string): boolean {
  return (
    t.kind.toLowerCase().includes(needle) ||
    t.key.toLowerCase().includes(needle) ||
    (t.shortNames ?? []).some((s) => s.toLowerCase() === needle)
  );
}
