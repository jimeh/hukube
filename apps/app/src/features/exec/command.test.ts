import { expect, it } from "vitest";
import { commandProgram, execTitle, imageKey, parseCommand } from "./command.ts";

it.each<[string, string[]]>([
  ["bash -l", ["bash", "-l"]],
  ["sh -c 'ps aux | grep x'", ["sh", "-c", "ps aux | grep x"]],
  ['python3 -c "print(1+1)"', ["python3", "-c", "print(1+1)"]],
  [String.raw`a\ b "c d" 'e'`, ["a b", "c d", "e"]],
  ["echo 'open", ["echo", "open"]],
  ["", []],
  [" \t ", []],
  [
    String.raw`echo '$HOME' \| '*.log' 'http://x/#a'`,
    ["echo", "$HOME", "|", "*.log", "http://x/#a"],
  ],
  ["x ''", ["x", ""]],
])("splits %s into words without expansion", (line, command) => {
  expect(parseCommand(line)).toEqual({ command });
});

it.each(["|", "&&", ";", ">", "<", "&", "||", ">>", "(", ")"])("refuses the operator %s", (op) => {
  expect(parseCommand(`a ${op} b`)).toEqual({
    error: { kind: "shell", token: op },
  });
});
it.each<[string, string]>([
  ["ls *.log", "*.log"],
  ["ls a?", "a?"],
  ["echo $HOME", "$HOME"],
  ['echo "x${HOME}y"', "$HOME"],
  ["echo $constructor", "$constructor"],
])("refuses expansion in %s", (line, token) => {
  expect(parseCommand(line)).toEqual({
    error: { kind: "shell", token },
  });
});
it.each(["x # note", "curl http://x/#a"])("refuses comments in %s", (line) => {
  expect(parseCommand(line)).toEqual({
    error: { kind: "comment" },
  });
});
it("limits a line to 4,096 characters and rejects an empty program", () => {
  expect(parseCommand("x".repeat(4096))).toEqual({ command: ["x".repeat(4096)] });
  expect(parseCommand("x".repeat(4097))).toEqual({
    error: { kind: "invalid", message: "A command can be at most 4,096 characters." },
  });
  expect(parseCommand("'' arg")).toEqual({
    error: { kind: "invalid", message: "The command's first word cannot be empty." },
  });
});
it.each([
  ["busybox:1.36", "busybox"],
  ["gcr.io/distroless/static@sha256:123", "gcr.io/distroless/static"],
  ["registry:5000/app:tag@sha256:123", "registry:5000/app"],
  ["registry:5000/app", "registry:5000/app"],
  ["busybox", "busybox"],
  ["__proto__:tag", "__proto__"],
])("keys image %s by its repository", (image, key) => expect(imageKey(image)).toBe(key));
it("puts the program first in a chosen command's title", () => {
  expect(commandProgram(["/usr/bin/python3", "-q"])).toBe("python3");
  expect(execTitle({ commandLine: "/bin/sh -l", container: "app", pod: "web" })).toBe(
    "sh: app in web",
  );
  expect(execTitle({ container: "app", pod: "web" })).toBe("app in web");
});

it("splits a typed line put back in a field into exactly the original words", () => {
  const typed = "ls '*.log'";
  const saved = JSON.parse(JSON.stringify({ line: typed })) as { line: string };
  expect(saved.line).toBe(typed);
  expect(parseCommand(saved.line)).toEqual({ command: ["ls", "*.log"] });
});
