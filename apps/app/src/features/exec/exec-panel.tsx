import { ExecReasonEngineStopped, ExecReasonNoShell, type StreamEnd } from "@hukube/engine-client";
import { useConnectionState, useEngine, useSubscription } from "@hukube/engine-client/react";
import { Badge } from "@hukube/ui/components/badge";
import { Button } from "@hukube/ui/components/button";
import { Input } from "@hukube/ui/components/input";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@hukube/ui/components/context-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@hukube/ui/components/tooltip";
import {
  Search01Icon,
  ArrowUp01Icon,
  ArrowDown01Icon,
  Cancel01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { IDockviewPanelProps } from "dockview-react";
import { useEffect, useRef, useState } from "react";
import { useTheme } from "@/lib/theme.ts";
import { useResourceAccess } from "../edit/use-access.ts";
import { metadata } from "../edit/yaml.ts";
import { Notice } from "../resource/notice.tsx";
import { useWorkspace } from "../workspace/workspace-context.tsx";
import { execContainers, execDisabledReason } from "./containers.ts";
import {
  startSession,
  useExecSessions,
  type ExecSessionParams,
  type ExecState,
  type ExecTerminal,
} from "./sessions.ts";

export function ExecPanel({
  api,
  params,
}: Pick<IDockviewPanelProps<ExecSessionParams>, "api" | "params">) {
  const { cluster, active, openResource } = useWorkspace();
  const engine = useEngine();
  const session = useExecSessions((store) => store.entries.get(params.sessionId));
  const state = session?.state;
  const terminal = session?.terminal;
  const pod = useSubscription("resource.get", {
    cluster,
    type: "pods",
    namespace: params.namespace,
    name: params.pod,
  });
  const available =
    !!pod.data?.object && !pod.data.deleted && metadata(pod.data.object)["uid"] === params.uid;
  const access = useResourceAccess(
    { cluster, type: "pods", namespace: params.namespace, name: params.pod },
    available,
  );
  const connection = useConnectionState();
  const reason = execDisabledReason(
    available,
    connection,
    access?.exec,
    execContainers(pod.data?.object).some(
      (c) => c.name === params.container && c.state === "running",
    ),
  );
  const [visible, setVisible] = useState(api.isVisible ?? true);
  const [selected, setSelected] = useState(api.isActive ?? true);
  useEffect(() => {
    const v = api.onDidVisibilityChange?.((event) => setVisible(event.isVisible));
    const a = api.onDidActiveChange?.((event) => setSelected(event.isActive));
    return () => {
      v?.dispose();
      a?.dispose();
    };
  }, [api]);
  const body = useRef<HTMLDivElement>(null);
  const [finding, setFinding] = useState(false);
  const [selection, setSelection] = useState(false);
  const theme = useTheme();
  const showing = visible && active;
  const renderingTerminal = !!session && state?.phase !== "waiting" && state?.phase !== "failed";
  useEffect(() => {
    if (!renderingTerminal || !terminal || !body.current) return;
    return terminal.attach(body.current, showing);
  }, [terminal, showing, renderingTerminal]);
  useEffect(() => {
    if (showing && (theme === "dark" || theme === "light")) terminal?.theme();
  }, [terminal, theme, showing]);
  useEffect(() => {
    if (showing && selected && terminal) terminal.focus();
  }, [terminal, showing, selected]);
  useEffect(() => terminal?.onFind(() => setFinding(true)), [terminal]);
  const restart = (label: string) => (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="outline"
            size="sm"
            disabled={!!reason}
            focusableWhenDisabled
            onClick={() => {
              setFinding(false);
              void startSession(engine, cluster, params);
            }}
          />
        }
      >
        {label}
      </TooltipTrigger>
      {reason && <TooltipContent>{reason}</TooltipContent>}
    </Tooltip>
  );
  const ended = state?.phase === "ended";
  // "Starting…" shows over the terminal instead: a badge that comes and goes
  // can rewrap the header, which resizes the terminal just as its shell starts.
  const badge =
    state?.phase === "waiting"
      ? "Waiting"
      : ended
        ? "Ended"
        : state?.phase === "live" && metadata(pod.data?.object)["deletionTimestamp"]
          ? "Terminating"
          : undefined;
  const pasteReason = "This Host cannot read the clipboard; use the keyboard.";
  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 items-start gap-2 border-t-2 border-t-cluster border-b px-3 py-2">
        <div className="flex min-h-7 min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1">
          <span className="flex min-w-0 max-w-full items-center gap-1.5 text-cluster">
            <span className="size-2 shrink-0 rounded-full bg-cluster" aria-hidden />
            <span className="truncate font-mono" title={cluster}>
              {cluster}
            </span>
          </span>
          <span className="flex min-w-0 max-w-full items-center gap-1.5">
            <span className="text-muted-foreground">Pod</span>
            <Button
              variant="link"
              size="sm"
              className="min-w-0 px-0 font-mono"
              title={params.pod}
              onClick={() =>
                openResource(
                  { type: "pods", namespace: params.namespace, name: params.pod },
                  { pane: api.id },
                )
              }
            >
              <span className="truncate">{params.pod}</span>
            </Button>
            <span className="text-muted-foreground">in</span>
            <span className="truncate font-mono text-muted-foreground" title={params.namespace}>
              {params.namespace}
            </span>
          </span>
          <span className="flex min-w-0 max-w-full items-center gap-1.5">
            <span className="text-muted-foreground">Container</span>
            <span className="truncate font-mono" title={params.container}>
              {params.container}
            </span>
          </span>
        </div>
        {badge && (
          <Badge variant="secondary" className="mt-1 shrink-0">
            {badge}
          </Badge>
        )}
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                className="shrink-0"
                aria-label="Find in scrollback"
                disabled={!terminal || !renderingTerminal}
                onClick={() => setFinding(true)}
              />
            }
          >
            <HugeiconsIcon icon={Search01Icon} />
          </TooltipTrigger>
          <TooltipContent>Find in scrollback</TooltipContent>
        </Tooltip>
      </header>
      {!session ? (
        <Notice
          title="This session is over"
          description="An Exec Session does not survive a reload. Its shell was told to exit."
          action={restart("Start a new session")}
        />
      ) : state?.phase === "waiting" ? (
        <Notice
          title="Waiting for a free stream"
          description="hukube runs 8 Log Streams and Exec Sessions at a time in a window. This session starts when one of them closes."
          action={
            <Button variant="outline" size="sm" onClick={() => api.close()}>
              Cancel
            </Button>
          }
        />
      ) : state?.phase === "failed" ? (
        <FailedNotice
          state={state}
          retry={restart("Try again")}
          retryGone={available ? restart("Try again") : undefined}
        />
      ) : (
        <ContextMenu
          onOpenChange={(open) => {
            if (open) setSelection(terminal?.hasSelection() ?? false);
            else terminal?.focus();
          }}
        >
          <ContextMenuTrigger
            render={<div className="relative min-h-0 flex-1 overflow-hidden p-2" />}
          >
            <div ref={body} className="h-full min-h-0" />
            {state?.phase === "starting" && (
              <output className="pointer-events-none absolute inset-0 flex items-center justify-center text-muted-foreground">
                Starting…
              </output>
            )}
            {finding && terminal && (
              <FindBar
                terminal={terminal}
                close={() => {
                  setFinding(false);
                  terminal.clearSearch();
                  terminal.focus();
                }}
              />
            )}
          </ContextMenuTrigger>
          <ContextMenuContent>
            <ContextMenuGroup>
              <ContextMenuItem disabled={!selection} onClick={() => terminal?.copy()}>
                Copy
              </ContextMenuItem>
              <ContextMenuItem
                disabled={!navigator.clipboard?.readText || ended}
                title={!navigator.clipboard?.readText ? pasteReason : undefined}
                onClick={() => {
                  void navigator.clipboard
                    .readText()
                    .then((text) => terminal?.paste(text))
                    .catch(() => {});
                }}
              >
                Paste
              </ContextMenuItem>
              <ContextMenuItem onClick={() => terminal?.selectAll()}>Select all</ContextMenuItem>
              <ContextMenuItem onClick={() => setFinding(true)}>Find</ContextMenuItem>
              <ContextMenuItem onClick={() => terminal?.clear()}>Clear</ContextMenuItem>
            </ContextMenuGroup>
          </ContextMenuContent>
        </ContextMenu>
      )}
      {ended && (
        <output className="flex shrink-0 flex-wrap items-center gap-2 border-t px-3 py-2">
          <p className="min-w-0 flex-1 text-muted-foreground">{endMessage(state)}</p>
          {state.reason !== "deleted" && available && restart("Start again")}
        </output>
      )}
    </div>
  );
}

