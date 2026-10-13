import { useConnectionState } from "@hukube/engine-client/react";
import { Button } from "@hukube/ui/components/button";
import { Alert02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";

import { useHost } from "@/lib/host.tsx";

/** Shows how to recover when the UI and Engine protocol definitions differ. */
export function OutOfDateNotice() {
  const connection = useConnectionState();
  const host = useHost();
  if (connection !== "outdated") return null;
  const web = host.kind === "web";
  return (
    <div
      role="alert"
      className="flex shrink-0 items-start gap-3 border-b border-border bg-warning/15 px-4 py-3 text-foreground"
    >
      <HugeiconsIcon
        icon={Alert02Icon}
        size={20}
        className="shrink-0 text-warning"
        aria-hidden="true"
      />
      <div className="min-w-0 flex-1 text-sm">
        <p className="font-semibold">
          {web ? "This page is out of date" : "This window is out of date"}
        </p>
        <p>
          {web
            ? "The Engine was updated after this page loaded, so live data has stopped. Reload to continue."
            : "It does not match the Engine it is connected to, so live data has stopped. Quit and reopen hukube to continue."}
          {import.meta.env.DEV && " In development, rebuild and restart the Engine if this stays."}
        </p>
      </div>
      {web && (
        <Button className="shrink-0" onClick={() => window.location.reload()}>
          Reload
        </Button>
      )}
    </div>
  );
}
