import { lazy, Suspense } from "react";
import type { FacetProps } from "./facet-props.ts";
import { LogLoading } from "../logs/log-loading.tsx";

const LogStreamView = lazy(() => import("../logs/log-stream-view.tsx"));

/** Maps the Resource's live incarnation and visibility to a Log Stream. */
export function LogsFacet({ address, kind, manifest, visible }: FacetProps) {
  const metadata = manifest.data?.object?.["metadata"];
  const uid =
    metadata &&
    typeof metadata === "object" &&
    "uid" in metadata &&
    typeof metadata.uid === "string"
      ? metadata.uid
      : undefined;
  return (
    <Suspense fallback={<LogLoading toolbar />}>
      <LogStreamView
        target={address}
        kind={kind}
        uid={uid}
        exists={manifest.data ? !manifest.data.deleted : undefined}
        visible={visible}
      />
    </Suspense>
  );
}
