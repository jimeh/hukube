import { useEffect, useRef } from "react";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
} from "@hukube/ui/components/alert-dialog";
import { Button } from "@hukube/ui/components/button";
import { useUnsavedEdits } from "./unsaved-edits.ts";
import { holdsSession, useExecSessions } from "../exec/sessions.ts";

import { useHost } from "@/lib/host.tsx";

import { useSettingsOpenWork } from "../settings/open-work.ts";

export function UnsavedGuard() {
  const overviewDirty = useSettingsOpenWork((state) => state.overview);
  const settingsDirty = useSettingsOpenWork((state) => state.preferences || state.keybindings)
    ? 1
    : 0;
  const host = useHost();
  const edits = useUnsavedEdits((state) => state.entries.size);
  const sessions = useExecSessions(
    (state) => [...state.entries.values()].filter(holdsSession).length,
  );
  useEffect(
    () => host.reportOpenWork({ edits: edits + settingsDirty + (overviewDirty ? 1 : 0), sessions }),
    [host, edits, sessions, settingsDirty, overviewDirty],
  );
  const guard = useUnsavedEdits((state) => state.guard);
  const dismiss = useUnsavedEdits((state) => state.dismiss);
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (
        !useSettingsOpenWork.getState().overview &&
        !useSettingsOpenWork.getState().preferences &&
        !useSettingsOpenWork.getState().keybindings &&
        !useUnsavedEdits.getState().entries.size &&
        !(
          host.kind === "desktop" &&
          [...useExecSessions.getState().entries.values()].some(holdsSession)
        )
      )
        return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [host]);
  return (
    <AlertDialog
      open={!!guard}
      onOpenChange={(open) => {
        if (!open) dismiss();
      }}
    >
      <AlertDialogContent initialFocus={cancel}>
        <AlertDialogTitle>{guard?.title}</AlertDialogTitle>
        <AlertDialogDescription>
          {guard?.description ?? "Your edits have not been applied."}
        </AlertDialogDescription>
        <AlertDialogFooter>
          <Button ref={cancel} variant="outline" onClick={dismiss}>
            {guard?.cancel}
          </Button>
          <Button
            variant="destructive"
            onClick={() => {
              const proceed = guard?.proceed;
              dismiss();
              proceed?.();
            }}
          >
            {guard?.discard}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
