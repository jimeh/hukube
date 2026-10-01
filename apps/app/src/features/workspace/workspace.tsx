import { formatResourceUri, type TypeKey } from "@hukube/k8s";
import { useSubscription } from "@hukube/engine-client/react";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@hukube/ui/components/empty";
import {
  DockviewReact,
  type DockviewApi,
  type DockviewTheme,
  type IDockviewPanelProps,
} from "dockview-react";
import { useEffect, useMemo, useState } from "react";

import { clusterScope } from "@/features/clusters/cluster-color.ts";
import { GoToResource } from "@/features/go-to-resource/go-to-resource.tsx";
import { ResourceListPanel } from "@/features/resource-list/resource-list-panel.tsx";
import { ResourcePanel } from "@/features/resource/resource-panel.tsx";
import { TypeSidebar } from "@/features/resource-types/type-sidebar.tsx";
import { useTheme } from "@/lib/theme.ts";

import { openPanel, pinPanel, type ListPanelParams, type ResourcePanelParams } from "./dock.ts";
import { PanelTab } from "./panel-tab.tsx";
import { StatusBar } from "./status-bar.tsx";
import { useLayoutPersistence } from "./use-layout-persistence.ts";
import { WorkspaceContext, type WorkspaceValue } from "./workspace-context.tsx";

const components = {
  list: ({ api, params }: IDockviewPanelProps<ListPanelParams>) => (
    <ResourceListPanel
      panelId={api.id}
      type={params.type}
      onInteract={() => pinPanel(api, params)}
    />
  ),
  resource: ({ params }: IDockviewPanelProps<ResourcePanelParams>) => (
    <ResourcePanel uri={params.uri} />
  ),
};
const tabComponents = { tab: PanelTab };

/**
 * The Panes and Tabs for one Cluster, tinted with the Cluster's color. Hidden
 * Workspaces stay mounted, so active says whether this one is shown.
 */
export function Workspace({ cluster, active }: { cluster: string; active: boolean }) {
  const { data: status } = useSubscription("cluster.status", { cluster });
  const { data: typeList } = useSubscription("cluster.types", { cluster });
  const types = useMemo(() => new Map((typeList ?? []).map((t) => [t.key, t])), [typeList]);
  const [api, setApi] = useState<DockviewApi>();
  const [activeListType, setActiveListType] = useState<TypeKey>();
  const colorScheme = useTheme();
  const theme = useMemo<DockviewTheme>(
    () => ({ name: "hukube", className: "dockview-theme-hukube", colorScheme }),
    [colorScheme],
  );

  useLayoutPersistence(api, cluster);

  useEffect(() => {
    if (!api) return;
    const d = api.onDidActivePanelChange(() => {
      setActiveListType((api.activePanel?.params as Partial<ListPanelParams> | undefined)?.type);
    });
    return () => d.dispose();
  }, [api]);

  const value = useMemo<WorkspaceValue>(
    () => ({
      cluster,
      ...(status ? { status } : {}),
      types,
      ...(activeListType ? { activeListType } : {}),
      openList: (type, options) => {
        if (!api) return;
        openPanel<ListPanelParams>(api, {
          id: `list:${type}`,
          component: "list",
          title: type,
          params: { type },
          preview: options?.preview ?? false,
        });
      },
      openResource: (address, options) => {
        if (!api) return;
        const uri = formatResourceUri({ ...address, cluster });
        openPanel<ResourcePanelParams>(api, {
          id: uri,
          component: "resource",
          title: address.name,
          params: { uri },
          preview: options?.preview ?? false,
          ...(options?.beside ? { beside: options.beside } : {}),
        });
      },
    }),
    [api, cluster, status, types, activeListType],
  );

  return (
    <WorkspaceContext value={value}>
      <div {...clusterScope(cluster)} className="flex h-full min-h-0 flex-col">
        <div className="grid min-h-0 flex-1 grid-cols-[15rem_1fr]">
          <TypeSidebar />
          <DockviewReact
            theme={theme}
            components={components}
            tabComponents={tabComponents}
            watermarkComponent={Watermark}
            onReady={(e) => setApi(e.api)}
          />
        </div>
        <StatusBar />
      </div>
      <GoToResource active={active} />
    </WorkspaceContext>
  );
}

function Watermark() {
  return (
    <Empty className="h-full">
      <EmptyHeader>
        <EmptyTitle>Nothing open</EmptyTitle>
        <EmptyDescription>
          Choose a resource type in the sidebar to list its resources.
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}
