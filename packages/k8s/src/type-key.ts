/**
 * Identifies a Resource Type independently of API version, in kubectl's
 * "resource.group" form, such as "deployments.apps". Core types have no group
 * suffix, such as "pods".
 */
export type TypeKey = string;

export function typeKey(group: string, resource: string): TypeKey {
  return group === "" ? resource : `${resource}.${group}`;
}

export function parseTypeKey(key: TypeKey): { group: string; resource: string } {
  const dot = key.indexOf(".");
  return dot === -1
    ? { group: "", resource: key }
    : { group: key.slice(dot + 1), resource: key.slice(0, dot) };
}
