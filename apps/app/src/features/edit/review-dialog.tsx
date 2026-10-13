import { lazy, Suspense, useRef } from "react";
import { Button } from "@hukube/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@hukube/ui/components/dialog";
import { Skeleton } from "@hukube/ui/components/skeleton";
import { clusterScope } from "../clusters/cluster-color.ts";
import { pathsLabel, refusalLines } from "./field-paths.ts";
import { renderYaml } from "./yaml.ts";
import type { useReview } from "./use-review.ts";
const DiffEditor = lazy(() => import("./diff-editor.tsx"));
export function ReviewDialog({
  review: controller,
  cluster,
  label,
  namespace,
  onBack,
}: {
  review: ReturnType<typeof useReview>;
  cluster: string;
  label: string;
  namespace?: string;
  onBack: () => void;
}) {
  const back = useRef<HTMLButtonElement>(null);
  const state = controller.state;
  const review = state?.review;
  const busy = state?.phase === "applying" || state?.phase === "applied";
  const checking = state?.phase === "checking";
  const empty = review && !review.edited.length && !review.refusal;
  const refusal = state?.phase === "refused" ? state.error : review?.refusal;
  const unsupported = state?.phase !== "refused" && !!review?.dryRunUnsupported;
  const permitted =
    controller.connection === "open" &&
    state?.phase === "ready" &&
    review &&
    !empty &&
    (!refusal || unsupported);
  const close = () => {
    if (busy) return;
    controller.close();
    onBack();
  };
  const status =
    controller.connection !== "open"
      ? "Reconnecting to the Engine…"
      : checking
        ? "Checking with the Cluster…"
        : state?.phase === "applying" || state?.phase === "applied"
          ? "Applying…"
          : permitted && !unsupported
            ? "The Cluster accepts this edit."
            : "";
  return (
    <Dialog
      open={controller.open}
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogContent
        {...clusterScope(cluster)}
        showCloseButton={false}
        initialFocus={back}
        finalFocus={false}
        className="flex h-[min(48rem,calc(100dvh-2rem))] w-[calc(100vw-2rem)] max-w-[72rem] flex-col overflow-hidden sm:max-w-[72rem]"
      >
        <div className="-mx-4 -mt-4 shrink-0 rounded-t-xl bg-cluster px-4 py-2 font-mono font-semibold text-cluster-foreground">
          {cluster}
        </div>
        <div>
          <DialogTitle>Review changes to {label}</DialogTitle>
          {namespace && <DialogDescription>in {namespace}</DialogDescription>}
        </div>
        <div
          className="flex max-h-[30%] shrink-0 flex-col gap-2 overflow-auto [overflow-wrap:anywhere] text-sm"
          aria-live="polite"
        >
          {state?.changed && (
            <p className="text-warning">
              The Resource changed on the Cluster while you were reviewing. Nothing was applied.
            </p>
          )}
          {refusal && !unsupported && (
            <div className="text-destructive">
              <p className="font-semibold">
                {refusal.code === "forbidden"
                  ? "Not permitted"
                  : refusal.reason
                    ? "The Cluster refused this edit"
                    : "This edit cannot be applied"}
              </p>
              {refusalLines(refusal).map((line, i) => (
                <p key={i}>{line}</p>
              ))}
              {state?.phase === "refused" && <p>Nothing was applied.</p>}
            </div>
          )}
          {unsupported && (
            <p className="text-warning">
              {review.refusal?.message} The edit is validated only when it is applied.
            </p>
          )}
          {state?.phase === "failed" && (
            <div role="alert">
              <p>
                {state.error?.code === "too_large"
                  ? "The Manifest is too large to edit in hukube. Use kubectl."
                  : state.error?.message}
              </p>
              {!["too_large", "not_found"].includes(state.error?.code ?? "") && (
                <Button variant="outline" onClick={controller.check}>
                  Try again
                </Button>
              )}
            </div>
          )}
          {state?.error?.code === "not_connected" && (
            <p role="alert">Not connected to the Engine. Nothing was sent.</p>
          )}
          {state?.phase === "unavailable" && (
            <div role="alert">
              <p>The Cluster did not answer. The edit may or may not have been applied.</p>
              <Button variant="outline" onClick={controller.check}>
                Check again
              </Button>
            </div>
          )}
          {state?.phase === "disconnected" && (
            <p role="alert">
              Lost the connection to the Engine while applying. hukube checks the result when it
              reconnects.
            </p>
          )}
          {!!review?.overlaps.length && (
            <p className="text-warning">
              You and the Cluster both changed {pathsLabel(review.overlaps)}. Applying replaces the
              Cluster's value with yours. The diff shows both.
            </p>
          )}
          {!!review?.changedOnCluster.length &&
            (() => {
              const others = review.changedOnCluster.filter(
                (path) =>
                  !review.overlaps.some(
                    (overlap) => JSON.stringify(overlap) === JSON.stringify(path),
                  ),
              );
              return others.length ? (
                <p>
                  Also changed on the Cluster while you were editing, and kept: {pathsLabel(others)}
                  .
                </p>
              ) : null;
            })()}
          {!!review?.setByCluster.length && (
            <p>The Cluster also sets: {pathsLabel(review.setByCluster)}.</p>
          )}
          {!!review?.ignored.length && (
            <p>Not applied, because the Cluster sets these itself: {pathsLabel(review.ignored)}.</p>
          )}
          {review?.warnings.map((warning, i) => (
            <p className="text-warning" key={i}>
              {warning}
            </p>
          ))}
        </div>
        <div className={`min-h-0 flex-1 ${checking && review ? "opacity-50" : ""}`}>
          {empty ? (
            <div className="flex h-full flex-col items-center justify-center gap-2">
              <h3>Nothing to apply</h3>
              <p>
                {review.changedOnCluster.length
                  ? "The Cluster already has these values."
                  : "Comments and formatting are not part of a Resource."}
              </p>
            </div>
          ) : review ? (
            <div className="flex h-full flex-col">
              {/* A legend, not column headings: the diff is inline when it is narrow. */}
              <div className="flex flex-wrap gap-x-4 border-b py-1 text-muted-foreground">
                <span>
                  <span aria-hidden="true" className="font-mono text-destructive">
                    −{" "}
                  </span>
                  On the Cluster now
                </span>
                <span>
                  <span aria-hidden="true" className="font-mono text-success">
                    +{" "}
                  </span>
                  After applying
                </span>
              </div>
              <Suspense fallback={<Skeleton className="h-full" />}>
                <DiffEditor
                  before={renderYaml(review.before)}
                  after={renderYaml(
                    refusal && !unsupported ? review.desired : (review.after ?? review.desired),
                  )}
                />
              </Suspense>
            </div>
          ) : (
            <Skeleton className="h-full" />
          )}
        </div>
        <DialogFooter className="shrink-0 items-center">
          <output className="mr-auto">{status}</output>
          <Button ref={back} variant="outline" disabled={busy} onClick={close}>
            {state?.phase === "disconnected" ? "Close" : "Back to editing"}
          </Button>
          {!empty && (
            <Button disabled={!permitted} onClick={controller.apply}>
              {unsupported
                ? "Apply without a dry run"
                : review?.overlaps.length
                  ? "Overwrite and apply"
                  : "Apply"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
