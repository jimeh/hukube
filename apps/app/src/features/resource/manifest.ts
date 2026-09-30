import { stringify } from "yaml";

export interface ManifestOptions {
  /** Include metadata.managedFields, which is noise for most reading. */
  managedFields: boolean;
}

/** Renders a Resource's Manifest as YAML, keeping the server's key order. */
export function manifestYaml(
  object: Record<string, unknown>,
  { managedFields }: ManifestOptions,
): string {
  let shown = object;
  const metadata = object["metadata"];
  if (!managedFields && isRecord(metadata) && "managedFields" in metadata) {
    const { managedFields: _hidden, ...rest } = metadata;
    shown = { ...object, metadata: rest };
  }
  return stringify(shown, { lineWidth: 0, aliasDuplicateObjects: false });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
