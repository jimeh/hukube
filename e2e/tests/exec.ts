import { expect, type Page } from "@playwright/test";

// Waits for the layout containing this session to be acknowledged by the Engine.
export function savedSessionLayout(page: Page, pod: string): () => Promise<void> {
  let saved = false;
  page.on("websocket", (socket) => {
    if (!socket.url().endsWith("/ws")) return;
    const requests = new Set<number>();
    socket.on("framesent", ({ payload }) => {
      if (typeof payload !== "string") return;
      const message = JSON.parse(payload) as {
        id: number;
        method?: string;
        params?: { value?: unknown };
      };
      if (
        message.method === "settings.put" &&
        JSON.stringify(message.params?.value).includes(`app in ${pod}`)
      )
        requests.add(message.id);
    });
    socket.on("framereceived", ({ payload }) => {
      if (typeof payload !== "string") return;
      const message = JSON.parse(payload) as { id: number; type: string };
      if (message.type === "result" && requests.has(message.id)) saved = true;
    });
  });
  return () => expect.poll(() => saved, { message: "session Tab layout acknowledged" }).toBe(true);
}

/** A restored live terminal owns Ctrl+K on Windows and Linux. */
export async function openGoToResource(page: Page): Promise<void> {
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  });
  await page.keyboard.press("ControlOrMeta+K");
}
