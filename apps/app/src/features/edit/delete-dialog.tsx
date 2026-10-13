import type { DeleteParams, DeletePropagation, Related } from "@hukube/engine-client";
import { useEngine, useSubscription } from "@hukube/engine-client/react";
import type { ResourceAddress } from "@hukube/k8s";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
} from "@hukube/ui/components/alert-dialog";
import { Button } from "@hukube/ui/components/button";
import { Checkbox } from "@hukube/ui/components/checkbox";
import { Input } from "@hukube/ui/components/input";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@hukube/ui/components/select";
import { Skeleton } from "@hukube/ui/components/skeleton";
import { useEffect, useLayoutEffect, useId, useRef, useState } from "react";
import { clusterScope } from "../clusters/cluster-color.ts";
import { useWorkspace } from "../workspace/workspace-context.tsx";
import { metadata, metadataString } from "./yaml.ts";
import { requestError } from "./use-review.ts";

export function DeleteDialog({
  open,
  onClose,
  address,
  kind,
  object,
  related,
}: {
  open: boolean;
  onClose: () => void;
  address: ResourceAddress;
  kind: string;
  object?: Record<string, unknown>;
  related?: Related;
}) {
  const client = useEngine();
  const immediateId = useId();
  const nameId = useId();
  const dependentsId = useId();
  const { types } = useWorkspace();
  const namespace = address.type === "namespaces";
  const crd = address.type === "customresourcedefinitions.apiextensions.k8s.io";
  const count = useSubscription(
    "resources.query",
    open && namespace
      ? {
          cluster: address.cluster,
          where: { op: "in", field: "namespace", values: [address.name] },
          sort: { field: "name" },
          offset: 0,
          limit: 1,
        }
      : undefined,
  );
  const [targetUid, setTargetUid] = useState(() => metadataString(object, "uid"));
  const [wasOpen, setWasOpen] = useState(open);
  const [confirmation, setConfirmation] = useState("");
  const [propagation, setPropagation] = useState<DeletePropagation>("background");
  const [immediate, setImmediate] = useState(false);
  const [phase, setPhase] = useState<"ready" | "deleting" | "disconnected" | "failed">("ready");
  const [error, setError] = useState<ReturnType<typeof requestError>>();
  const pending = useRef<DeleteParams | undefined>(undefined);
  const active = useRef(true);
  const currentPhase = useRef(phase);

  const cancel = useRef<HTMLButtonElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const closeCallback = useRef(onClose);
  useLayoutEffect(() => {
    currentPhase.current = phase;
    closeCallback.current = onClose;
  }, [phase, onClose]);
  const send = useRef<() => Promise<void>>(async () => {});
  useLayoutEffect(() => {
    send.current = async () => {
      if (!pending.current) return;
      currentPhase.current = "deleting";
      setPhase("deleting");
      try {
        await client.request("resource.delete", pending.current);
        if (active.current) {
          setPhase("ready");
          closeCallback.current();
        }
      } catch (failure) {
        if (!active.current) return;
        const detail = requestError(failure);
        setError(detail);
        setPhase(detail.code === "disconnected" ? "disconnected" : "failed");
      }
    };
  }, [client]);
  useEffect(() => {
    active.current = true;
    const unsubscribe = client.onStateChange(() => {
      if (client.getState() === "open" && currentPhase.current === "disconnected")
        void send.current();
    });
    return () => {
      active.current = false;
      unsubscribe();
    };
  }, [client]);
  useEffect(() => {
    if (
      phase === "disconnected" &&
      currentPhase.current === "disconnected" &&
      client.getState() === "open"
    )
      void send.current();
  }, [phase, client]);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open && phase !== "deleting" && phase !== "disconnected") {
      setTargetUid(metadataString(object, "uid"));
      setConfirmation("");
      setImmediate(false);
      setPropagation("background");
      setError(undefined);
      setPhase("ready");
    }
  }
  const owned = related?.sections.find(
    (section) => section.relationship === "owns" && section.direction === "out",
  );
  const counts = new Map<string, number>();
  for (const row of owned?.rows ?? [])
    if (row.status !== "more") counts.set(row.kind, (counts.get(row.kind) ?? 0) + 1);
  const type = types.get(address.name);
  const meta = metadata(object);
  const finalizers = Array.isArray(meta["finalizers"]) ? meta["finalizers"].map(String) : [];
  const busy = phase === "deleting" || phase === "disconnected";
  return (
    <AlertDialog
      open={open}
      onOpenChange={(value) => {
        if (!value && phase !== "deleting") onClose();
      }}
    >
      <AlertDialogContent
        {...clusterScope(address.cluster)}
        initialFocus={namespace || crd ? input : cancel}
        className="max-h-[calc(100dvh-2rem)] overflow-auto text-sm"
      >
        <div className="-mx-4 -mt-4 rounded-t-xl bg-cluster px-4 py-2 font-mono font-semibold text-cluster-foreground">
          {address.cluster}
        </div>
        <AlertDialogTitle>
          Delete {kind} {address.name}?
        </AlertDialogTitle>
        {address.namespace && (
          <AlertDialogDescription>in {address.namespace}</AlertDialogDescription>
        )}
        {namespace &&
          (count.data ? (
            <p>
              This deletes every Resource in the Namespace: at least {count.data.total} Resources.
            </p>
          ) : count.error ? (
            <p>The Resource count is unavailable.</p>
          ) : (
            <Skeleton className="h-4 w-full" />
          ))}
        {crd && (
          <p>
            This deletes every {type?.kind ?? "Resource of this type"} in the Cluster:{" "}
            {type?.count ?? 0} Resources.
          </p>
        )}
        {!!owned?.total && (
          <p>
            It owns {owned.total} Resources:{" "}
            {[...counts]
              .map(([name, total]) => `${total} ${name}${total === 1 ? "" : "s"}`)
              .join(" and ")}
            {owned.truncated ? " (at least)" : ""}.
          </p>
        )}
        {(!!owned?.total || !related) && (
          <div className="flex flex-wrap items-center gap-2">
            <span id={dependentsId}>What happens to the Resources it owns</span>
            <Select
              items={[
                { value: "background", label: "Delete them too" },
                { value: "foreground", label: "Delete them first" },
                { value: "orphan", label: "Leave them" },
              ]}
              value={propagation}
              onValueChange={(value) => {
                if (value) setPropagation(value);
              }}
            >
              <SelectTrigger aria-labelledby={dependentsId} disabled={busy}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="background">Delete them too</SelectItem>
                <SelectItem value="foreground">Delete them first</SelectItem>
                <SelectItem value="orphan">Leave them</SelectItem>
              </SelectContent>
            </Select>
          </div>
        )}
        {!!meta["deletionTimestamp"] && (
          <p>
            It is already terminating and waits for: {finalizers.join(", ") || "deletion to finish"}
            .
          </p>
        )}
        {address.type === "pods" && (
          <>
            <label htmlFor={immediateId} className="flex items-center gap-2">
              <Checkbox
                id={immediateId}
                checked={immediate}
                onCheckedChange={setImmediate}
                disabled={busy}
              />
              Delete immediately
            </label>
            {immediate && (
              <p className="text-warning">
                The containers may keep running after the Pod is deleted.
              </p>
            )}
          </>
        )}
        {(namespace || crd) && (
          <label htmlFor={nameId} className="flex flex-col gap-2">
            Type the name to confirm
            <Input
              id={nameId}
              ref={input}
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
              disabled={busy}
            />
          </label>
        )}
        {phase === "disconnected" && (
          <p role="alert">
            Lost the connection to the Engine while deleting. hukube checks the result when it
            reconnects.
          </p>
        )}
        {phase === "failed" && (
          <div role="alert">
            <p>
              {error?.code === "forbidden"
                ? "Not permitted"
                : error?.code === "conflict"
                  ? `This ${kind} was replaced by a new one of the same name. Nothing was deleted.`
                  : error?.message}
            </p>
            {error?.code === "forbidden" && <p>{error.message}</p>}
          </div>
        )}
        <AlertDialogFooter>
          <Button ref={cancel} variant="outline" disabled={phase === "deleting"} onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={
              busy ||
              ((namespace || crd) && confirmation !== address.name) ||
              (phase === "failed" && (error?.code === "forbidden" || error?.code === "conflict"))
            }
            onClick={() => {
              pending.current = {
                cluster: address.cluster,
                type: address.type,
                namespace: address.namespace,
                name: address.name,
                uid: targetUid,
                propagation,
                immediate,
              };
              void send.current();
            }}
          >
            {phase === "deleting" ? "Deleting…" : phase === "failed" ? "Try again" : "Delete"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
