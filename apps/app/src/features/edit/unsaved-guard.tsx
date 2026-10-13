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

export function UnsavedGuard() {
  const guard = useUnsavedEdits((state) => state.guard);
  const dismiss = useUnsavedEdits((state) => state.dismiss);
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!useUnsavedEdits.getState().entries.size) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, []);
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
