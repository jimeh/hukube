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
import { useEffect, useEffectEvent, useRef, useState, useSyncExternalStore } from "react";
import { Notice } from "../resource/notice.tsx";
import { LogDocument } from "./log-document.ts";
import LogEditor, { type LogEditorHandle } from "./log-editor.tsx";
import { LogLoading } from "./log-loading.tsx";
import { useLogSettings } from "./log-settings.ts";
import { LogToolbar } from "./log-toolbar.tsx";

interface KnownContainers {
  containers: LogContainer[];
  hasPrevious: boolean;
}

interface ReplayFingerprint {
  value: string;
  epochs: Set<string>;
  sources: Map<number, { previous: boolean; instance: string }>;
}

interface PreviousEpoch {
  source: number;
  instance: string;
  owner: "committed" | "staged";
  complete: boolean;
  unresolved: boolean;
  untimed: boolean;
}

interface PreviousHandle {
  staged: LogDocument;
  fingerprint?: ReplayFingerprint;
  socketEpochs: Map<number, string>;
  epochs: Map<string, PreviousEpoch>;
  stagedBySource: Map<number, string>;
  pendingChange: boolean;
}

const sourceEpoch = (id: number, instance: string): string => JSON.stringify([id, instance]);

function replayFingerprint(status: LogStreamStatus | undefined): ReplayFingerprint | undefined {
  if (!status?.ready || status.loaded < status.followed) return undefined;
  if (status.sources.some((source) => source.previous && !source.instance)) return undefined;
  const sources = new Map<number, { previous: boolean; instance: string }>();
  const epochs = new Set<string>();
  const canonical = status.sources
    .toSorted((a, b) => a.id - b.id)
    .map((source) => {
      const instance = source.previous ? (source.instance ?? "") : "";
      sources.set(source.id, { previous: source.previous ?? false, instance });
      if (source.previous) epochs.add(sourceEpoch(source.id, instance));
      return [source.id, source.previous ?? false, instance] as const;
    });
  return { value: JSON.stringify(canonical), epochs, sources };
}

