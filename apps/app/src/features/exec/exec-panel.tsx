import {
  ExecReasonEngineStopped,
  ExecReasonNoShell,
  ExecReasonCommandNotFound,
  ExecReasonTooManySessions,
  type StreamEnd,
} from "@hukube/engine-client";
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
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { CommandForm } from "./command-form.tsx";
import { commandProgram, execTitle, imageKey, parseCommand } from "./command.ts";
import { isMac } from "@/lib/platform.ts";
import { useTheme } from "@/lib/theme.ts";
import { useResourceAccess } from "../edit/use-access.ts";
import { metadata } from "../edit/yaml.ts";
import { Notice } from "../resource/notice.tsx";
import { openGoToResource } from "../go-to-resource/open.ts";
import { useWorkspace } from "../workspace/workspace-context.tsx";
import { execContainers, execDisabledReason } from "./containers.ts";
import { useCommands } from "./use-commands.ts";
import { closeSessionTab, rememberSessionTab } from "./window-tabs.ts";
import { execKeyLabels } from "./keys.ts";
import {
  dismissSkippedNotice,
  startSession,
  takeSession,
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
  const { run: recordCommand } = useCommands();
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
  const containers = execContainers(pod.data?.object);
  const container = containers.find((c) => c.name === params.container);
  const reason = execDisabledReason(
    available,
    connection,
    access?.exec,
    container?.state === "running",
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
  const wasFocused = useRef(false);
  const [finding, setFinding] = useState(false);
  const findInput = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [selection, setSelection] = useState(false);
  const restartButton = useRef<HTMLButtonElement>(null);
  const keys = execKeyLabels(isMac);
  // Asked for again while its bar is open, find returns to its field.
  const find = () => {
    setFinding(true);
    findInput.current?.focus();
    findInput.current?.select();
  };
  const findFromTerminal = useEffectEvent(find);
  const theme = useTheme();
  const showing = visible && active;
  const gone = state?.phase === "gone";
  const renderingTerminal =
    !!session &&
    state?.phase !== "waiting" &&
    state?.phase !== "failed" &&
    (!gone || !!session.hasOutput);
  useEffect(() => {
    if (!renderingTerminal || !terminal || !body.current) return;
    const off = terminal.attach(body.current, showing);
    return () => {
      wasFocused.current ||= terminal.element.contains(document.activeElement);
      off();
    };
  }, [terminal, showing, renderingTerminal]);
  useEffect(() => {
    if (showing && (theme === "dark" || theme === "light")) terminal?.theme();
  }, [terminal, theme, showing]);
  useEffect(() => {
    if (renderingTerminal && showing && selected && terminal) terminal.focus();
  }, [terminal, showing, selected, renderingTerminal]);
  useEffect(() => terminal?.onFind(findFromTerminal), [terminal]);
  const phase = state?.phase;
  useEffect(() => {
    // An ended terminal takes no keys, so the keyboard needs somewhere to go.
    if (
      ["ended", "gone", "elsewhere"].includes(phase ?? "") &&
      (wasFocused.current || terminal?.element.contains(document.activeElement))
    )
      restartButton.current?.focus();
    wasFocused.current = false;
  }, [phase, terminal]);
  const restart = (label: string) => (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            ref={restartButton}
            variant="outline"
            size="sm"
            className="aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
            disabled={!!reason}
            focusableWhenDisabled
            onClick={() => {
              setFinding(false);
              void recordCommand(container?.image ?? "", params.commandLine ?? "");
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
  // The header always has a badge, in a slot of one width. One that came
  // and went would rewrap the header and resize the terminal under a shell.
  const badge =
    state?.phase === "waiting"
      ? "Waiting"
      : state?.phase === "starting"
        ? "Starting…"
        : state?.phase === "attaching" || !session
          ? "Attaching…"
          : state?.phase === "reconnecting"
            ? "Reconnecting…"
            : state?.phase === "elsewhere"
              ? "Not attached"
              : gone
                ? "Gone"
                : state?.phase === "failed"
                  ? "Not started"
                  : ended
                    ? "Ended"
                    : metadata(pod.data?.object)["deletionTimestamp"]
                      ? "Terminating"
                      : "Live";
  const pasteReason = "This Host cannot read the clipboard; use the keyboard.";
  return (
    <div
      className="flex h-full min-h-0 flex-col"
      onFocusCapture={(event) => {
        wasFocused.current = !!terminal?.element.contains(event.target);
      }}
      onBlurCapture={(event) => {
        wasFocused.current = !!terminal?.element.contains(event.relatedTarget);
      }}
    >
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
          </span>
          <span className="flex min-w-0 max-w-full items-center gap-1.5">
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
          {params.commandLine?.trim() && (
            <span className="flex min-w-0 max-w-full items-center gap-1.5">
              <span className="text-muted-foreground">Command</span>
              <span className="truncate font-mono" title={params.commandLine}>
                {params.commandLine}
              </span>
            </span>
          )}
        </div>
        <Badge
          variant={badge === "Live" ? "outline" : "secondary"}
          className={
            "mt-1 w-[7.5rem] shrink-0 justify-center" +
            (badge === "Live" ? " border-cluster text-cluster" : "")
          }
        >
          {badge}
        </Badge>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                className="shrink-0"
                aria-label="Find in scrollback"
                disabled={!terminal || !renderingTerminal}
                onClick={find}
              />
            }
          >
            <HugeiconsIcon icon={Search01Icon} />
          </TooltipTrigger>
          <TooltipContent>Find in scrollback ({keys.find})</TooltipContent>
        </Tooltip>
      </header>
      {gone && !session?.hasOutput ? (
        <Notice
          title="This session is gone"
          description={goneDescription}
          action={restart("Start a new session")}
        />
      ) : state?.phase === "waiting" ? (
        <Notice
          title="Waiting for a free stream"
          description="hukube runs 8 Log Streams and Exec Sessions at a time in a window. This session starts when one of them closes."
          action={
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                closeSessionTab(cluster, params.sessionId);
                api.close();
              }}
            >
              Cancel
            </Button>
          }
        />
      ) : state?.phase === "failed" ? (
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
          <div className="my-auto w-full shrink-0">
            <FailedNotice
              state={state}
              retry={restart("Try again")}
              retryGone={available ? restart("Try again") : undefined}
              params={params}
              image={container?.image ?? ""}
              focus={showing && selected}
              disabledReason={reason}
              runCommand={(commandLine) => {
                const next = { ...params, commandLine };
                // Commit the new header before startSession resets and refits the
                // terminal. A resize after the process starts can drop typed input.
                flushSync(() => {
                  api.updateParameters(next);
                  api.setTitle(execTitle(next));
                });
                // A reload must restore the Tab with the command it now runs.
                rememberSessionTab(cluster, { params: next, title: execTitle(next) });
                setFinding(false);
                void startSession(engine, cluster, next);
              }}
            />
          </div>
        </div>
      ) : (
        <ContextMenu
          onOpenChange={(open) => {
            if (open) setSelection(terminal?.hasSelection() ?? false);
            else terminal?.focus();
          }}
        >
          <ContextMenuTrigger
            render={<div className="relative min-h-0 flex-1 overflow-hidden px-3 py-2" />}
          >
            <div ref={body} className="isolate h-full min-h-0" />
            {state?.phase === "reconnecting" && (
              <output className="absolute inset-x-0 bottom-0 border-t bg-background px-3 py-2 text-muted-foreground">
                Reconnecting to the Engine. The session keeps running, and the Engine keeps its
                recent output.
              </output>
            )}
            {state?.phase === "live" && session?.skippedNotice && (
              <output className="absolute inset-x-0 bottom-0 flex items-start gap-2 border-t bg-background px-3 py-2 text-muted-foreground">
                <span className="min-w-0 flex-1">{session.skippedNotice}</span>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className="shrink-0"
                  aria-label="Dismiss"
                  onClick={() => dismissSkippedNotice(params.sessionId)}
                >
                  <HugeiconsIcon icon={Cancel01Icon} />
                </Button>
              </output>
            )}
            {state?.phase === "elsewhere" && (
              <div className="absolute inset-0 flex items-center justify-center overflow-auto bg-background/80 p-3">
                <div className="w-full min-w-0 max-w-sm rounded-md border bg-popover p-1 shadow-md">
                  <Notice
                    title="This session is open in another window"
                    description="An Exec Session shows in one window at a time. Using it here detaches the other window."
                    action={
                      <Button
                        ref={restartButton}
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          void takeSession(engine, cluster, params);
                        }}
                      >
                        Use it here
                      </Button>
                    }
                  />
                </div>
              </div>
            )}
            {finding && terminal && (
              <FindBar
                terminal={terminal}
                query={query}
                setQuery={setQuery}
                input={findInput}
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
                <Shortcut>{keys.copy}</Shortcut>
              </ContextMenuItem>
              <ContextMenuItem
                disabled={!navigator.clipboard?.readText || state?.phase !== "live"}
                title={!navigator.clipboard?.readText ? pasteReason : undefined}
                onClick={() => {
                  void navigator.clipboard
                    .readText()
                    .then((text) => terminal?.paste(text))
                    .catch(() => {});
                }}
              >
                Paste
                <Shortcut>{keys.paste}</Shortcut>
              </ContextMenuItem>
              <ContextMenuItem onClick={() => terminal?.selectAll()}>
                Select all
                <Shortcut>{keys.selectAll}</Shortcut>
              </ContextMenuItem>
              <ContextMenuItem onClick={find}>
                Find
                <Shortcut>{keys.find}</Shortcut>
              </ContextMenuItem>
              <ContextMenuItem onClick={() => terminal?.clear()}>Clear</ContextMenuItem>
              <ContextMenuItem onClick={() => openGoToResource(cluster)}>
                Go to Resource
                <Shortcut>{keys.goToResource}</Shortcut>
              </ContextMenuItem>
            </ContextMenuGroup>
          </ContextMenuContent>
        </ContextMenu>
      )}
      {(ended || (gone && session?.hasOutput)) && (
        <output className="flex shrink-0 flex-wrap items-center gap-2 border-t px-3 py-2">
          <p className="min-w-0 flex-1 text-muted-foreground">
            {gone ? `This session is gone. ${goneReason}` : ended ? endMessage(state) : ""}
          </p>
          {gone
            ? restart("Start a new session")
            : ended && state.reason !== "deleted" && available && restart("Start again")}
        </output>
      )}
    </div>
  );
}

const goneReason =
  "It ended, the Engine restarted, or it was told to exit after 10 minutes with no window attached.";
const goneDescription = `The Engine no longer has it. ${goneReason}`;

function Shortcut({ children }: { children?: string }) {
  return children ? (
    <span className="ml-auto pl-4 text-xs text-muted-foreground">{children}</span>
  ) : null;
}

function FailedNotice({
  state,
  retry,
  retryGone,
  params,
  image,
  focus,
  disabledReason,
  runCommand,
}: {
  state: Extract<ExecState, { phase: "failed" }>;
  retry: React.ReactNode;
  /** Offered while this window still sees the Pod. */
  retryGone?: React.ReactNode;
  params: ExecSessionParams;
  image: string;
  focus: boolean;
  disabledReason?: string;
  runCommand: (line: string) => void;
}) {
  const { commandFor, run } = useCommands();
  const remembered = commandFor(image);
  const correcting = !!params.commandLine && params.commandLine === remembered;
  const error = state.error;
  if (error?.reason === ExecReasonTooManySessions)
    return (
      <Notice
        title="Too many Exec Sessions"
        description="The Engine runs at most 64 at a time. End one and try again."
        action={retry}
      />
    );
  if (error?.reason === ExecReasonNoShell || error?.reason === ExecReasonCommandNotFound) {
    const noShell = error.reason === ExecReasonNoShell;
    const program = commandProgram(parseCommand(params.commandLine ?? "").command ?? []);
    return (
      <Notice
        title={noShell ? "No shell in this container" : `${program} is not in this container`}
        description={
          noShell ? (
            <>
              hukube's default shell needs <code>sh</code>, and this container has none. You can run
              a program the image contains instead, below, or use a debug container, for example
              with <code>kubectl debug</code>.
            </>
          ) : (
            <>
              {correcting && (
                <>
                  You chose <code>{params.commandLine}</code> for <code>{imageKey(image)}</code>
                  .{" "}
                </>
              )}
              Choose a command this image contains.
            </>
          )
        }
        action={
          <div className="flex w-full min-w-0 max-w-xl flex-col gap-4">
            <pre className="rounded-md border bg-muted/40 px-3 py-2 text-left font-mono text-xs break-words whitespace-pre-wrap text-muted-foreground">
              {error.message}
            </pre>
            <CommandForm
              key={params.commandLine ?? ""}
              image={image}
              initialLine={params.commandLine}
              rememberInitially={noShell || correcting}
              focus={focus}
              disabledReason={disabledReason}
              onRun={runCommand}
            />
            {!noShell && correcting && (
              <Button
                variant="outline"
                disabled={!!disabledReason}
                onClick={() => {
                  void run(image, "", true);
                  runCommand("");
                }}
              >
                Use the default shell
              </Button>
            )}
          </div>
        }
      />
    );
  }
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
  reason: StreamEnd["reason"];
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
    case "detached":
      return "This session is open in another window.";
    case "error":
      return state.error?.reason === ExecReasonEngineStopped
        ? "The Engine shut down, which ended the session. Its shell was told to exit."
        : `The session lost its connection to the Cluster: ${state.error?.message ?? ""}`;
  }
}

