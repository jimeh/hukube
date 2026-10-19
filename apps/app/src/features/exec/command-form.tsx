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
  showRecent = true,
  focus = true,
  onEdit,
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
  focus?: boolean;
  onEdit?: () => void;
}) {
  const [input, setInput] = useState({ line: initialLine, prefill: initialLine, edited: false });
  if (input.prefill !== initialLine) {
    setInput({ ...input, prefill: initialLine, line: input.edited ? input.line : initialLine });
  }
  const line = input.line;
  const { commands, commandFor, run } = useCommands();
  const ownInput = useRef<HTMLInputElement>(null);
  const field = inputRef ?? ownInput;
  const id = useId();
  const parsed = parseCommand(line);
  const repository = imageKey(image);
  const hasLine = !!line.trim();
  const remembered = commandFor(image);
  const mode = JSON.stringify([repository, hasLine, rememberInitially]);
  const defaultChecked = hasLine && rememberInitially;
  const [choice, setChoice] = useState({ mode, checked: defaultChecked });
  if (choice.mode !== mode) setChoice({ mode, checked: defaultChecked });
  const remember = choice.checked;
  useEffect(() => {
    if (focus) field.current?.focus();
  }, [field, focus]);
  const editLine = (next: string) => {
    onEdit?.();
    setInput({ line: next, prefill: initialLine, edited: true });
  };
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
          onChange={(event) => editLine(event.target.value)}
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
            {parsed.command.length ? (
              <>
                <span>Runs:</span>
                {parsed.command.map((word, index) => (
                  <code
                    key={index}
                    className="min-w-4 rounded border px-1"
                    aria-label={word === "" ? "Empty argument" : undefined}
                  >
                    {word}
                  </code>
                ))}
              </>
            ) : (
              "Runs the default shell."
            )}
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
                  editLine(recent);
                  field.current?.focus();
                }}
              >
                <span className="truncate font-mono">{recent}</span>
              </Button>
            ))}
          </div>
        </div>
      )}
      {repository && (hasLine || remembered !== undefined) && (
        <label htmlFor={`${id}-remember`} className="flex min-w-0 items-start gap-2">
          <Checkbox
            id={`${id}-remember`}
            checked={remember}
            onCheckedChange={(checked) => setChoice({ mode, checked })}
          />
          <span className="min-w-0 break-words">
            {hasLine ? "Use this command for " : "Forget the command chosen for "}
            <code>{repository}</code>
            {hasLine ? " from now on" : ""}
          </span>
        </label>
      )}
      {disabledReason && <p className="text-muted-foreground">{disabledReason}</p>}
      <div className="flex justify-end gap-2">
        {cancel}
        <Button
          type="submit"
          variant="default"
          size="sm"
          disabled={parsed.error !== undefined || !!disabledReason}
        >
          Run
        </Button>
      </div>
    </form>
  );
}

function RefusalMessage({ refusal }: { refusal: CommandRefusal }) {
  switch (refusal.kind) {
    case "operator":
      return (
        <>
          The <code>{refusal.token}</code> operator needs a shell. To use one, write{" "}
          <code>sh -c '…'</code>.
        </>
      );
    case "glob":
      return (
        <>
          The pattern <code>{refusal.token}</code> needs a shell to expand. Quote it to pass it as
          text, or write <code>sh -c '…'</code>.
        </>
      );
    case "variable":
      return (
        <>
          The variable <code>{refusal.token}</code> needs a shell to expand. Quote it with single
          quotes to pass it as text, or write <code>sh -c '…'</code>.
        </>
      );
    case "comment":
      return (
        <>
          <code>#</code> starts a comment here. Quote it, or put a backslash before it, to pass it
          as text.
        </>
      );
    case "invalid":
      return refusal.message;
  }
}
