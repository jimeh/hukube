import type { Access, ConnectionState } from "@hukube/engine-client";
import { Button } from "@hukube/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@hukube/ui/components/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@hukube/ui/components/tooltip";
import { ArrowDown01Icon, ComputerTerminal01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useRef, useState } from "react";
import { useWorkspace } from "../workspace/workspace-context.tsx";
import { metadata } from "../edit/yaml.ts";
import { CommandDialog } from "./command-dialog.tsx";
import { execContainers, execDisabledReason, type ExecContainer } from "./containers.ts";
import { useCommands } from "./use-commands.ts";

export function ExecButton({
  object,
  deleted,
  connection,
  access,
  pod,
  namespace,
  panelId,
}: {
  object?: Record<string, unknown>;
  deleted?: boolean;
  connection: ConnectionState;
  access?: Access;
  pod: string;
  namespace: string;
  panelId: string;
}) {
  const { openExecSession } = useWorkspace();
  const { commandFor, run } = useCommands();
  const containers = execContainers(object);
  const reason = execDisabledReason(
    !!object && !deleted,
    connection,
    access,
    containers.some((c) => c.state === "running"),
  );
  const defaultContainer = containers[0];
  const defaultReason =
    reason ??
    (defaultContainer?.state !== "running" ? "The default container is not running." : undefined);
  const remembered = defaultContainer ? commandFor(defaultContainer.image) : undefined;
  const uid = metadata(object)["uid"];
  const open = (container: ExecContainer, commandLine?: string) => {
    if (reason || container.state !== "running") return;
    openExecSession(
      {
        namespace,
        pod,
        uid: typeof uid === "string" ? uid : "",
        container: container.name,
        ...(commandLine !== undefined ? { commandLine } : {}),
      },
      { pane: panelId },
    );
  };
  const openRemembered = (container: ExecContainer) => {
    const line = commandFor(container.image);
    void run(container.image, line ?? "");
    open(container, line);
  };
  const [dialog, setDialog] = useState(false);
  const chevron = useRef<HTMLButtonElement>(null);
  return (
    <div className="flex shrink-0 items-center">
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={
                remembered ? `Open an Exec Session, running ${remembered}` : "Open an Exec Session"
              }
              disabled={!!defaultReason}
              focusableWhenDisabled
              className="rounded-r-none aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
              onClick={() => {
                if (!defaultReason && defaultContainer) openRemembered(defaultContainer);
              }}
            />
          }
        >
          <HugeiconsIcon icon={ComputerTerminal01Icon} />
        </TooltipTrigger>
        <TooltipContent>
          {defaultReason ??
            (remembered ? `Open an Exec Session, running ${remembered}` : "Open an Exec Session")}
        </TooltipContent>
      </Tooltip>
      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger
            render={
              <DropdownMenuTrigger
                render={
                  <Button
                    ref={chevron}
                    size="icon-sm"
                    variant="ghost"
                    aria-label="Exec Session options"
                    className="rounded-l-none border-l"
                  />
                }
              />
            }
          >
            <HugeiconsIcon icon={ArrowDown01Icon} />
          </TooltipTrigger>
          <TooltipContent>{reason ?? "Choose a container or command"}</TooltipContent>
        </Tooltip>
        <DropdownMenuContent
          finalFocus={dialog ? false : undefined}
          className="min-w-56 max-w-[calc(100vw-2rem)]"
        >
          <DropdownMenuGroup>
            <DropdownMenuLabel>Exec Session in</DropdownMenuLabel>
            {containers.map((container) => (
              <DropdownMenuItem
                key={JSON.stringify([container.kind, container.name])}
                disabled={!!reason || container.state !== "running"}
                onClick={() => openRemembered(container)}
              >
                <span className="truncate font-mono" title={container.name}>
                  {container.name}
                </span>
                {container.kind !== "container" && (
                  <span className="text-muted-foreground">{container.kind}</span>
                )}
                {commandFor(container.image) && (
                  <span
                    className="truncate font-mono text-muted-foreground"
                    title={commandFor(container.image)}
                  >
                    runs {commandFor(container.image)}
                  </span>
                )}
                {container.state !== "running" && (
                  <span className="ml-auto text-muted-foreground">{container.state}</span>
                )}
              </DropdownMenuItem>
            ))}
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuGroup>
            <DropdownMenuItem disabled={!!reason} title={reason} onClick={() => setDialog(true)}>
              Run a command…
            </DropdownMenuItem>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      {dialog && (
        <CommandDialog
          pod={pod}
          containers={containers}
          disabledReason={reason}
          returnFocus={chevron}
          close={() => setDialog(false)}
          onRun={open}
        />
      )}
    </div>
  );
}
