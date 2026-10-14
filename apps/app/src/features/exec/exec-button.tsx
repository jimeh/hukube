import type { Access, ConnectionState } from "@hukube/engine-client";
import { Button } from "@hukube/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@hukube/ui/components/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@hukube/ui/components/tooltip";
import { ComputerTerminal01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useWorkspace } from "../workspace/workspace-context.tsx";
import { metadata } from "../edit/yaml.ts";
import { execContainers, execDisabledReason } from "./containers.ts";

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
  const containers = execContainers(object);
  const reason = execDisabledReason(
    !!object && !deleted,
    connection,
    access,
    containers.some((c) => c.state === "running"),
  );
  const uid = metadata(object)["uid"];
  const open = (container: string) =>
    openExecSession(
      { namespace, pod, uid: typeof uid === "string" ? uid : "", container },
      { pane: panelId },
    );
  const button = (
    <Button
      size="icon-sm"
      variant="ghost"
      aria-label="Open an Exec Session"
      disabled={!!reason}
      focusableWhenDisabled
      className="shrink-0 aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
    />
  );
  const icon = <HugeiconsIcon icon={ComputerTerminal01Icon} />;
  return (
    <Tooltip>
      {containers.length > 1 && !reason ? (
        <DropdownMenu>
          <TooltipTrigger render={<DropdownMenuTrigger render={button} />}>{icon}</TooltipTrigger>
          <DropdownMenuContent className="min-w-56">
            <DropdownMenuGroup>
              <DropdownMenuLabel>Exec Session in</DropdownMenuLabel>
              {containers.map((container) => (
                <DropdownMenuItem
                  key={JSON.stringify([container.kind, container.name])}
                  disabled={container.state !== "running"}
                  onClick={() => open(container.name)}
                >
                  <span className="truncate font-mono" title={container.name}>
                    {container.name}
                  </span>
                  {container.kind !== "container" && (
                    <span className="text-muted-foreground">{container.kind}</span>
                  )}
                  {container.state !== "running" && (
                    <span className="ml-auto text-muted-foreground">{container.state}</span>
                  )}
                </DropdownMenuItem>
              ))}
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : (
        <TooltipTrigger
          render={
            <Button
              {...button.props}
              onClick={() => {
                if (!reason && containers[0]) open(containers[0].name);
              }}
            />
          }
        >
          {icon}
        </TooltipTrigger>
      )}
      <TooltipContent>{reason ?? "Open an Exec Session"}</TooltipContent>
    </Tooltip>
  );
}
