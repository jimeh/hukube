import { Button } from "@hukube/ui/components/button";
import { Checkbox } from "@hukube/ui/components/checkbox";
import { Input } from "@hukube/ui/components/input";
import { useEffect, useId, useRef, useState, type ReactNode, type RefObject } from "react";
import { imageKey, parseCommand, type CommandRefusal } from "./command.ts";
import { useCommands } from "./use-commands.ts";

/** The same command field at the place a session starts and where one failed. */
export function CommandForm({
  image,
  initialLine = "",
  rememberInitially = false,
  disabledReason,
  onRun,
  inputRef,
  before,
  cancel,
  showRecent = false,
}: {
  image: string;
  initialLine?: string;
  rememberInitially?: boolean;
  disabledReason?: string;
  onRun: (line: string) => void;
  inputRef?: RefObject<HTMLInputElement | null>;
  before?: ReactNode;
  cancel?: ReactNode;
  showRecent?: boolean;
}) {
  const [line, setLine] = useState(initialLine);
  const [remember, setRemember] = useState(rememberInitially);
  const { commands, run } = useCommands();
  const ownInput = useRef<HTMLInputElement>(null);
  const field = inputRef ?? ownInput;
  const id = useId();
  const parsed = parseCommand(line);
  const repository = imageKey(image);
  useEffect(() => {
    field.current?.focus();
  }, [field]);
  return (
    <form
      className="flex min-w-0 flex-col gap-3 text-left"
      onSubmit={(event) => {
        event.preventDefault();
        if (parsed.error !== undefined || disabledReason) return;
        void run(image, line, remember);
        onRun(line);
      }}
    >
      {before}
      <div className="flex min-w-0 flex-col gap-1.5">
        <label htmlFor={id}>Command</label>
        <Input
          id={id}
          ref={field}
          value={line}
          placeholder="Default shell: bash, or sh"
          className="font-mono"
          aria-invalid={parsed.error !== undefined}
          aria-describedby={`${id}-preview`}
          onChange={(event) => setLine(event.target.value)}
        />
        {parsed.error !== undefined ? (
          <p id={`${id}-preview`} role="alert" className="text-destructive">
            <RefusalMessage refusal={parsed.error} />
          </p>
        ) : (
          <output
            id={`${id}-preview`}
            aria-label="Words to run"
            className="flex flex-wrap gap-1 break-all text-muted-foreground"
          >
            {parsed.command.length
              ? parsed.command.map((word, index) => <code key={index}>{JSON.stringify(word)}</code>)
              : "Runs the default shell."}
          </output>
        )}
      </div>
      {showRecent && !!commands?.recent.length && (
        <div className="flex min-w-0 flex-col gap-1.5">
          <span className="text-muted-foreground">Recent commands</span>
          <div className="flex flex-wrap gap-1">
            {commands.recent.map((recent) => (
              <Button
                key={recent}
                type="button"
                variant="outline"
                size="sm"
                className="max-w-full"
                title={recent}
                onClick={() => {
                  setLine(recent);
                  field.current?.focus();
                }}
              >
                <span className="truncate font-mono">{recent}</span>
              </Button>
            ))}
          </div>
        </div>
      )}
      {repository && (
        <label htmlFor={`${id}-remember`} className="flex min-w-0 items-start gap-2">
          <Checkbox id={`${id}-remember`} checked={remember} onCheckedChange={setRemember} />
          <span className="min-w-0 break-words">
            {line.trim() ? "Use this command for " : "Use the default shell for "}
            <code>{repository}</code> from now on
          </span>
        </label>
      )}
      {disabledReason && <p className="text-muted-foreground">{disabledReason}</p>}
      <div className="flex justify-end gap-2">
        {cancel}
        <Button type="submit" size="sm" disabled={parsed.error !== undefined || !!disabledReason}>
          Run
        </Button>
      </div>
    </form>
  );
}

function RefusalMessage({ refusal }: { refusal: CommandRefusal }) {
  switch (refusal.kind) {
    case "shell":
      return (
        <>
          <code>{refusal.token}</code> needs a shell. To use one, write <code>sh -c '…'</code>.
        </>
      );
    case "comment":
      return (
        <>
          <code>#</code> starts a comment here. Quote it to pass it as text.
        </>
      );
    case "invalid":
      return refusal.message;
  }
}