function FindBar({
  terminal,
  query,
  setQuery,
  input,
  close,
}: {
  terminal: ExecTerminal;
  query: string;
  setQuery: (text: string) => void;
  input: React.RefObject<HTMLInputElement | null>;
  close: () => void;
}) {
  const [results, setResults] = useState({ resultIndex: -1, resultCount: 0 });
  useEffect(() => terminal.onSearchResults(setResults), [terminal]);
  useEffect(() => {
    input.current?.focus();
    input.current?.select();
    // A query kept from the last time the bar was open is found again.
    if (input.current?.value) terminal.find(input.current.value, "older", true);
  }, [input, terminal]);
  return (
    <search
      className="absolute top-2 right-2 flex max-w-[calc(100%-1rem)] items-center gap-1 rounded-md border bg-popover p-1 shadow-md"
      aria-label="Find in scrollback"
    >
      <Input
        ref={input}
        aria-label="Find"
        value={query}
        className="min-w-0 flex-1"
        placeholder="Find"
        onChange={(event) => {
          setQuery(event.target.value);
          // A terminal's newest output is at the bottom, so finding starts there.
          if (event.target.value) terminal.find(event.target.value, "older", true);
          else terminal.clearSearch();
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            close();
          } else if (event.key === "Enter") {
            event.preventDefault();
            if (query) terminal.find(query, event.shiftKey ? "newer" : "older");
          }
        }}
      />
      <span className="shrink-0 text-xs text-muted-foreground" aria-live="polite">
        {!query
          ? ""
          : results.resultCount
            ? `${results.resultIndex + 1} of ${results.resultCount}`
            : "No results"}
      </span>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label="Previous match"
        disabled={!query}
        onClick={() => terminal.find(query, "older")}
      >
        <HugeiconsIcon icon={ArrowUp01Icon} />
      </Button>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label="Next match"
        disabled={!query}
        onClick={() => terminal.find(query, "newer")}
      >
        <HugeiconsIcon icon={ArrowDown01Icon} />
      </Button>
      <Button variant="ghost" size="icon-xs" aria-label="Close find" onClick={close}>
        <HugeiconsIcon icon={Cancel01Icon} />
      </Button>
    </search>
  );
}