function FailedNotice({
  state,
  retry,
  retryGone,
}: {
  state: Extract<ExecState, { phase: "failed" }>;
  retry: React.ReactNode;
  /** Offered while this window still sees the Pod. */
  retryGone?: React.ReactNode;
}) {
  const error = state.error;
  if (error?.reason === ExecReasonNoShell)
    return (
      <Notice
        title="No shell in this container"
        description={
          <>
            hukube runs <code>sh</code>, and this container has none, which is usual for distroless
            images. A debug container is the way into one, for example with{" "}
            <code>kubectl debug</code>.
          </>
        }
        action={
          <pre className="max-w-full whitespace-pre-wrap break-words font-mono text-xs text-muted-foreground">
            {error.message}
          </pre>
        }
      />
    );
  if (error?.code === "forbidden")
    return (
      <Notice
        title={
          error.message.startsWith("The Engine is running read-only.")
            ? "The Engine is read-only"
            : "Not permitted"
        }
        description={error.message}
      />
    );
  if (state.reason === "deleted")
    return (
      <Notice
        title="The Pod is gone"
        description="It was deleted or replaced before the session could start."
        action={retryGone}
      />
    );
  return (
    <Notice title="The session could not start" description={error?.message ?? ""} action={retry} />
  );
}

export function endMessage(state: {
  reason: StreamEnd["reason"] | "lost";
  exitCode?: number;
  error?: StreamEnd["error"];
}): string {
  switch (state.reason) {
    case "complete":
      return `The process exited with code ${state.exitCode ?? 0}.`;
    case "stopped":
      return "The container stopped, which ended the session.";
    case "deleted":
      return "The Pod was deleted, which ended the session.";
    case "lost":
      return "The session lost its connection to the Engine. A command that was running may still be running in the container.";
    case "error":
      return state.error?.reason === ExecReasonEngineStopped
        ? "The Engine shut down, which ended the session. Its shell was told to exit."
        : `The session lost its connection to the Cluster: ${state.error?.message ?? ""}`;
  }
}

