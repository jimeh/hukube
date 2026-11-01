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

interface PreviousReplay {
  unchanged?: LogDocument;
  replacement?: LogDocument;
  remaining: Map<string, number>;
  crossed: Map<string, number>;
  epochs: Map<number, string>;
  classified?: ReplayFingerprint;
  mode?: "unchanged" | "replacement";
  committed: boolean;
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

function provenReplayChange(status: LogStreamStatus, fingerprint: ReplayFingerprint): boolean {
  return status.sources.some((source) => {
    const expected = fingerprint.sources.get(source.id);
    if (!expected) return false;
    if ((source.previous ?? false) !== expected.previous) return true;
    return !!source.previous && !!source.instance && source.instance !== expected.instance;
  });
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
  const replayCandidate = useRef<PreviousReplay | undefined>(undefined);
  useSyncExternalStore(document.subscribe, document.snapshot);
  const current = useEffectEvent(() => visible);
  const remember = useEffectEvent(setKnown);
  const restartRun = useEffectEvent(restart);
  useEffect(() => {
    if (!initialUid) return;
    const incarnation = initialUid;
    let active = true;
    let handle: EngineStream | undefined;
    let pods: Map<string, string> | undefined;
    let replay: PreviousReplay | undefined;
    let baselineFingerprint = replayFingerprint(document.displayedStatus)?.value;
    let baselineCounts = new Map<string, number>();
    const releaseReplay = () => {
      replay?.unchanged?.release();
      replay?.replacement?.release();
      replay?.remaining.clear();
      replay?.crossed.clear();
      replay?.epochs.clear();
      if (replayCandidate.current === replay) replayCandidate.current = undefined;
      replay = undefined;
    };
    const beginReplay = () => {
      releaseReplay();
      if (!previous) return;
      replay = {
        unchanged: document.fork(),
        replacement: document.emptyFork(),
        remaining: new Map(baselineCounts),
        crossed: new Map(),
        epochs: new Map(),
        committed: false,
      };
      replayCandidate.current = replay;
    };
    const restartChangedReplay = () => {
      if (!active) return;
      releaseReplay();
      active = false;
      handle?.close();
      restartRun();
    };
    const failIntegrity = (reason: "ProtocolViolation" | "ReplayIncomplete", message: string) => {
      if (!active) return;
      releaseReplay();
      active = false;
      handle?.close();
      setState("ended");
      setEnd(integrityEnd(reason, message));
    };
    const addCount = (counts: Map<string, number>, key: string, count: number): boolean => {
      const next = (counts.get(key) ?? 0) + count;
      if (!Number.isSafeInteger(next)) {
        failIntegrity(
          "ProtocolViolation",
          "The previous-run replay count exceeded its safe range.",
        );
        return false;
      }
      counts.set(key, next);
      return true;
    };
    const droppedMarker = (targetDocument: LogDocument, records: number) => {
      targetDocument.marker(
        `··· ${records.toLocaleString()} lines dropped: they arrived faster than they could be shown ···`,
      );
    };
    const commitCandidate = (
      candidate: PreviousReplay,
      mode: "unchanged" | "replacement",
      fingerprint: ReplayFingerprint,
    ) => {
      const next = mode === "unchanged" ? candidate.unchanged : candidate.replacement;
      if (!next) {
        failIntegrity("ProtocolViolation", "The previous-run replay candidate was unavailable.");
        return;
      }
      baselineFingerprint = fingerprint.value;
      baselineCounts = new Map(candidate.crossed);
      candidate.classified = fingerprint;
      candidate.mode = mode;
      candidate.committed = true;
      if (mode === "unchanged") {
        candidate.replacement?.release();
        candidate.replacement = undefined;
        candidate.unchanged = undefined;
      } else {
        candidate.unchanged?.release();
        candidate.unchanged = undefined;
        candidate.replacement = undefined;
      }
      document.replaceFrom(next);
    };
    const commitUnchangedIfComplete = (candidate: PreviousReplay) => {
      if (
        !candidate.committed &&
        candidate.mode === "unchanged" &&
        candidate.classified &&
        candidate.remaining.size === 0
      )
        commitCandidate(candidate, "unchanged", candidate.classified);
    };
    beginReplay();
    handle = engine.openStream(
      "resource.logs",
      { cluster, type, namespace, name, uid: incarnation, container, previous },
      {
        state: (value) => {
          if (!active) return;
          setState(value);
          if (value === "reconnecting" || (value === "connecting" && !replay)) beginReplay();
          else if (value === "paused") releaseReplay();
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
              "The previous-run socket sent status outside a replay.",
            );
            return;
          }
          candidate.epochs.clear();
          for (const source of value.sources)
            if (source.instance) candidate.epochs.set(source.id, source.instance);
          const fingerprint = replayFingerprint(value);
          if (
            candidate.classified &&
            (provenReplayChange(value, candidate.classified) ||
              (fingerprint && fingerprint.value !== candidate.classified.value))
          ) {
            restartChangedReplay();
            return;
          }
          if (candidate.committed) {
            document.status(value);
            return;
          }
          candidate.unchanged?.status(value);
          candidate.replacement?.status(value);
          if (!fingerprint) return;
          for (const epoch of candidate.crossed.keys())
            if (!fingerprint.epochs.has(epoch)) {
              restartChangedReplay();
              return;
            }
          candidate.classified = fingerprint;
          if (fingerprint.value !== baselineFingerprint) {
            commitCandidate(candidate, "replacement", fingerprint);
            return;
          }
          candidate.mode = "unchanged";
          candidate.replacement?.release();
          candidate.replacement = undefined;
          commitUnchangedIfComplete(candidate);
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
              "The previous-run socket sent data outside a replay.",
            );
            return;
          }
          const epochs: string[] = [];
          for (const line of lines) {
            const instance = candidate.epochs.get(line.source);
            if (!instance) {
              failIntegrity(
                "ProtocolViolation",
                "The previous-run socket sent a line before its source instance.",
              );
              return;
            }
            const epoch = sourceEpoch(line.source, instance);
            if (candidate.classified && !candidate.classified.epochs.has(epoch)) {
              restartChangedReplay();
              return;
            }
            epochs.push(epoch);
          }
          if (candidate.committed) {
            for (const epoch of epochs) if (!addCount(baselineCounts, epoch, 1)) return;
            if (lines.length) document.append(lines);
            return;
          }
          if (lines.length) candidate.replacement?.append(lines);
          const suffix = [] as typeof lines;
          for (let index = 0; index < lines.length; index++) {
            const epoch = epochs[index]!;
            if (!addCount(candidate.crossed, epoch, 1)) return;
            const remaining = candidate.remaining.get(epoch) ?? 0;
            if (remaining > 0) {
              if (remaining === 1) candidate.remaining.delete(epoch);
              else candidate.remaining.set(epoch, remaining - 1);
            } else suffix.push(lines[index]!);
          }
          if (suffix.length) candidate.unchanged?.append(suffix);
          commitUnchangedIfComplete(candidate);
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
          const totals: { epoch: string; records: number }[] = [];
          for (const source of gap.sources) {
            const instance = candidate.epochs.get(source.id);
            if (!instance) {
              failIntegrity(
                "ProtocolViolation",
                "The previous-run socket sent a gap before its source instance.",
              );
              return;
            }
            const epoch = sourceEpoch(source.id, instance);
            if (candidate.classified && !candidate.classified.epochs.has(epoch)) {
              restartChangedReplay();
              return;
            }
            totals.push({ epoch, records: source.records });
          }
          if (candidate.committed) {
            for (const total of totals)
              if (!addCount(baselineCounts, total.epoch, total.records)) return;
            droppedMarker(document, gap.records);
            return;
          }
          if (candidate.replacement) droppedMarker(candidate.replacement, gap.records);
          let visibleRecords = 0;
          for (const total of totals) {
            if (!addCount(candidate.crossed, total.epoch, total.records)) return;
            const remaining = candidate.remaining.get(total.epoch) ?? 0;
            const skipped = Math.min(remaining, total.records);
            const nextRemaining = remaining - skipped;
            if (nextRemaining) candidate.remaining.set(total.epoch, nextRemaining);
            else candidate.remaining.delete(total.epoch);
            visibleRecords += total.records - skipped;
          }
          if (visibleRecords && candidate.unchanged)
            droppedMarker(candidate.unchanged, visibleRecords);
          commitUnchangedIfComplete(candidate);
        },
        end: (value) => {
          if (!active) return;
          if (!previous || value.reason === "error" || replay?.committed) {
            releaseReplay();
            setEnd(value);
            return;
          }
          const classified = replay?.classified;
          releaseReplay();
          setEnd(
            classified
              ? integrityEnd(
                  "ReplayIncomplete",
                  "The previous-run replay ended before every retained source boundary was reached.",
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
    replayCandidate.current?.unchanged?.updateBudgets(budgets);
    replayCandidate.current?.replacement?.updateBudgets(budgets);
  }, [document, budgets]);
  useEffect(() => {
    document.timestamps(timestamps);
    replayCandidate.current?.unchanged?.timestamps(timestamps);
    replayCandidate.current?.replacement?.timestamps(timestamps);
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
