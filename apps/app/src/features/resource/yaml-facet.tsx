import { Button } from "@hukube/ui/components/button";
import { Skeleton } from "@hukube/ui/components/skeleton";
import { lazy, Suspense, useMemo, useState } from "react";
import { createPortal } from "react-dom";

import type { FacetProps } from "./facet-props.ts";
import { manifestYaml } from "./manifest.ts";
import { Notice } from "./notice.tsx";

const YamlEditor = lazy(() => import("./yaml-editor.tsx"));

/** Shows the last Manifest and places its controls in the switcher while visible. */
export function YamlFacet({ address, kind, manifest, lastObject, showing, controls }: FacetProps) {
  const [showManagedFields, setShowManagedFields] = useState(false);
  const yaml = useMemo(
    () => (lastObject ? manifestYaml(lastObject, { managedFields: showManagedFields }) : undefined),
    [lastObject, showManagedFields],
  );
  return (
    <div className="flex h-full min-h-0 flex-col">
      {showing &&
        controls &&
        createPortal(
          <Button
            variant="ghost"
            size="sm"
            aria-pressed={showManagedFields}
            onClick={() => setShowManagedFields(!showManagedFields)}
          >
            {showManagedFields ? "Hide managed fields" : "Show managed fields"}
          </Button>,
          controls,
        )}
      {manifest.error && (
        <p className="border-b px-3 py-2 text-destructive">{manifest.error.message}</p>
      )}
      <div className="min-h-0 flex-1">
        {yaml !== undefined ? (
          <Suspense fallback={<EditorSkeleton />}>
            <YamlEditor value={yaml} />
          </Suspense>
        ) : manifest.data?.deleted ? (
          <Notice
            title="Not found"
            description={`No ${kind} named ${address.name} exists right now. This view updates if it is created.`}
          />
        ) : (
          <EditorSkeleton />
        )}
      </div>
    </div>
  );
}

function EditorSkeleton() {
  return (
    <div className="flex flex-col gap-2 p-3">
      <Skeleton className="h-3 w-40" />
      <Skeleton className="h-3 w-64" />
      <Skeleton className="h-3 w-52" />
    </div>
  );
}
