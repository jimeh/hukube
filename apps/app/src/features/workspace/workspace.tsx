import { formatResourceUri, parseResourceUri, type TypeKey } from "@hukube/k8s";
import { useEngine, useSubscription } from "@hukube/engine-client/react";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@hukube/ui/components/empty";
import {
  DockviewReact,
  type DockviewApi,
  type DockviewTheme,
  type IDockviewPanelProps,
} from "dockview-react";
import { useEffect, useMemo, useState, useCallback } from "react";

import { clusterScope } from "@/features/clusters/cluster-color.ts";
import { GoToResource } from "@/features/go-to-resource/go-to-resource.tsx";
import { ResourceListPanel } from "@/features/resource-list/resource-list-panel.tsx";
import { useRegistry } from "../overview/registry.ts";
import { matches } from "../overview/definition.ts";
import { newResourceUri } from "@/features/resource/facet-rules.ts";
import { ResourcePanel } from "@/features/resource/resource-panel.tsx";
import { TypeSidebar } from "@/features/resource-types/type-sidebar.tsx";
import { useTheme } from "@/lib/theme.ts";
import { execTitle } from "../exec/command.ts";
import { ExecPanel } from "../exec/exec-panel.tsx";
import {
  attachSession,
  detachClusterSessions,
  detachSession,
  sessionId,
  startSession,
  type ExecSessionParams,
} from "../exec/sessions.ts";

import { rememberSessionTab, restoreSessionTabs } from "../exec/window-tabs.ts";

import { openPanel, pinPanel, type ListPanelParams, type ResourcePanelParams } from "./dock.ts";
import { PanelTab } from "./panel-tab.tsx";
import { StatusBar } from "./status-bar.tsx";
import { useLayoutPersistence } from "./use-layout-persistence.ts";
import { WorkspaceContext, type WorkspaceValue } from "./workspace-context.tsx";

const components = {
  exec: ({ api, params }: IDockviewPanelProps<ExecSessionParams>) => (
    <ExecPanel api={api} params={params} />
  ),
  list: ({ api, params }: IDockviewPanelProps<ListPanelParams>) => (
    <ResourceListPanel
      panelId={api.id}
      type={params.type}
      namespaces={params.namespaces}
      // One partial update, so a full copy of older params cannot undo it.
      // The selection is saved with the Tab, so changing it pins a preview.
      onNamespacesChange={(namespaces) =>
        api.updateParameters({
          namespaces: namespaces.length > 0 ? namespaces : undefined,
          preview: false,
        })
      }
      onInteract={() => pinPanel(api, params)}
    />
  ),
  resource: ({ api, params }: IDockviewPanelProps<ResourcePanelParams>) => (
    <ResourcePanel key={api.id} api={api} params={params} />
  ),
};
const tabComponents = { tab: PanelTab };

/**
 * The Panes and Tabs for one Cluster, tinted with the Cluster's color. Hidden
 * Workspaces stay mounted, so active says whether this one is shown and the
 * window is not out of date.
 */
export function Workspace({ cluster, active }: { cluster: string; active: boolean }) {
  const engine = useEngine();
  const { snapshot: overviewRegistry } = useRegistry();
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

  useLayoutPersistence(api, cluster, () => {
    if (api) restoreSessionTabs(api, cluster);
  });
  useEffect(() => {
    if (!api) return;
    const attach = (panel: (typeof api.panels)[number]) => {
      if (panel.id.startsWith("exec:")) {
        const params = panel.params as ExecSessionParams;
        rememberSessionTab(cluster, {
          params,
          title: panel.api.title ?? execTitle(params),
        });
        void attachSession(engine, cluster, params);
      }
    };
    for (const panel of api.panels) attach(panel);
    const added = api.onDidAddPanel(attach);
    const d = api.onDidRemovePanel((event) => {
      if (event.id.startsWith("exec:")) {
        detachSession(event.id.slice(5));
      }
    });
    return () => {
      added.dispose();
      d.dispose();
      detachClusterSessions(cluster);
    };
  }, [api, engine, cluster]);

  useEffect(() => {
    if (!api) return;
    const d = api.onDidActivePanelChange(() => {
      setActiveListType((api.activePanel?.params as Partial<ListPanelParams> | undefined)?.type);
    });
    return () => d.dispose();
  }, [api]);

  const targetFor = useCallback(
    (key: TypeKey) => {
      const resourceType = types.get(key);
      const definition = overviewRegistry.definitions.get(key);
      const version = resourceType
        ? `${resourceType.group ? resourceType.group + "/" : ""}${resourceType.version}`
        : undefined;
      return {
        type: key,
        resourceType,
        overview: !!definition && matches(definition, key, version) === true,
      };
    },
    [types, overviewRegistry.definitions],
  );

  const value = useMemo<WorkspaceValue>(
    () => ({
      cluster,
      active,
      ...(status ? { status } : {}),
      types,
      openExecSession: (target, options) => {
        if (!api) return;
        const params = { ...target, sessionId: sessionId() };
        void startSession(engine, cluster, params);
        openPanel<ExecSessionParams>(api, {
          id: `exec:${params.sessionId}`,
          component: "exec",
          title: execTitle(params),
          params,
          preview: false,
          ...(options?.pane ? { pane: options.pane } : {}),
        });
      },
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
          id: formatResourceUri({ ...address, cluster, facet: undefined }),
          component: "resource",
          title: address.name,
          params: { uri },
          deriveActiveTabParams: (params, activeParams) => {
            const activeUri =
              activeParams &&
              typeof activeParams === "object" &&
              "uri" in activeParams &&
              typeof activeParams.uri === "string"
                ? activeParams.uri
                : undefined;
            const activeAddress = activeUri ? parseResourceUri(activeUri) : undefined;
            return {
              ...params,
              uri: newResourceUri(
                params.uri,
                activeUri,
                targetFor(address.type),
                activeAddress ? targetFor(activeAddress.type) : undefined,
              ),
            };
          },
          preview: options?.preview ?? false,
          ...(options?.beside ? { beside: options.beside } : {}),
          ...(options?.pane ? { pane: options.pane } : {}),
        });
      },
    }),
    [api, engine, cluster, active, status, types, activeListType, targetFor],
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
