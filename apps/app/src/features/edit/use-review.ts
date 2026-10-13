import {
  EngineRequestError,
  type EngineClient,
  type EditReview,
  type ErrorDetail,
  type ResourceEdit,
  type ApplyResult,
} from "@hukube/engine-client";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { editableManifest, metadataString, renderYaml } from "./yaml.ts";

export type ReviewPhase =
  | "checking"
  | "ready"
  | "failed"
  | "applying"
  | "disconnected"
  | "unavailable"
  | "refused"
  | "applied";
export interface ReviewState {
  phase: ReviewPhase;
  review?: EditReview;
  error?: EngineRequestError;
  changed?: boolean;
  result?: ApplyResult;
}
export function requestError(error: unknown): EngineRequestError {
  return error instanceof EngineRequestError
    ? error
    : new EngineRequestError({ code: "internal", message: String(error) });
}
export function errorDetail(error: EngineRequestError): ErrorDetail {
  return {
    code: error.code === "disconnected" ? "unavailable" : error.code,
    message: error.message,
    reason: error.reason,
    causes: error.causes,
  };
}
/** Owns cancellable reviews and uncancellable writes, even when their dialog is closed. */
export function useReview(
  client: EngineClient,
  live: Record<string, unknown> | undefined,
  onApplied: () => void,
  onRefusal: (detail: ErrorDetail) => void,
) {
  const [state, setState] = useState<ReviewState>();
  const [open, setOpen] = useState(false);
  const source = useRef<ResourceEdit | undefined>(undefined);
  const abort = useRef<AbortController | undefined>(undefined);
  const applyParams = useRef<ResourceEdit | undefined>(undefined);
  const mounted = useRef(true);
  const stateRef = useRef(state);

  const applied = useRef(onApplied);

  const refusal = useRef(onRefusal);
  useLayoutEffect(() => {
    stateRef.current = state;
    applied.current = onApplied;
    refusal.current = onRefusal;
  }, [state, onApplied, onRefusal]);

  const check = useCallback(
    async (changed = false) => {
      if (!source.current) return;
      abort.current?.abort();
      const controller = new AbortController();
      abort.current = controller;
      setState((previous) => ({
        phase: "checking",
        review: previous?.review,
        changed: changed || previous?.changed,
      }));
      try {
        const review = await client.request("resource.review", source.current, {
          signal: controller.signal,
        });
        if (controller.signal.aborted || !mounted.current) return;
        setState((previous) => ({ phase: "ready", review, changed: previous?.changed }));
        if (review.refusal && !review.dryRunUnsupported) refusal.current(review.refusal);
      } catch (error) {
        if (controller.signal.aborted || !mounted.current) return;
        setState({ phase: "failed", error: requestError(error) });
      }
    },
    [client],
  );
  const sendApply = useCallback(async () => {
    if (!applyParams.current) return;
    setState((previous) => ({ ...previous, phase: "applying" }));
    try {
      const result = await client.request("resource.apply", applyParams.current);
      if (mounted.current) setState((previous) => ({ ...previous, phase: "applied", result }));
    } catch (error) {
      if (!mounted.current) return;
      const failure = requestError(error);
      if (failure.code === "conflict") {
        await check(true);
        return;
      }
      if (failure.code !== "disconnected" && failure.code !== "unavailable")
        refusal.current(errorDetail(failure));
      setState((previous) => ({
        ...previous,
        phase:
          failure.code === "disconnected"
            ? "disconnected"
            : failure.code === "unavailable"
              ? "unavailable"
              : "refused",
        error: failure,
      }));
    }
  }, [client, check]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      abort.current?.abort();
    };
  }, []);
  useEffect(
    () =>
      client.onStateChange(() => {
        if (client.getState() === "open" && stateRef.current?.phase === "disconnected") {
          // Move the phase before sending, so another connection notification cannot repeat it twice.
          stateRef.current = { ...stateRef.current, phase: "applying" };
          void sendApply();
        }
      }),
    [client, sendApply],
  );
  useEffect(() => {
    // Reconnection can finish before the rejected write reaches this hook.
    if (
      state?.phase === "disconnected" &&
      stateRef.current?.phase === "disconnected" &&
      client.getState() === "open"
    ) {
      stateRef.current = { ...state, phase: "applying" };
      void sendApply();
    }
  }, [state, client, sendApply]);
  const reviewable = open && (state?.phase === "ready" || state?.phase === "checking");
  const reviewedBefore = state?.review?.before;
  // Rendering a Manifest is not free, and every open Resource tab holds this hook.
  // The live Manifest itself is the value, so each further change reviews again.
  const outdatedBy = useMemo(
    () =>
      reviewable &&
      reviewedBefore &&
      live &&
      renderYaml(reviewedBefore) !== renderYaml(editableManifest(live))
        ? live
        : undefined,
    [reviewable, reviewedBefore, live],
  );
  useEffect(() => {
    if (!outdatedBy) return;
    const timer = setTimeout(() => void check(), 300);
    return () => clearTimeout(timer);
  }, [outdatedBy, check]);
  const version = metadataString(live, "resourceVersion");
  useEffect(() => {
    if (state?.phase !== "applied") return;
    const finish = () => {
      setOpen(false);
      setState(undefined);
      applied.current();
    };
    if (version === state.result?.resourceVersion) {
      finish();
      return;
    }
    const timer = setTimeout(finish, 2000);
    return () => clearTimeout(timer);
  }, [state?.phase, state?.result, version]);
  return {
    open,
    state,
    begin: (edit: ResourceEdit) => {
      source.current = edit;
      setState(undefined);
      setOpen(true);
      void check();
    },
    check: () => void check(),
    close: () => {
      if (state?.phase === "applying") return;
      setOpen(false);
      abort.current?.abort();
    },
    apply: () => {
      const review = state?.review;
      if (
        state?.phase !== "ready" ||
        !review ||
        !review.edited.length ||
        (review.refusal && !review.dryRunUnsupported) ||
        !source.current
      )
        return;
      applyParams.current = { ...source.current, base: review.before, manifest: review.desired };
      void sendApply();
    },
  };
}
