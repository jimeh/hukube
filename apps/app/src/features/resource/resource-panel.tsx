import { useSubscription } from "@hukube/engine-client/react";
import { formatResourceUri, parseResourceUri, type Facet } from "@hukube/k8s";
import { Badge } from "@hukube/ui/components/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@hukube/ui/components/tabs";
import type { IDockviewPanelProps } from "dockview-react";
import { useState } from "react";

import type { ResourcePanelParams } from "@/features/workspace/dock.ts";
import { useWorkspace } from "@/features/workspace/workspace-context.tsx";

import { resourceEventsParams } from "./facet-rules.ts";
import { facetsFor, resolveFacet } from "./facets.ts";
import { Notice } from "./notice.tsx";

/** One live Resource, with its Facet named in the tab's Resource URI. */
export function ResourcePanel({
  api,
  params,
}: Pick<IDockviewPanelProps<ResourcePanelParams>, "api" | "params">) {
  const address = parseResourceUri(params.uri);
  const { types } = useWorkspace();
  const manifest = useSubscription(
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
  const [lastObject, setLastObject] = useState<Record<string, unknown>>();
  if (manifest.data?.object && manifest.data.object !== lastObject)
    setLastObject(manifest.data.object);
  const target = { type: address?.type ?? "", resourceType: types.get(address?.type ?? "") };
  const available = facetsFor(target);
  const events = useSubscription(
    "resource.events",
    address && available.some((facet) => facet.id === "events")
      ? resourceEventsParams(address, manifest, manifest.data?.object ?? lastObject)
      : undefined,
  );
  const selected = resolveFacet(address?.facet, target);
  const [mounted, setMounted] = useState<ReadonlySet<Facet>>(() => new Set([selected]));
  if (!mounted.has(selected)) setMounted(new Set([...mounted, selected]));
  const [controls, setControls] = useState<HTMLDivElement | null>(null);
  if (!address)
    return (
      <Notice
        title="Unreadable address"
        description={`This tab points at "${params.uri}", which is not a Resource URI.`}
      />
    );
  const kind = target.resourceType?.kind ?? address.type;
  const shared = { address, kind, manifest, lastObject, events, controls };
  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 items-center gap-2 border-b px-3 py-2">
        <span className="text-muted-foreground">{kind}</span>
        <h2 className="truncate font-mono font-semibold">{address.name}</h2>
        {address.namespace && (
          <span className="truncate font-mono text-muted-foreground">in {address.namespace}</span>
        )}
        {manifest.data?.deleted && (
          <Badge variant="destructive">{lastObject ? "Deleted" : "Not found"}</Badge>
        )}
      </header>
      <Tabs
        value={selected}
        onValueChange={(value) => {
          const facet = resolveFacet(value as Facet, target);
          api.updateParameters({ ...params, uri: formatResourceUri({ ...address, facet }) });
        }}
        className="min-h-0 flex-1 gap-0"
      >
        <div className="flex h-8 shrink-0 items-center justify-between gap-2 border-b px-3">
          <TabsList variant="line" aria-label="Facets" activateOnFocus>
            {available.map(({ id, label, Badge: FacetBadge, accessibleName }) => (
              <TabsTrigger
                key={id}
                value={id}
                aria-label={accessibleName?.({ ...shared, showing: selected === id })}
              >
                {label}
                {FacetBadge && <FacetBadge {...shared} showing={selected === id} />}
              </TabsTrigger>
            ))}
          </TabsList>
          <div ref={setControls} className="flex shrink-0 items-center" />
        </div>
        {available.map(
          ({ id, View }) =>
            mounted.has(id) && (
              <TabsContent
                key={id}
                value={id}
                keepMounted
                // Each Facet has its own focusable content, so the panel is not a second stop.
                tabIndex={-1}
                className="min-h-0 overflow-hidden"
                hidden={selected !== id}
              >
                <View {...shared} showing={selected === id} />
              </TabsContent>
            ),
        )}
      </Tabs>
    </div>
  );
}