function integrityEnd(
  reason: "ProtocolViolation" | "ReplayIncomplete",
  message: string,
): StreamEnd {
  return { reason: "error", error: { code: "internal", reason, message } };
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
      key={JSON.stringify([
        target.cluster,
        target.type,
        target.namespace,
        target.name,
        container,
        previous,
        run,
      ])}
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
}: LogStreamViewProps & {
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
  const { containers } = known;
  const [state, setState] = useState<StreamState>("connecting");
  const [end, setEnd] = useState<StreamEnd>();
  const startedUid = initialUid;
  const stream = useRef<EngineStream | undefined>(undefined);
  const hiddenTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const editor = useRef<LogEditorHandle>(null);
  const { timestamps, wrap, budgets } = useLogSettings();
  const { cluster, type, namespace, name } = target;
  const [document] = useState(() => new LogDocument(type, budgets));
  const replayCandidate = useRef<PreviousHandle | undefined>(undefined);
  useSyncExternalStore(document.subscribe, document.snapshot);
  const current = useEffectEvent(() => visible);
  const remember = useEffectEvent(setKnown);
  useEffect(() => {
    if (!initialUid) return;
    const incarnation = initialUid;
    let active = true;
    let handle: EngineStream | undefined;
    let pods: Map<string, string> | undefined;
    let replay: PreviousHandle | undefined = previous
      ? {
          staged: document.emptyFork(),
          socketEpochs: new Map(),
          epochs: new Map(),
          stagedBySource: new Map(),
          pendingChange: false,
        }
      : undefined;
    replayCandidate.current = replay;
    const releaseReplay = () => {
      replay?.staged.release();
      replay?.socketEpochs.clear();
      replay?.epochs.clear();
      replay?.stagedBySource.clear();
      if (replayCandidate.current === replay) replayCandidate.current = undefined;
      replay = undefined;
    };
    const failIntegrity = (reason: "ProtocolViolation" | "ReplayIncomplete", message: string) => {
      if (!active) return;
      releaseReplay();
      active = false;
      handle?.close();
      if (stream.current === handle) stream.current = undefined;
      setState("ended");
      setEnd(integrityEnd(reason, message));
    };
    const droppedMarker = (targetDocument: LogDocument, records: number) => {
      targetDocument.marker(
        `··· ${records.toLocaleString()} lines dropped: they arrived faster than they could be shown ···`,
      );
    };
    const replayUnsafe = () =>
      !!replay &&
      [...replay.epochs.values()].some(
        (epoch) => !epoch.complete && (epoch.unresolved || epoch.untimed),
      );
    const classifySource = (source: LogStreamStatus["sources"][number], definitive: boolean) => {
      const candidate = replay!;
      const superseded = candidate.stagedBySource.get(source.id);
      if (!source.previous) {
        if (definitive && superseded) {
          candidate.staged.discardSources(new Set([source.id]));
          candidate.epochs.delete(superseded);
          candidate.stagedBySource.delete(source.id);
        }
        return;
      }
      if (!source.instance) return;
      const key = sourceEpoch(source.id, source.instance);
      const owner = candidate.fingerprint?.epochs.has(key) ? "committed" : "staged";
      if (superseded && superseded !== key) {
        candidate.staged.discardSources(new Set([source.id]));
        candidate.epochs.delete(superseded);
        candidate.stagedBySource.delete(source.id);
      }
      if (owner === "staged") {
        candidate.stagedBySource.set(source.id, key);
      } else candidate.stagedBySource.delete(source.id);
      const prior = candidate.epochs.get(key);
      candidate.epochs.set(
        key,
        prior ?? {
          source: source.id,
          instance: source.instance,
          owner,
          complete: false,
          unresolved: false,
          untimed: false,
        },
      );
      candidate.socketEpochs.set(source.id, key);
    };
    handle = engine.openStream(
      "resource.logs",
      { cluster, type, namespace, name, uid: incarnation, container, previous },
      {
        state: (value) => {
          if (!active) return;
          if ((value === "reconnecting" || value === "paused") && replayUnsafe()) {
            failIntegrity(
              "ReplayIncomplete",
              "The previous-run replay could not resume safely after an incomplete source boundary.",
            );
            return;
          }
          setState(value);
        },
        event: (value) => {
          if (!active) return;
          if (!previous) document.status(value);
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
          // The last status of a deleted Resource lists none, and the names stay.
          if (value.containers.length)
            remember({
              containers: value.containers,
              hasPrevious: value.sources.some((source) => source.previous),
            });
          if (!previous) {
            return;
          }
          const candidate = replay;
          if (!candidate) {
            failIntegrity(
              "ProtocolViolation",
              "The previous-run handle sent status without an owner.",
            );
            return;
          }
          candidate.socketEpochs.clear();
          candidate.staged.status(value);
          const definitive = value.ready && value.loaded >= value.followed;
          for (const source of value.sources) {
            const committed = candidate.fingerprint?.sources.get(source.id);
            const resolved = source.previous ? !!source.instance : definitive;
            if (
              candidate.fingerprint &&
              resolved &&
              (!committed ||
                committed.previous !== (source.previous ?? false) ||
                (committed.previous && committed.instance !== source.instance))
            )
              candidate.pendingChange = true;
            classifySource(source, definitive);
          }
          const fingerprint = replayFingerprint(value);
          if (!fingerprint) return;
          for (const [source, epoch] of candidate.stagedBySource)
            if (!fingerprint.epochs.has(epoch)) {
              candidate.staged.discardSources(new Set([source]));
              candidate.stagedBySource.delete(source);
              candidate.epochs.delete(epoch);
            }
          if (candidate.fingerprint?.value === fingerprint.value) {
            document.status(value);
            candidate.pendingChange = false;
            return;
          }
          const changed = new Set<number>();
          for (const [source, oldEpoch] of candidate.fingerprint?.sources ?? []) {
            const nextEpoch = fingerprint.sources.get(source);
            if (
              !nextEpoch ||
              oldEpoch.previous !== nextEpoch.previous ||
              oldEpoch.instance !== nextEpoch.instance
            )
              changed.add(source);
          }
          document.reconcile(candidate.staged, changed, value);
          candidate.staged = document.emptyFork();
          candidate.stagedBySource.clear();
          candidate.pendingChange = false;
          for (const [key, epoch] of candidate.epochs) {
            if (fingerprint.epochs.has(key)) epoch.owner = "committed";
            else candidate.epochs.delete(key);
          }
          candidate.fingerprint = fingerprint;
        },
        data: (lines) => {
          if (!active) return;
          if (!previous) {
            if (lines.length) document.append(lines);
            return;
          }
          const candidate = replay;
          if (!candidate) {
            failIntegrity(
              "ProtocolViolation",
              "The previous-run handle sent data without an owner.",
            );
            return;
          }
          for (const line of lines) {
            const key = candidate.socketEpochs.get(line.source);
            const epoch = key ? candidate.epochs.get(key) : undefined;
            if (!epoch) {
              failIntegrity(
                "ProtocolViolation",
                "The previous-run socket sent a line before its source instance.",
              );
              return;
            }
            if (epoch.complete) continue;
            (epoch.owner === "committed" ? document : candidate.staged).append([line]);
            if (line.exited) {
              epoch.complete = true;
              epoch.unresolved = false;
              epoch.untimed = false;
            } else if (line.gap) {
              epoch.unresolved = true;
            } else if (line.time) {
              epoch.unresolved = false;
              epoch.untimed = false;
            } else epoch.untimed = true;
          }
        },
        gap: (gap) => {
          if (!active) return;
          if (!previous) {
            droppedMarker(document, gap.records);
            return;
          }
          const candidate = replay;
          if (!candidate || !gap.sources?.length) {
            failIntegrity(
              "ProtocolViolation",
              "The previous-run socket sent a gap without source totals.",
            );
            return;
          }
          const committedLoss = [] as {
            source: number;
            instance: string;
            records: number;
          }[];
          const stagedLoss = [] as typeof committedLoss;
          for (const source of gap.sources) {
            const key = candidate.socketEpochs.get(source.id);
            const epoch = key ? candidate.epochs.get(key) : undefined;
            if (!epoch) {
              failIntegrity(
                "ProtocolViolation",
                "The previous-run socket sent a gap before its source instance.",
              );
              return;
            }
            if (!epoch.complete) epoch.unresolved = true;
            (epoch.owner === "committed" ? committedLoss : stagedLoss).push({
              source: epoch.source,
              instance: epoch.instance,
              records: source.records,
            });
          }
          if (committedLoss.length) document.lossMarker(committedLoss);
          if (stagedLoss.length) candidate.staged.lossMarker(stagedLoss);
        },
        end: (value) => {
          if (!active) return;
          if (!previous || value.reason === "error") {
            releaseReplay();
            setEnd(value);
            return;
          }
          const classified = replay?.fingerprint;
          const staged = replay?.staged.diagnostics().entries ?? 0;
          const pendingChange = replay?.pendingChange || !!replay?.stagedBySource.size;
          releaseReplay();
          setEnd(
            classified && staged === 0 && !pendingChange
              ? value
              : classified
                ? integrityEnd(
                    "ReplayIncomplete",
                    "The previous-run replay ended before its changed source set was definitive.",
                  )
                : integrityEnd(
                    "ProtocolViolation",
                    "The previous-run replay ended before its source instances were complete.",
                  ),
          );
        },
      },
    );
    stream.current = handle;
    if (!current()) hiddenTimer.current = setTimeout(() => handle?.pause(), 10_000);
    return () => {
      active = false;
      releaseReplay();
      clearTimeout(hiddenTimer.current);
      handle?.close();
      stream.current = undefined;
    };
  }, [engine, cluster, type, namespace, name, initialUid, container, previous, document]);
  useEffect(() => {
    clearTimeout(hiddenTimer.current);
    if (visible) stream.current?.resume();
    else hiddenTimer.current = setTimeout(() => stream.current?.pause(), 10_000);
    return () => clearTimeout(hiddenTimer.current);
  }, [visible]);
  useEffect(() => {
    document.updateBudgets(budgets);
    replayCandidate.current?.staged.updateBudgets(budgets);
  }, [document, budgets]);
  useEffect(() => {
    document.timestamps(timestamps);
    replayCandidate.current?.staged.timestamps(timestamps);
  }, [document, timestamps]);

  const status = document.displayedStatus;
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
      title: "Waiting for a free stream",
      description:
        "hukube runs 8 Log Streams and Exec Sessions at a time in a window. This one starts when another is closed or hidden.",
    };
  else if (end?.reason === "error") {
    loading = false;
    if (end.error?.code === "forbidden")
      empty = { title: "Not permitted", description: end.error.message, action: action() };
    else if (end.error?.reason === "ReplayIncomplete" || end.error?.reason === "ProtocolViolation")
      notices.push({
        text: `${end.error.reason}: ${end.error.message}`,
        destructive: true,
        action: action(),
      });
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
        containers={containers}
        container={container}
        previous={previous}
        hasPrevious={known.hasPrevious}
        disabled={containers.length === 0}
        ended={end?.reason === "deleted"}
        focus={focus}
        select={setContainer}
        setPrevious={setPrevious}
        search={() => editor.current?.search()}
      />
      {document.retentionLoss && (
        <output className="flex shrink-0 flex-wrap items-center gap-2 border-b border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning">
          <span className="min-w-0 flex-1 break-words">
            Older log entries were discarded to stay within retention limits and cannot be restored.
          </span>
          <Button size="sm" variant="ghost" onClick={() => document.dismissRetentionLoss()}>
            Dismiss
          </Button>
        </output>
      )}
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
