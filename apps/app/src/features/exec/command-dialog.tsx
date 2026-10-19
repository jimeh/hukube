import { Button } from "@hukube/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@hukube/ui/components/dialog";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@hukube/ui/components/select";
import { useId, useRef, useState, type RefObject } from "react";
import { clusterScope } from "../clusters/cluster-color.ts";
import { useWorkspace } from "../workspace/workspace-context.tsx";
import { useCommands } from "./use-commands.ts";
import { CommandForm } from "./command-form.tsx";
import type { ExecContainer } from "./containers.ts";

export function CommandDialog({
  pod,
  containers,
  disabledReason,
  onRun,
  close,
  returnFocus,
}: {
  pod: string;
  containers: ExecContainer[];
  disabledReason?: string;
  onRun: (container: ExecContainer, line: string) => void;
  close: () => void;
  returnFocus: RefObject<HTMLButtonElement | null>;
}) {
  const { cluster } = useWorkspace();
  const { commandFor } = useCommands();
  const [edited, setEdited] = useState<{ image: string; fromMemory: boolean }>();
  const [name, setName] = useState(containers[0]?.name ?? "");
  const selected = containers.find((container) => container.name === name);
  const input = useRef<HTMLInputElement>(null);
  const id = useId();
  const reason =
    disabledReason ?? (selected?.state !== "running" ? "The container is not running." : undefined);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogContent
        {...clusterScope(cluster)}
        className="sm:max-w-lg max-h-[calc(100%-2rem)] overflow-y-auto"
        initialFocus={input}
        finalFocus={returnFocus}
      >
        <DialogHeader>
          <DialogTitle>
            Run a command in <code>{pod}</code>
          </DialogTitle>
          <DialogDescription>
            Run a program directly. Use quotes to keep an argument's spaces.
          </DialogDescription>
        </DialogHeader>
        <CommandForm
          image={selected?.image ?? ""}
          initialLine={selected ? (commandFor(selected.image) ?? "") : ""}
          rememberInitially={
            !!selected &&
            !!commandFor(selected.image) &&
            (!edited || (edited.image === selected.image && edited.fromMemory))
          }
          onEdit={() => {
            if (selected)
              setEdited(
                (previous) =>
                  previous ?? {
                    image: selected.image,
                    fromMemory: commandFor(selected.image) !== undefined,
                  },
              );
          }}
          inputRef={input}
          showRecent
          disabledReason={reason}
          onRun={(line) => {
            if (selected) {
              onRun(selected, line);
              close();
            }
          }}
          cancel={
            <Button type="button" variant="outline" size="sm" onClick={close}>
              Cancel
            </Button>
          }
          before={
            containers.length > 1 ? (
              <div className="flex min-w-0 flex-col gap-1.5">
                <label id={id} htmlFor={`${id}-select`}>
                  Container
                </label>
                <Select
                  value={name}
                  onValueChange={(value) => {
                    if (value) setName(value);
                  }}
                >
                  <SelectTrigger id={`${id}-select`} aria-labelledby={id} className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {containers.map((container) => (
                        <SelectItem
                          key={JSON.stringify([container.kind, container.name])}
                          value={container.name}
                          disabled={container.state !== "running"}
                        >
                          {container.name}
                          {container.state !== "running" ? ` (${container.state})` : ""}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </div>
            ) : undefined
          }
        />
      </DialogContent>
    </Dialog>
  );
}
