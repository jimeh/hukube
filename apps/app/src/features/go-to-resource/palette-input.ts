import type { Expr, FindParams, FindResult, ResourceType, Row } from "@hukube/engine-client";
import type { TypeKey } from "@hukube/k8s";

/** Where a palette search is scoped, as resolved from its prefixes. */
export interface Scope {
  types?: { segment: string; keys: TypeKey[] };
  namespace?: string;
}

export type ParsedInput =
  | { kind: "ok"; scope: Scope; text: string }
  | { kind: "error"; message: string }
  /** A prefix may name a Namespace, but the Namespaces have not loaded yet. */
  | { kind: "pending" };

/**
 * Parses palette input: up to two scope segments, then the name text,
 * separated by "/", such as `deploy/api`, `kube-system/core`, or
 * `kube-system/po/core`, in either order. A segment names a Resource Type when
 * it matches a type's resource name, kind, short name, or key, and otherwise
 * an existing Namespace. A segment that names both is read as the type.
 */
export function parsePaletteInput(
  input: string,
  types: readonly ResourceType[],
  namespaces: ReadonlySet<string> | undefined,
): ParsedInput {
  const segments = input.split("/");
  const text = segments.pop() ?? "";
  if (segments.length > 2) {
    return { kind: "error", message: "Use at most a type and a namespace before the name." };
  }

  const scope: Scope = {};
  for (const raw of segments) {
    const segment = raw.trim().toLowerCase();
    if (!segment) return { kind: "error", message: "A prefix before “/” is empty." };

    const keys = typesNamed(segment, types);
    if (keys.length > 0) {
      if (scope.types) return { kind: "error", message: "Use only one resource type prefix." };
      scope.types = { segment, keys };
    } else if (!namespaces) {
      return { kind: "pending" };
    } else if (namespaces.has(segment)) {
      if (scope.namespace) return { kind: "error", message: "Use only one namespace prefix." };
      scope.namespace = segment;
    } else {
      return { kind: "error", message: `No resource type or namespace named “${segment}”.` };
    }
  }
  return { kind: "ok", scope, text };
}

function typesNamed(segment: string, types: readonly ResourceType[]): TypeKey[] {
  const keys: TypeKey[] = [];
  for (const t of types) {
    if (
      t.key === segment ||
      t.resource === segment ||
      t.kind.toLowerCase() === segment ||
      (t.shortNames ?? []).includes(segment)
    ) {
      keys.push(t.key);
    }
  }
  return keys.toSorted();
}

/** The Query that limits a find to its scope, or undefined to search everything. */
export function scopeQuery(scope: Scope): Expr | undefined {
  const args: Expr[] = [];
  if (scope.types) args.push({ op: "in", field: "type", values: scope.types.keys });
  if (scope.namespace) args.push({ op: "in", field: "namespace", values: [scope.namespace] });
  if (args.length === 0) return undefined;
  return args.length === 1 ? args[0] : { op: "and", args };
}

export interface ResourceItem {
  row: Row;
  /** Set when the row answers earlier input, so choosing it would mislead. */
  disabled: boolean;
}

/**
 * The palette's Resource items for a find result. Rows from a result that
 * answers other params than the current ones stay visible but disabled, so
 * typing does not flicker and Enter cannot open a Resource from old input.
 */
export function resourceItems(
  result: FindResult | undefined,
  params: Pick<FindParams, "text" | "where"> | undefined,
): ResourceItem[] {
  if (!result) return [];
  const stale = !params || result.text !== params.text || !sameJson(result.where, params.where);
  return result.rows.map((row) => ({ row, disabled: stale }));
}

/** Compares JSON values structurally, ignoring object key order. */
export function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ak = Object.keys(a).filter((k) => (a as Record<string, unknown>)[k] !== undefined);
  const bk = Object.keys(b).filter((k) => (b as Record<string, unknown>)[k] !== undefined);
  return (
    ak.length === bk.length &&
    ak.every((k) => sameJson((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]))
  );
}

/**
 * Resource Types whose kind, resource name, or short names match text,
 * best first: exact matches, then prefixes, then substrings.
 */
export function matchingTypes(
  types: readonly ResourceType[],
  text: string,
  limit: number,
): ResourceType[] {
  const needle = text.trim().toLowerCase();
  if (!needle) return [];
  const ranked: { type: ResourceType; rank: number }[] = [];
  for (const t of types) {
    const names = [t.kind.toLowerCase(), t.resource, ...(t.shortNames ?? [])];
    const rank = names.includes(needle)
      ? 0
      : names.some((n) => n.startsWith(needle))
        ? 1
        : names.some((n) => n.includes(needle))
          ? 2
          : undefined;
    if (rank !== undefined) ranked.push({ type: t, rank });
  }
  return ranked
    .toSorted((a, b) => a.rank - b.rank || a.type.kind.localeCompare(b.type.kind))
    .slice(0, limit)
    .map((r) => r.type);
}
