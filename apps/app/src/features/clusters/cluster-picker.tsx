import type { Cluster } from "@hukube/engine-client";
import { useConnectionState } from "@hukube/engine-client/react";
import { Alert, AlertDescription, AlertTitle } from "@hukube/ui/components/alert";
import { Badge } from "@hukube/ui/components/badge";
import { Button } from "@hukube/ui/components/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@hukube/ui/components/empty";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@hukube/ui/components/input-group";
import { Spinner } from "@hukube/ui/components/spinner";
import { Search01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useNavigate } from "@tanstack/react-router";
import { useDeferredValue, useState } from "react";

import { clusterScope } from "./cluster-color.ts";
import { useOpenClusters } from "./open-clusters.ts";
import { useClusters } from "./use-clusters.ts";

export function ClusterPicker() {
  const { clusters, error, reload } = useClusters();
  const connection = useConnectionState();
  const [filter, setFilter] = useState("");
  const deferredFilter = useDeferredValue(filter.toLowerCase());
  const openCluster = useOpenCluster();

  const matches = clusters?.filter(
    (c) =>
      c.id.toLowerCase().includes(deferredFilter) ||
      c.server.toLowerCase().includes(deferredFilter),
  );

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-6 py-10">
      <div className="flex flex-col gap-1">
        <h1 className="text-lg font-semibold">Open a cluster</h1>
        <p className="text-muted-foreground">Each kubeconfig context opens in its own tab.</p>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertTitle>Could not read your kubeconfig</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {!clusters && !error && (
        <div className="flex items-center gap-2 text-muted-foreground">
          <Spinner />
          {connection === "open" ? "Loading clusters" : "Connecting to the Engine"}
        </div>
      )}

      {clusters?.length === 0 && (
        <Empty className="border">
          <EmptyHeader>
            <EmptyTitle>No clusters in your kubeconfig</EmptyTitle>
            <EmptyDescription>
              The Engine reads $KUBECONFIG, or ~/.kube/config when it is unset. Add a context, then
              reload.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button variant="outline" onClick={reload}>
              Reload
            </Button>
          </EmptyContent>
        </Empty>
      )}

      {clusters && clusters.length > 0 && (
        <>
          <InputGroup>
            <InputGroupAddon>
              <HugeiconsIcon icon={Search01Icon} strokeWidth={2} />
            </InputGroupAddon>
            <InputGroupInput
              // Filtering is the only thing to do on this screen, so start there.
              // oxlint-disable-next-line jsx-a11y/no-autofocus
              autoFocus
              aria-label="Filter clusters"
              placeholder="Filter by context or server"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              onKeyDown={(e) => {
                const first = matches?.[0];
                if (e.key === "Enter" && first) openCluster(first.id);
              }}
            />
          </InputGroup>
          <ul className="flex flex-col divide-y rounded-lg border" aria-label="Clusters">
            {matches?.map((c) => (
              <li key={c.id}>
                <ClusterRow cluster={c} onOpen={() => openCluster(c.id)} />
              </li>
            ))}
            {matches?.length === 0 && (
              <li className="px-3 py-2 text-muted-foreground">No contexts match the filter.</li>
            )}
          </ul>
        </>
      )}
    </div>
  );
}

function ClusterRow({ cluster, onOpen }: { cluster: Cluster; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      {...clusterScope(cluster.id)}
      className="grid w-full grid-cols-[auto_1fr_auto] items-center gap-x-3 px-3 py-2 text-left outline-none hover:bg-accent focus-visible:bg-cluster-subtle"
    >
      <span className="size-2.5 rounded-full bg-cluster" aria-hidden />
      <span className="flex min-w-0 flex-col">
        <span className="truncate font-mono">{cluster.id}</span>
        <span className="truncate text-xs text-muted-foreground">
          {cluster.server || "No server set"}
        </span>
      </span>
      {cluster.current && <Badge variant="secondary">Current context</Badge>}
    </button>
  );
}

/** Opens a Cluster's tab in this window and switches to it. */
export function useOpenCluster() {
  const open = useOpenClusters((s) => s.open);
  const navigate = useNavigate();
  return (id: string) => {
    open(id);
    void navigate({ to: "/c/$cluster", params: { cluster: id } });
  };
}
