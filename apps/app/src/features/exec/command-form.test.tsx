// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { CommandForm } from "./command-form.tsx";

const mock = vi.hoisted(() => ({
  remembered: undefined as string | undefined,
  run: vi.fn<() => Promise<void>>(),
}));
vi.mock("./use-commands.ts", () => ({
  useCommands: () => ({
    commands: { images: [], recent: ["python3"] },
    commandFor: () => mock.remembered,
    run: mock.run,
  }),
}));
afterEach(() => {
  cleanup();
  mock.remembered = undefined;
  mock.run.mockClear();
});
const field = () => screen.getByRole<HTMLInputElement>("textbox", { name: "Command" });
const change = (value: string) => fireEvent.change(field(), { target: { value } });

it("hides remembering for an empty field without a remembered command", () => {
  render(<CommandForm image="busybox:1" onRun={() => {}} />);
  expect(screen.queryByRole("checkbox")).toBeNull();
});
it("resets remembering when an empty field changes its meaning", () => {
  mock.remembered = "ash";
  render(<CommandForm image="busybox:1" rememberInitially onRun={() => {}} />);
  const forget = screen.getByRole("checkbox", { name: "Forget the command chosen for busybox" });
  expect(forget.getAttribute("aria-checked")).toBe("false");
  fireEvent.click(forget);
  change("bash");
  expect(screen.getByRole("checkbox").getAttribute("aria-checked")).toBe("true");
  fireEvent.click(screen.getByRole("checkbox"));
  change("");
  expect(screen.getByRole("checkbox").getAttribute("aria-checked")).toBe("false");
  change("sh");
  expect(screen.getByRole("checkbox").getAttribute("aria-checked")).toBe("true");
});
it("labels raw words as chips and makes an empty argument visible", () => {
  render(<CommandForm image="" initialLine="echo '' '[ab]'" onRun={() => {}} />);
  const preview = screen.getByLabelText("Words to run");
  expect(preview.textContent).toBe("Runs:echo[ab]");
  const chips = [...preview.querySelectorAll("code")];
  expect(chips.map((chip) => chip.textContent)).toEqual(["echo", "", "[ab]"]);
  expect(
    chips.every((chip) => chip.classList.contains("border") && chip.classList.contains("min-w-4")),
  ).toBe(true);
});
it.each([
  ["a | b", "The | operator needs a shell. To use one, write sh -c '…'.", ["|", "sh -c '…'"]],
  [
    "ls $DIR/*.log",
    "The variable $DIR needs a shell to expand. Quote it with single quotes to pass it as text, or write sh -c '…'.",
    ["$DIR", "sh -c '…'"],
  ],
  [
    String.raw`find . -name \*.log`,
    "The pattern *.log needs a shell to expand. Quote it to pass it as text, or write sh -c '…'.",
    ["*.log", "sh -c '…'"],
  ],
  [
    "x # hi",
    "# starts a comment here. Quote it, or put a backslash before it, to pass it as text.",
    ["#"],
  ],
])("renders the refusal for %s as code", (line, text, tokens) => {
  render(<CommandForm image="" initialLine={line} onRun={() => {}} />);
  const alert = screen.getByRole("alert");
  expect(alert.textContent).toBe(text);
  expect([...alert.querySelectorAll("code")].map((code) => code.textContent)).toEqual(tokens);
});
it("focuses a notice field only when its panel is showing and selected", () => {
  const other = document.createElement("input");
  document.body.append(other);
  other.focus();
  const view = render(<CommandForm image="" focus={false} onRun={() => {}} />);
  expect(document.activeElement).toBe(other);
  view.rerender(<CommandForm image="" focus onRun={() => {}} />);
  expect(document.activeElement).toBe(field());
  view.unmount();
  other.remove();
});
it("updates an unedited prefill but keeps an edited command when containers change", () => {
  const view = render(
    <CommandForm image="busybox" initialLine="ash" rememberInitially onRun={() => {}} />,
  );
  view.rerender(
    <CommandForm image="python" initialLine="python3" rememberInitially onRun={() => {}} />,
  );
  expect(field().value).toBe("python3");
  change("custom");
  view.rerender(
    <CommandForm image="busybox" initialLine="ash" rememberInitially onRun={() => {}} />,
  );
  expect(field().value).toBe("custom");
});
