import type { EngineStream, LogStreamStatus, StreamEnd, StreamState } from "@hukube/engine-client";
import { useEngine } from "@hukube/engine-client/react";
import type { ResourceAddress } from "@hukube/k8s";
import { Button } from "@hukube/ui/components/button";
import { cn } from "@hukube/ui/lib/utils";
import { useEffect, useEffectEvent, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Notice } from "../resource/notice.tsx";
import { LogDocument } from "./log-document.ts";
import LogEditor, { type LogEditorHandle } from "./log-editor.tsx";
import { LogLoading } from "./log-loading.tsx";
import { useLogSettings } from "./log-settings.ts";
import { LogToolbar } from "./log-toolbar.tsx";

export interface LogStreamViewProps {
  target: Pick<ResourceAddress, "cluster" | "type" | "namespace" | "name">;
  uid?: string;
  exists?: boolean;
  kind: string;
  visible: boolean;
}

/** A Log Stream with no dependency on Resource tabs or Facets. */
export default function LogStreamView({ target, uid, exists, kind, visible }: LogStreamViewProps) {
  const [container, setContainer] = useState("");
  const [previous, setPrevious] = useState(false);
  const [run, setRun] = useState(0);
  const [initialUid, setInitialUid] = useState<string>();
  if (!initialUid && exists && uid) setInitialUid(uid);
  const restart = () => {
    if (uid) setInitialUid(uid);
    setRun((value) => value + 1);
  };
  return (
    <LogRun
      key={JSON.stringify([container, previous, run])}
      target={target}
      uid={uid}
      exists={exists}
      kind={kind}
      visible={visible}
      initialUid={initialUid}
      container={container}
      previous={previous}
      setContainer={setContainer}
      setPrevious={setPrevious}
      restart={restart}
    />
  );
}