function FindBar({ terminal, close }: { terminal: ExecTerminal; close: () => void }) {
  const [text, setText] = useState("");
  const [results, setResults] = useState({ resultIndex: -1, resultCount: 0 });
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    input.current?.focus();
    return terminal.onSearchResults(setResults);
  }, [terminal]);
  return (
    <search
      className="absolute top-2 right-2 flex max-w-[calc(100%-1rem)] items-center gap-1 rounded-md border bg-popover p-1 shadow-md"
      aria-label="Find in scrollback"
    >
      <Input
        ref={input}
        aria-label="Find"
        value={text}
        className="min-w-0 flex-1"
        placeholder="Find"
        onChange={(event) => {
          setText(event.target.value);
          terminal.find(event.target.value, false, true);
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            close();
          } else if (event.key === "Enter") {
            event.preventDefault();
            terminal.find(text, event.shiftKey);
          }
        }}
      />
      <span className="shrink-0 text-xs text-muted-foreground" aria-live="polite">
        {results.resultCount
          ? `${results.resultIndex + 1} of ${results.resultCount}`
          : "No results"}
      </span>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label="Previous match"
        onClick={() => terminal.find(text, true)}
      >
        <HugeiconsIcon icon={ArrowUp01Icon} />
      </Button>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label="Next match"
        onClick={() => terminal.find(text)}
      >
        <HugeiconsIcon icon={ArrowDown01Icon} />
      </Button>
      <Button variant="ghost" size="icon-xs" aria-label="Close find" onClick={close}>
        <HugeiconsIcon icon={Cancel01Icon} />
      </Button>
    </search>
  );
}
