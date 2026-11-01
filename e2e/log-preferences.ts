import { expect, type Page } from "@playwright/test";

async function resetLogStreams(page: Page): Promise<void> {
  await page.getByRole("link", { name: "Settings", exact: true }).click();
  await page.getByRole("link", { name: "Log Streams", exact: true }).click();
  const section = page.getByRole("region", { name: "Log Streams", exact: true });
  await section.getByRole("button", { name: "Reset Log Streams", exact: true }).click();
  const confirmation = page.getByRole("alertdialog");
  await confirmation.getByRole("button", { name: "Reset Log Streams", exact: true }).click();
  await expect(confirmation).toBeHidden();
  await expect(section.locator(":scope > output")).toHaveText("Saved");
  await expect(section.getByLabel("Maximum retained lines", { exact: true })).toHaveValue("50000");
}

export async function withLogStreamDefaults(page: Page, run: () => Promise<void>): Promise<void> {
  try {
    await resetLogStreams(page);
    await run();
  } finally {
    await resetLogStreams(page);
  }
}
