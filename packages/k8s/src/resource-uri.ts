import type { TypeKey } from "./type-key.ts";

/** A way of looking at a Resource. */
export type Facet = "yaml";

/** The parts of a Resource URI. `namespace` is empty for cluster-scoped Resources. */
export interface ResourceAddress {
  cluster: string;
  type: TypeKey;
  namespace: string;
  name: string;
  facet?: Facet;
}

const PREFIX = "hukube://resource/v1/";
// Namespaces are DNS labels and can never be "_".
const CLUSTER_SCOPED = "_";
const FACETS: ReadonlySet<string> = new Set<Facet>(["yaml"]);

/**
 * Formats a Resource URI, the single way to address a Resource (ADR-0006):
 * `hukube://resource/v1/{cluster}/{type}/{namespace}/{name}#{facet}`, with each
 * segment percent-encoded.
 */
export function formatResourceUri(a: ResourceAddress): string {
  const segments = [a.cluster, a.type, a.namespace || CLUSTER_SCOPED, a.name];
  const uri = PREFIX + segments.map(encodeURIComponent).join("/");
  return a.facet ? `${uri}#${a.facet}` : uri;
}

/** Parses a Resource URI, returning undefined for anything malformed. */
export function parseResourceUri(uri: string): ResourceAddress | undefined {
  if (!uri.startsWith(PREFIX)) return undefined;
  const [path = "", facet, ...extra] = uri.slice(PREFIX.length).split("#");
  if (extra.length > 0 || (facet !== undefined && !FACETS.has(facet))) return undefined;

  const segments = path.split("/");
  if (segments.length !== 4 || segments.some((s) => s === "")) return undefined;
  let decoded: string[];
  try {
    decoded = segments.map(decodeURIComponent);
  } catch {
    return undefined;
  }
  const [cluster = "", type = "", namespace = "", name = ""] = decoded;
  return {
    cluster,
    type,
    namespace: namespace === CLUSTER_SCOPED ? "" : namespace,
    name,
    ...(facet ? { facet: facet as Facet } : {}),
  };
}
