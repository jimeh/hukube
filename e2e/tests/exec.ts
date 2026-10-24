import { expect, type Page } from "@playwright/test";

/**
 * Waits for the Engine to acknowledge a saved Workspace layout containing this
 * text. Call it before the page opens its socket.
 */
export function savedLayout(page: Page, text: string): () => Promise<void> {
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
      if (message.method === "settings.put" && JSON.stringify(message.params?.value).includes(text))
        requests.add(message.id);
    });
    socket.on("framereceived", ({ payload }) => {
      if (typeof payload !== "string") return;
      const message = JSON.parse(payload) as { id: number; type: string };
      if (message.type === "result" && requests.has(message.id)) saved = true;
    });
  });
  return () => expect.poll(() => saved, { message: `layout with ${text} acknowledged` }).toBe(true);
}

// Waits for the layout containing this session to be acknowledged by the Engine.
export function savedSessionLayout(page: Page, pod: string): () => Promise<void> {
  return savedLayout(page, `app in ${pod}`);
}

/** A restored live terminal owns Ctrl+K on Windows and Linux. */
export async function openGoToResource(page: Page): Promise<void> {
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  });
  await page.keyboard.press("ControlOrMeta+K");
}
