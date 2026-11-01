import { expect, type Locator } from "@playwright/test";

/** Shared web/desktop check against a finite, known line in the retained buffer. */
export async function assertLogFiltering(panel: Locator) {
  const editor = panel.locator(".monaco-editor");
  const instances = await editor.count();
  const filter = panel.getByRole("button", { name: "Filter", exact: true });
  await filter.click();
  const include = panel.getByRole("textbox", { name: "Include text" });
  await include.fill("COUNTER 1 from");
  await expect(panel.getByText(/^1 of [\d,]+ retained lines match$/)).toBeVisible();
  await expect(include).toBeFocused();
  await panel.getByRole("button", { name: "Search", exact: true }).click();
  const find = editor.getByRole("textbox", { name: "Find", exact: true });
  await find.fill("counter 0 from");
  await expect(editor.locator(".matchesCount")).toHaveText("No results");
  await find.fill("counter 1 from");
  await expect(editor.locator(".matchesCount")).toHaveText("1 of 1");
  await find.press("Escape");
  await panel.getByRole("button", { name: "Match case", exact: true }).click();
  await expect(panel.getByText("No matching lines", { exact: true })).toBeVisible();
  await expect(panel.getByRole("button", { name: "Search", exact: true })).toBeDisabled();
  expect(await editor.count()).toBe(instances);
  await filter.click();
  await expect(filter).toHaveAttribute("aria-expanded", "false");
  await expect(filter).toContainText("on");
  await expect(panel.getByText(/^0 of [\d,]+ retained lines match$/)).toBeVisible();
  await panel.getByRole("button", { name: "Clear filters", exact: true }).click();
  await expect(filter).toBeFocused();
  await expect(panel.getByRole("button", { name: "Search", exact: true })).toBeEnabled();
  await expect(panel.getByText("No matching lines", { exact: true })).toBeHidden();
  expect(await editor.count()).toBe(instances);
  // Search the restored projection, rather than relying on which rows are on screen.
  await panel.getByRole("button", { name: "Search", exact: true }).click();
  await find.fill("counter 0 from");
  await expect(editor.locator(".matchesCount")).toHaveText("1 of 1");
  await find.fill("counter 1 from");
  await expect(editor.locator(".matchesCount")).toHaveText("1 of 1");
  await find.press("Enter");
  await find.press("Escape");

  // Select backwards from the second line's end to the first line's start.
  // Hiding that end must stop before the third line, then Clear must recover it.
  const input = editor.getByRole("textbox", { name: /^Logs of / });
  await input.press("End");
  await input.press("Shift+Home");
  await input.press("Shift+ArrowUp");
  const original = await copiedSelection(editor);
  expect(original).toContain("counter 0 from");
  expect(original).toContain("counter 1 from");
  expect(original).not.toContain("counter 2 from");
  await filter.click();
  await panel.getByRole("textbox", { name: "Exclude text" }).fill("counter 1 from");
  await expect.poll(() => copiedSelection(editor)).not.toContain("counter 1 from");
  const hidden = await copiedSelection(editor);
  expect(hidden).toContain("counter 0 from");
  expect(hidden).not.toContain("counter 2 from");
  await panel.getByRole("button", { name: "Clear filters", exact: true }).click();
  await expect.poll(() => copiedSelection(editor)).toBe(original);
}

/** Observe Monaco's copy payload without depending on the Host's OS clipboard. */
async function copiedSelection(editor: Locator) {
  const result = await editor.getByRole("textbox", { name: /^Logs of / }).evaluate((element) => {
    const clipboardData = new DataTransfer();
    const event = new ClipboardEvent("copy", { bubbles: true, cancelable: true, clipboardData });
    element.dispatchEvent(event);
    return { handled: event.defaultPrevented, text: clipboardData.getData("text/plain") };
  });
  expect(result.handled).toBe(true);
  return result.text;
}
