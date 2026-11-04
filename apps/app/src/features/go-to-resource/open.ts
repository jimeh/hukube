import { commands } from "../commands/runtime.ts";
/** The terminal menu shares the window invocation path. */
export function openGoToResource(cluster: string): void {
  commands.dispatch("app.goToResource", {}, commands.capture(cluster));
}
