import { parse } from "shell-quote";

export const commandMaxLength = 4096;
export type CommandRefusal =
  | { kind: "shell"; token: string }
  | { kind: "comment" }
  | { kind: "invalid"; message: string };

/** Plain text for a failed session's error, without Markdown delimiters. */
export function commandRefusalText(refusal: CommandRefusal): string {
  switch (refusal.kind) {
    case "shell":
      return `${refusal.token} needs a shell. To use one, write sh -c '…'.`;
    case "comment":
      return "# starts a comment here. Quote it to pass it as text.";
    case "invalid":
      return refusal.message;
  }
}

export type ParsedCommand =
  | { command: string[]; error?: never }
  | { error: CommandRefusal; command?: never };

/** A command is argv, without a shell to expand or interpret it. */
export function parseCommand(line: string): ParsedCommand {
  if (line.length > commandMaxLength)
    return { error: { kind: "invalid", message: "A command can be at most 4,096 characters." } };
  try {
    const words = parse<{ variable: string }>(line, (variable) => ({ variable }));
    const command: string[] = [];
    for (const word of words) {
      if (typeof word === "string") command.push(word);
      else if ("comment" in word) return { error: { kind: "comment" } };
      else {
        const token =
          "variable" in word ? `$${word.variable}` : word.op === "glob" ? word.pattern : word.op;
        return { error: { kind: "shell", token } };
      }
    }
    if (command[0] === "")
      return { error: { kind: "invalid", message: "The command's first word cannot be empty." } };
    return { command };
  } catch (error) {
    return {
      error: {
        kind: "invalid",
        message: `The command could not be read: ${error instanceof Error ? error.message : String(error)}`,
      },
    };
  }
}

/** Tags and digests do not change which repository a command belongs to. */
export function imageKey(image: string): string {
  const repository = image.split("@")[0]!;
  const colon = repository.lastIndexOf(":");
  return colon > repository.lastIndexOf("/") ? repository.slice(0, colon) : repository;
}

export function commandProgram(command: readonly string[]): string {
  return command[0]?.split("/").at(-1) ?? "";
}

export function execTitle(params: {
  container: string;
  pod: string;
  commandLine?: string;
}): string {
  const command = parseCommand(params.commandLine ?? "").command;
  return `${command?.length ? `${commandProgram(command)}: ` : ""}${params.container} in ${params.pod}`;
}