function LogRun({
  target,
  uid,
  exists,
  kind,
  visible,
  initialUid,
  container,
  previous,
  setContainer,
  setPrevious,
  restart,
}: LogStreamViewProps & {
  initialUid?: string;
  container: string;
  previous: boolean;
  setContainer: (value: string) => void;
  setPrevious: (value: boolean) => void;
  restart: () => void;
}) {
  const engine = useEngine();
  const [status, setStatus] = useState<LogStreamStatus>();
  const [state, setState] = useState<StreamState>("connecting");
  const [end, setEnd] = useState<StreamEnd>();
  const startedUid = initialUid;
  const stream = useRef<EngineStream | undefined>(undefined);
  const hiddenTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const editor = useRef<LogEditorHandle>(null);
  const { timestamps, wrap } = useLogSettings();
  const { cluster, type, namespace, name } = target;
  const document = useMemo(() => new LogDocument(type, name), [type, name]);
  useSyncExternalStore(document.subscribe, document.snapshot);
  const current = useEffectEvent(() => visible);
  // A tab restored behind another one reads nothing until it is first shown.
  const [shown, setShown] = useState(visible);
  if (visible && !shown) setShown(true);
  useEffect(() => {
    if (!initialUid || !shown) return;
    const incarnation = initialUid;
    let active = true;
    let socketReady = false;
    let pods: Map<string, string> | undefined;
    const handle = engine.openStream(
      "resource.logs",
      { cluster, type, namespace, name, uid: incarnation, container, previous },
      {
        state: (value) => {
          if (!active) return;
          setState(value);
          if (value === "connecting" || value === "reconnecting") socketReady = false;
        },
        event: (value) => {
          if (!active) return;
          if (previous && value.ready && !socketReady) document.clear();
          if (value.ready) socketReady = true;
          document.status(value);
          if (value.ready) {
            const next = new Map(value.sources.map((source) => [source.podUid, source.pod]));
            if (type !== "pods" && pods && !previous) {
              for (const [id, pod] of next)
                if (!pods.has(id)) document.marker(`··· following Pod ${pod} ···`);
              for (const [id, pod] of pods)
                if (!next.has(id)) document.marker(`··· Pod ${pod} is gone ···`);
            }
            pods = next;
          }
          setStatus(value);
        },
        data: (lines) => {
          if (active) document.append(lines);
        },
        gap: (gap) => {
          if (active)
            document.marker(
              `··· ${gap.records.toLocaleString()} lines dropped: they arrived faster than they could be shown ···`,
            );
        },
        end: (value) => {
          if (active) setEnd(value);
        },
      },
    );
    stream.current = handle;
    if (!current()) hiddenTimer.current = setTimeout(() => handle.pause(), 10_000);
    return () => {
      active = false;
      clearTimeout(hiddenTimer.current);
      handle.close();
      stream.current = undefined;
    };
  }, [engine, cluster, type, namespace, name, initialUid, container, previous, document, shown]);
  useEffect(() => {
    clearTimeout(hiddenTimer.current);
    if (visible) stream.current?.resume();
    else hiddenTimer.current = setTimeout(() => stream.current?.pause(), 10_000);
    return () => clearTimeout(hiddenTimer.current);
  }, [visible]);
  useEffect(() => document.timestamps(timestamps), [document, timestamps]);

  const sources = status?.sources ?? [];
  const count = sources.length;
  const one = count === 1;
  const hasLines = document.rows.length > 0;
  const waiting = sources.filter((source) => source.state === "waiting");
  // An init container that completed is where it should be, not a problem to report.
  const initContainers = new Set(
    (status?.containers ?? []).filter((item) => item.kind === "init").map((item) => item.name),
  );
  const notRunning = sources.filter(
    (source) =>
      source.state !== "running" &&
      !(
        source.state === "terminated" &&
        source.exitCode === 0 &&
        initContainers.has(source.container)
      ),
  );
  const unreadable = sources.filter((source) => source.error);
  const recreated = !!startedUid && !!uid && uid !== startedUid;
  const action = (label = "Try again") => (
    <Button variant="outline" size="sm" onClick={restart}>
      {label}
    </Button>
  );
  const notices: {
    text: string;
    destructive?: boolean;
    title?: string;
    action?: React.ReactNode;
  }[] = [];
  let empty: { title: string; description: string; action?: React.ReactNode } | undefined;
  let loading =
    exists === undefined || (!!initialUid && !status?.ready && !end && state !== "waiting");
  if (!initialUid && exists === false)
    empty = {
      title: "Not found",
      description: `No ${kind} named ${name} exists right now. Its logs appear here if it is created.`,
    };
  else if (recreated)
    notices.push({
      text: `This ${kind} was deleted and created again.`,
      action: action("Show its logs"),
    });
  else if (end?.reason === "deleted")
    notices.push({ text: `This ${kind} was deleted. These are the last lines it printed.` });
  if (state === "reconnecting")
    notices.push({ text: "Connection to the Engine lost. Reconnecting…", destructive: true });
  if (state === "waiting")
    empty = {
      title: "Waiting for a free Log Stream",
      description:
        "hukube runs 8 at a time. This one starts when another Logs Facet is closed or hidden.",
    };
  else if (end?.reason === "error") {
    loading = false;
    if (end.error?.code === "forbidden")
      empty = { title: "Not permitted", description: end.error.message, action: action() };
    else
      notices.push({
        text: `The Log Stream stopped: ${end.error?.message ?? "Unknown error"}.`,
        destructive: true,
        action: action(),
      });
  } else if (status?.ready && !hasLines) {
    if (type !== "pods" && status.pods === 0)
      empty = {
        title: "No Pods",
        description: `This ${kind} owns no Pods right now. Lines appear here when it does.`,
      };
    else if (previous && !sources.some((source) => source.previous))
      empty = { title: "No previous run", description: "No selected container has restarted." };
    else if (count > 0 && waiting.length === count)
      empty = {
        title: one ? "Waiting for the container to start" : "Waiting for containers to start",
        description:
          waiting
            .slice(0, 3)
            .map(
              (source) =>
                `${source.container}: ${source.reason ?? "Waiting"}${source.message ? `\n${source.message}` : ""}`,
            )
            .join("\n") + (waiting.length > 3 ? `\nand ${waiting.length - 3} more` : ""),
      };
    else
      empty = {
        title: "No log lines yet",
        description: `${one ? `${sources[0]!.container} has` : "These containers have"} not printed anything. Lines appear here as ${one ? "it does" : "they do"}.`,
      };
  }
  if (previous && status?.ready && !(empty?.title === "No previous run"))
    notices.push({
      text: one
        ? `The previous run of ${sources[0]!.container}.`
        : `The previous runs of ${count} containers.`,
    });
  // Once the stream has ended, what its containers were doing is history.
  if (!end && hasLines && !previous && notRunning.length)
    notices.push({
      text: one
        ? `${notRunning[0]!.container} is not running: ${notRunning[0]!.reason ?? notRunning[0]!.state}.${notRunning[0]!.message ? ` ${notRunning[0]!.message}` : ""}`
        : `${notRunning.length} of ${count} containers are not running.`,
    });
  if (!end && unreadable.length)
    notices.push({
      text: one
        ? `Cannot read the logs of ${unreadable[0]!.container}: ${unreadable[0]!.error}. hukube keeps trying.`
        : `Cannot read the logs of ${unreadable.length} containers. hukube keeps trying.`,
      destructive: true,
      title: unreadable[0]!.error,
    });
  if (status && status.pods > status.followed)
    notices.push({
      text: `Showing the ${status.followed} newest of ${status.pods} Pods. Open a Pod to see its own logs.`,
    });
  if (hasLines && empty) {
    notices.push({
      text: `${empty.title}${empty.title === "Not permitted" ? ":" : "."} ${empty.description}`,
      destructive: empty.title === "Not permitted",
      action: empty.action,
    });
    empty = undefined;
  }
  return (
    <div className="flex h-full min-h-0 flex-col">
      <LogToolbar
        containers={status?.containers ?? []}
        container={container}
        previous={previous}
        hasPrevious={sources.some((source) => source.previous)}
        disabled={loading || !status?.ready}
        select={setContainer}
        setPrevious={setPrevious}
        search={() => editor.current?.search()}
      />
      {notices.map((notice, index) => (
        <output
          key={index}
          title={notice.title}
          className={cn(
            "flex shrink-0 flex-wrap items-center gap-2 border-b px-3 py-2",
            notice.destructive ? "text-destructive" : "text-muted-foreground",
          )}
        >
          <span className="min-w-0 flex-1 break-words">{notice.text}</span>
          {notice.action}
        </output>
      ))}
      <div className="min-h-0 flex-1">
        {hasLines ? (
          <LogEditor
            ref={editor}
            document={document}
            wrap={wrap}
            label={`Logs of ${kind} ${name}`}
          />
        ) : loading ? (
          <LogLoading />
        ) : empty ? (
          <Notice {...empty} />
        ) : (
          <Notice
            title="No log lines yet"
            description="These containers have not printed anything. Lines appear here as they do."
          />
        )}
      </div>
    </div>
  );
}
