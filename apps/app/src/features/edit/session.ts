import type { ErrorDetail } from "@hukube/engine-client";
import { editableManifest, metadata, metadataString, renderYaml } from "./yaml.ts";

export interface EditSession {
  base: Record<string, unknown>;
  uid: string;
  baseText: string;
  text: string;
  refusal?: ErrorDetail;
}
export function startSession(live: Record<string, unknown>): EditSession {
  const base = editableManifest(live);
  const text = renderYaml(base);
  return { base, uid: metadataString(live, "uid"), baseText: text, text };
}
export function isDirty(session: EditSession | undefined): boolean {
  return !!session && session.text !== session.baseText;
}
export function followManifest(
  session: EditSession,
  live: Record<string, unknown> | undefined,
  deleted: boolean,
): EditSession | undefined {
  if (isDirty(session)) return session;
  if (deleted) return undefined;
  return live ? startSession(live) : session;
}
export function sessionNotice(
  session: Pick<EditSession, "uid" | "baseText">,
  live: Record<string, unknown> | undefined,
  deleted: boolean,
  label: string,
  kind: string,
): string | undefined {
  if (deleted)
    return `${label} was deleted on the Cluster while you were editing. Your edits cannot be applied.`;
  if (live && metadata(live)["uid"] !== session.uid)
    return `${label} was replaced by a new ${kind} of the same name. Your edits cannot be applied.`;
  if (live && renderYaml(editableManifest(live)) !== session.baseText)
    return `${label} changed on the Cluster while you were editing. Review changes shows how your edit applies to it.`;
}
