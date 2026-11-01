import {
  LogStreamMaxPods,
  type EngineStream,
  type LogContainer,
  type LogStreamStatus,
  type StreamEnd,
  type StreamState,
} from "@hukube/engine-client";
import { useEngine } from "@hukube/engine-client/react";
import type { ResourceAddress } from "@hukube/k8s";
import { Button } from "@hukube/ui/components/button";
import { cn } from "@hukube/ui/lib/utils";
import {
  useEffect,
  useEffectEvent,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { Notice } from "../resource/notice.tsx";
import { LogDocument } from "./log-document.ts";
import LogEditor, { type LogEditorHandle } from "./log-editor.tsx";
import { emptyLogFilter, hasLogFilter } from "./log-filter.ts";
import { LogFilters, useLogFilters, type LogFiltersState } from "./log-filters.tsx";
import { LogLoading } from "./log-loading.tsx";
import { useLogSettings } from "./log-settings.ts";
import { LogToolbar } from "./log-toolbar.tsx";

interface KnownContainers {
  containers: LogContainer[];
  hasPrevious: boolean;
}

export interface LogStreamViewProps {
  target: Pick<ResourceAddress, "cluster" | "type" | "namespace" | "name">;
  uid?: string;
  exists?: boolean;
  kind: string;
  visible: boolean;
}

/** A Log Stream with no dependency on Resource tabs or Facets. */
export default function LogStreamView({ target, uid, exists, kind, visible }: LogStreamViewProps) {
  const filters = useLogFilters();
  const [container, setContainer] = useState("");
  const [previous, setPrevious] = useState(false);
  const [run, setRun] = useState(0);
  const [initialUid, setInitialUid] = useState<string>();
  // A view reads nothing until it is first shown, and then reads the Resource
  // as it is at that moment: a tab restored behind another one may never be
  // looked at, and its Resource may be gone by the time it is.
  const [shown, setShown] = useState(visible);
  if (visible && !shown) setShown(true);
  if (shown && !initialUid && exists && uid) setInitialUid(uid);
  // Choosing a container or a run starts a new stream and replaces the
  // toolbar. What the last stream said about the containers stays, so the
  // controls are there at once and the one that was used keeps focus.
  const [focus, setFocus] = useState<"container" | "previous">();
  const [known, setKnown] = useState<KnownContainers>({ containers: [], hasPrevious: false });
  const restart = () => {
    if (uid) setInitialUid(uid);
    setFocus(undefined);
    setRun((value) => value + 1);
  };
  return (
    <LogRun
      key={JSON.stringify([container, previous, run])}
      filters={filters}
      focus={focus}
      known={known}
      setKnown={setKnown}
      target={target}
      uid={uid}
      exists={exists}
      kind={kind}
      visible={visible}
      initialUid={initialUid}
      container={container}
      previous={previous}
      setContainer={(value) => {
        setFocus("container");
        setContainer(value);
      }}
      setPrevious={(value) => {
        setFocus("previous");
        setPrevious(value);
      }}
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
  focus,
  known,
  setKnown,
  filters,
}: LogStreamViewProps & {
  filters: LogFiltersState;
  initialUid?: string;
  focus?: "container" | "previous";
  known: KnownContainers;
  setKnown: (value: KnownContainers) => void;
  container: string;
  previous: boolean;
  setContainer: (value: string) => void;
  setPrevious: (value: boolean) => void;
  restart: () => void;
}) {
  const engine = useEngine();
  const [status, setStatus] = useState<LogStreamStatus>();
  const { containers } = known;
  const [state, setState] = useState<StreamState>("connecting");
  const [end, setEnd] = useState<StreamEnd>();
  const startedUid = initialUid;
  const stream = useRef<EngineStream | undefined>(undefined);
  const hiddenTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const editor = useRef<LogEditorHandle>(null);
  const toolbar = useRef<HTMLDivElement>(null);
  const filterButton = useRef<HTMLButtonElement>(null);
  const includeInput = useRef<HTMLInputElement>(null);
  const filterId = useId();
  const clearFilters = (returnFocus = false) => {
    document.filter(emptyLogFilter);
    filters.clear();
    if (returnFocus) (filters.expanded ? includeInput : filterButton).current?.focus();
  };
  const [acknowledgedLoss, setAcknowledgedLoss] = useState<{
    document: symbol;
    generation: number;
  }>();
  const { wrap } = useLogSettings();
  const { cluster, type, namespace, name } = target;
  const [document, documentIdentity] = useMemo(
    // A new run must project its first batch with the already applied criteria.
    () => [new LogDocument(type, undefined, filters.applied), Symbol()] as const,
    // Filter edits update this document in place, never replace its editor or stream.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
    [type],
  );
  useSyncExternalStore(document.subscribe, document.snapshot);
  useEffect(() => document.filter(filters.applied), [document, filters.applied]);
  useEffect(() => {
    const apply = () => {
      const settings = useLogSettings.getState();
      document.applyPreferences({
        timestamps: settings.timestamps,
        lines: settings.maxLines,
        characters: settings.maxCharacters,
        decorations: settings.maxDecorations,
      });
    };
    apply();
    return useLogSettings.subscribe(apply);
  }, [document]);
  const current = useEffectEvent(() => visible);
  const remember = useEffectEvent(setKnown);
  useEffect(() => {
    if (!initialUid) return;
    const incarnation = initialUid;
    let active = true;
    // A previous run is sent whole on every socket, so a second socket's
    // lines replace the first's. They are cleared when the new socket
    // delivers something, not when it is ready, which comes after its lines.
    let delivered = false;
    let replaying = false;
    const replace = () => {
      delivered = true;
      if (!replaying) return;
      replaying = false;
      document.clear();
    };
    let pods: Map<string, string> | undefined;
    const handle = engine.openStream(
      "resource.logs",
      { cluster, type, namespace, name, uid: incarnation, container, previous },
      {
        state: (value) => {
          if (!active) return;
          setState(value);
          if (value === "connecting" || value === "reconnecting") replaying = previous && delivered;
        },
        event: (value) => {
          if (!active) return;
          if (value.sources.length) replace();
          document.status(value);
          const next = new Map(value.sources.map((source) => [source.podUid, source.pod]));
          // A status can be ready before a slow Pod's containers are known.
          // Only one whose Pods are all loaded says who joined and who left.
          if (value.ready && value.loaded >= value.followed) {
            if (type !== "pods" && pods && !previous) {
              for (const [id, pod] of next)
                if (!pods.has(id)) document.marker(`··· following Pod ${pod} ···`);
              for (const [id, pod] of pods)
                if (!next.has(id)) document.marker(`··· Pod ${pod} is gone ···`);
            }
            pods = next;
          }
          setStatus(value);
          // The last status of a deleted Resource lists none, and the names stay.
          if (value.containers.length)
            remember({
              containers: value.containers,
              hasPrevious: value.sources.some((source) => source.previous),
            });
        },
        data: (lines) => {
          if (!active) return;
          replace();
          document.append(lines);
        },
        gap: (gap) => {
          if (active)
            document.marker(
              `··· ${gap.records.toLocaleString()} lines dropped: they arrived faster than they could be shown ···`,
            );
        },
        end: (value) => {
          if (active) {
            document.end();
            setEnd(value);
          }
        },
      },
    );
    stream.current = handle;
    const references = () => handle.retainSources?.(document.retainedSources());
    references();
    const stopReferences = document.subscribe(references);
    if (!current()) hiddenTimer.current = setTimeout(() => handle.pause(), 10_000);
    return () => {
      active = false;
      clearTimeout(hiddenTimer.current);
      stopReferences();
      handle.close();
      stream.current = undefined;
    };
  }, [engine, cluster, type, namespace, name, initialUid, container, previous, document]);
  useEffect(() => {
    clearTimeout(hiddenTimer.current);
    if (visible) stream.current?.resume();
    else hiddenTimer.current = setTimeout(() => stream.current?.pause(), 10_000);
    return () => clearTimeout(hiddenTimer.current);
  }, [visible]);

  const sources = status?.sources ?? [];
  const count = sources.length;
  const one = count === 1;
  const hasLines = document.rows.length > 0;
  const hasProjection = document.projectedRows > 0;
  const activeFilter = hasLogFilter(filters.applied);
  const noMatches = document.retainedLines > 0 && document.matchingLines === 0;
  const [hadLines, setHadLines] = useState(false);
  if (hasLines && !hadLines) setHadLines(true);
  const waiting = sources.filter((source) => source.state === "waiting");
  // An init container that completed is where it should be, not a problem to report.
  const initContainers = new Set(
    containers.filter((item) => item.kind === "init").map((item) => item.name),
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
      title: "Waiting for a free stream",
      description:
        "hukube runs 8 Log Streams and Exec Sessions at a time in a window. This one starts when another is closed or hidden.",
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
    else if (previous)
      // A previous run is read once, so nothing more will come.
      empty = {
        title: "No lines from the previous run",
        description: unreadable.length
          ? `Its logs are no longer available: ${unreadable[0]!.error}`
          : "The previous run printed nothing.",
      };
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
  if (previous && status?.ready && hasLines) {
    notices.push({
      text: one
        ? `The previous run of ${sources[0]!.container}.`
        : `The previous runs of ${count} containers.`,
    });
    if (unreadable.length)
      notices.push({
        text: one
          ? `The previous run of ${unreadable[0]!.container} could not be read: ${unreadable[0]!.error}`
          : `The previous runs of ${unreadable.length} containers could not be read.`,
        destructive: true,
        title: unreadable[0]!.error,
      });
  }
  // Once the stream has ended, what its containers were doing is history.
  if (!end && !previous) {
    // The status message can be a paragraph from the kubelet. The reason fits a line.
    if (hasLines && notRunning.length)
      notices.push({
        text: one
          ? `${notRunning[0]!.container} is not running: ${notRunning[0]!.reason ?? notRunning[0]!.state}.`
          : `${notRunning.length} of ${count} containers ${notRunning.length === 1 ? "is" : "are"} not running.`,
        title: notRunning.map((source) => source.message).find(Boolean),
      });
    if (unreadable.length)
      notices.push({
        text: one
          ? `Cannot read the logs of ${unreadable[0]!.container}: ${unreadable[0]!.error}. hukube keeps trying.`
          : `Cannot read the logs of ${unreadable.length} containers. hukube keeps trying.`,
        destructive: true,
        title: unreadable[0]!.error,
      });
    // Fewer are read than exist for a moment whenever Pods come and go.
    if (status?.ready && status.followed >= LogStreamMaxPods && status.pods > status.followed)
      notices.push({
        text: `Showing the ${status.followed} newest of ${status.pods} Pods. Open a Pod to see its own logs.`,
      });
  }
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
        ref={toolbar}
        containers={containers}
        container={container}
        previous={previous}
        hasPrevious={known.hasPrevious}
        disabled={containers.length === 0}
        ended={end?.reason === "deleted"}
        focus={focus}
        select={setContainer}
        setPrevious={setPrevious}
        searchDisabled={!hasProjection}
        search={() => editor.current?.search()}
        filterButton={
          <Button
            ref={filterButton}
            variant="ghost"
            aria-label="Filter"
            aria-expanded={filters.expanded}
            aria-controls={filterId}
            onClick={() => {
              if (filters.expanded) filterButton.current?.focus();
              filters.setExpanded(!filters.expanded);
            }}
          >
            Filter{activeFilter ? " · on" : ""}
          </Button>
        }
      >
        <LogFilters
          filters={filters}
          id={filterId}
          includeRef={includeInput}
          clear={() => clearFilters()}
        />
        {(activeFilter || filters.pending) && (
          <div className="flex min-w-0 flex-wrap gap-x-3 gap-y-1 border-t px-3 py-1 text-xs text-muted-foreground">
            {activeFilter && (
              <span>
                {document.matchingLines.toLocaleString()} of{" "}
                {document.retainedLines.toLocaleString()} retained lines match
              </span>
            )}
            {filters.pending && <span>Applying filters…</span>}
            {activeFilter && document.retainedCutLines > 0 && (
              <span>
                {document.retainedCutLines.toLocaleString()} retained{" "}
                {document.retainedCutLines === 1 ? "line was" : "lines were"} cut. Removed text is
                unavailable.
              </span>
            )}
          </div>
        )}
      </LogToolbar>
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
      {visible &&
        document.evictedLines > 0 &&
        (!acknowledgedLoss ||
          acknowledgedLoss.document !== documentIdentity ||
          document.lossGeneration > acknowledgedLoss.generation) && (
          <RetentionNotice
            key={`${type}:${document.lossGeneration}`}
            count={document.evictedLines}
            hasLines={hasLines}
            dismiss={() => {
              setAcknowledgedLoss({
                document: documentIdentity,
                generation: document.lossGeneration,
              });
              toolbar.current?.focus();
            }}
          />
        )}
      {noMatches && (
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b px-3 py-2">
          <div className="min-w-0 flex-[1_1_12rem]">
            <p>No matching lines</p>
            <p className="text-xs text-muted-foreground">
              Filters inspect retained line text. Stream notices stay visible.
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={() => clearFilters(true)}>
            Clear filters
          </Button>
        </div>
      )}
      <div className="min-h-0 flex-1">
        {hadLines && (
          <div className="h-full" hidden={!hasProjection}>
            <LogEditor
              ref={editor}
              document={document}
              wrap={wrap}
              label={`Logs of ${kind} ${name}`}
            />
          </div>
        )}
        {hasLines ? null : document.evictedLines ? (
          <Notice
            title="No retained lines fit"
            description="No line currently fits the retention limits. Increasing a limit permits future lines but does not restore removed content."
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

function RetentionNotice({
  count,
  hasLines,
  dismiss,
}: {
  count: number;
  hasLines: boolean;
  dismiss: () => void;
}) {
  const text = `${count.toLocaleString()} oldest retained lines removed by retention limits.${hasLines ? "" : " No line currently fits the retention limits."}`;
  // Counts continue to update visually; announce only when this loss generation is shown.
  const [announcement] = useState(text);
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-b px-3 py-2 text-muted-foreground">
      <output className="sr-only">{announcement}</output>
      <span className="min-w-0 flex-[1_1_12rem] break-words">{text}</span>
      <Button variant="outline" size="sm" aria-label="Dismiss retention notice" onClick={dismiss}>
        Dismiss
      </Button>
    </div>
  );
}
