import { useSubscription, useConnectionState } from "@hukube/engine-client/react";
import { formatResourceUri, parseResourceUri, type Facet } from "@hukube/k8s";
import { Badge } from "@hukube/ui/components/badge";
import { Tabs, TabsContent } from "@hukube/ui/components/tabs";
import type { IDockviewPanelProps } from "dockview-react";
import { useEffect, useState } from "react";

import { useResourceAccess } from "../edit/use-access.ts";
import { DeleteDialog } from "../edit/delete-dialog.tsx";
import { metadata } from "../edit/yaml.ts";
import { useUnsavedEdits } from "../edit/unsaved-edits.ts";
import { pinPanel } from "../workspace/dock.ts";
import { Button } from "@hukube/ui/components/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@hukube/ui/components/tooltip";
import { Delete02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";

import type { ResourcePanelParams } from "@/features/workspace/dock.ts";
import { useWorkspace } from "@/features/workspace/workspace-context.tsx";

import { resourceEventsParams } from "./facet-rules.ts";
import { facetsFor, resolveFacet } from "./facets.ts";
import { FacetSwitcher } from "./facet-switcher.tsx";
import { ownsPods } from "./logs-rule.ts";
import { Notice } from "./notice.tsx";
import { takePointerOpened } from "./pointer-opened.ts";

/** One live Resource, with its Facet named in the tab's Resource URI. */
export function ResourcePanel({
  api,
  params,
}: Pick<IDockviewPanelProps<ResourcePanelParams>, "api" | "params">) {
  const address = parseResourceUri(params.uri);
  const { types, openResource, active } = useWorkspace();
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
  const access = useResourceAccess(
    address
      ? {
          cluster: address.cluster,
          type: address.type,
          namespace: address.namespace,
          name: address.name,
        }
      : undefined,
    !!lastObject,
  );
  const connection = useConnectionState();
  const [deleteOpen, setDeleteOpen] = useState(false);
  const dirty = useUnsavedEdits((state) => state.entries.has(api.id));
  const [panelVisible, setPanelVisible] = useState(api.isVisible ?? true);
  useEffect(() => {
    const subscription = api.onDidVisibilityChange?.((event) => setPanelVisible(event.isVisible));
    return () => subscription?.dispose();
  }, [api]);
  const [logs, setLogs] = useState(false);
  const target = { type: address?.type ?? "", resourceType: types.get(address?.type ?? ""), logs };
  const available = facetsFor(target);
  const events = useSubscription(
    "resource.events",
    address && available.some((facet) => facet.id === "events")
      ? resourceEventsParams(address, manifest, manifest.data?.object ?? lastObject)
      : undefined,
  );
  const selected = resolveFacet(address?.facet, target);
  const related = useSubscription(
    "resource.related",
    address
      ? {
          cluster: address.cluster,
          type: address.type,
          namespace: address.namespace,
          name: address.name,
          cells: selected === "related",
        }
      : undefined,
  );
  if (!logs && ownsPods(related.data)) setLogs(true);
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
  const shared = {
    address,
    kind,
    manifest,
    lastObject,
    events,
    related,
    panelId: api.id,
    controls,
    editAccess: access?.edit,
    onEdit: () => pinPanel(api, params),
  };
  const meta = metadata(manifest.data?.object);
  const finalizers = Array.isArray(meta["finalizers"]) ? meta["finalizers"].map(String) : [];
  const deleteReason =
    manifest.data?.deleted || !lastObject
      ? "The Resource is not available."
      : connection !== "open"
        ? "Reconnecting to the Engine"
        : access?.delete.allowed === false
          ? (access.delete.reason ?? "Not permitted")
          : undefined;
  const choose = (value: string) => {
    const facet = resolveFacet(value as Facet, target);
    api.updateParameters({ ...params, uri: formatResourceUri({ ...address, facet }) });
  };
  return (
    // oxlint-disable-next-line jsx-a11y/no-static-element-interactions
    <div
      className="flex h-full min-h-0 flex-col"
      onClickCapture={(event) => {
        const opened = takePointerOpened(address.cluster);
        if (event.detail < 2 || !opened) return;
        // The second click of a double-click on a related Resource lands here, in the tab the
        // first click opened or brought forward, and makes a regular tab of it.
        event.stopPropagation();
        openResource(opened, { preview: false, pane: api.id });
      }}
    >
      <header className="flex shrink-0 items-center gap-2 border-b px-3 py-2">
        <span className="text-muted-foreground">{kind}</span>
        <h2 className="truncate font-mono font-semibold">{address.name}</h2>
        {address.namespace && (
          <span className="truncate font-mono text-muted-foreground">in {address.namespace}</span>
        )}
        {manifest.data?.deleted && (
          <Badge variant="destructive">{lastObject ? "Deleted" : "Not found"}</Badge>
        )}
        {!!meta["deletionTimestamp"] && (
          <Tooltip>
            <TooltipTrigger render={<Badge variant="secondary" tabIndex={0} />}>
              Terminating
            </TooltipTrigger>
            <TooltipContent>
              {finalizers.length ? `Waiting for: ${finalizers.join(", ")}` : "Waiting for deletion"}
            </TooltipContent>
          </Tooltip>
        )}
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                className="ml-auto shrink-0 aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
                size="icon-sm"
                variant="ghost"
                aria-label="Delete"
                disabled={!!deleteReason}
                focusableWhenDisabled
                onClick={() => setDeleteOpen(true)}
              />
            }
          >
            <HugeiconsIcon icon={Delete02Icon} />
          </TooltipTrigger>
          <TooltipContent>{deleteReason ?? "Delete"}</TooltipContent>
        </Tooltip>
      </header>
      <DeleteDialog
        open={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        address={address}
        kind={kind}
        object={lastObject}
        related={related.data}
      />
      <Tabs value={selected} onValueChange={choose} className="min-h-0 flex-1 gap-0">
        <FacetSwitcher
          available={available}
          selected={selected}
          visible={panelVisible && active}
          shared={shared}
          onChoose={choose}
          setControls={setControls}
          dirty={dirty}
        />
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
                <View
                  {...shared}
                  showing={selected === id}
                  visible={selected === id && panelVisible && active}
                />
              </TabsContent>
            ),
        )}
      </Tabs>
    </div>
  );
}
