import { useSubscription } from "@hukube/engine-client/react";
import { parseResourceUri } from "@hukube/k8s";
import { Badge } from "@hukube/ui/components/badge";
import { Button } from "@hukube/ui/components/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@hukube/ui/components/empty";
import { Skeleton } from "@hukube/ui/components/skeleton";
import { lazy, Suspense, useMemo, useState } from "react";

import { useWorkspace } from "@/features/workspace/workspace-context.tsx";

import { manifestYaml } from "./manifest.ts";

const YamlEditor = lazy(() => import("./yaml-editor.tsx"));

/** One Resource, shown through its YAML Facet and kept live. */
export function ResourcePanel({ uri }: { uri: string }) {
  const address = parseResourceUri(uri);
  const { types } = useWorkspace();
  const { data, error } = useSubscription(
    "resource.get",
    address
      ? {
          cluster: address.cluster,
          type: address.type,
          namespace: address.namespace,
          name: address.name,
        }
      : undefined,
  );
  const [showManagedFields, setShowManagedFields] = useState(false);

  // Keep showing the last known Manifest after the Resource is deleted.
  const [lastObject, setLastObject] = useState<Record<string, unknown>>();
  if (data?.object && data.object !== lastObject) setLastObject(data.object);

  const yaml = useMemo(
    () => (lastObject ? manifestYaml(lastObject, { managedFields: showManagedFields }) : undefined),
    [lastObject, showManagedFields],
  );

  if (!address) {
    return (
      <Notice
        title="Unreadable address"
        description={`This tab points at "${uri}", which is not a Resource URI.`}
      />
    );
  }
  const kind = types.get(address.type)?.kind ?? address.type;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 items-center gap-2 border-b px-3 py-2">
        <span className="text-muted-foreground">{kind}</span>
        <h2 className="truncate font-mono font-semibold">{address.name}</h2>
        {address.namespace && (
          <span className="truncate font-mono text-muted-foreground">in {address.namespace}</span>
        )}
        {data?.deleted && (
          <Badge variant="destructive">{lastObject ? "Deleted" : "Not found"}</Badge>
        )}
        <Button
          variant="ghost"
          size="sm"
          className="ml-auto"
          aria-pressed={showManagedFields}
          onClick={() => setShowManagedFields(!showManagedFields)}
        >
          {showManagedFields ? "Hide managed fields" : "Show managed fields"}
        </Button>
      </header>
      {error && <p className="border-b px-3 py-2 text-destructive">{error.message}</p>}
      <div className="min-h-0 flex-1">
        {yaml !== undefined ? (
          <Suspense fallback={<EditorSkeleton />}>
            <YamlEditor value={yaml} />
          </Suspense>
        ) : data?.deleted ? (
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

function Notice({ title, description }: { title: string; description: string }) {
  return (
    <Empty className="h-full">
      <EmptyHeader>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}
