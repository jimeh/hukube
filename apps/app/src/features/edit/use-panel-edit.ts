import { useEngine, useConnectionState } from "@hukube/engine-client/react";
import type { Access, ResourceData } from "@hukube/engine-client";
import type { SubscriptionState } from "@hukube/engine-client/react";
import type { ResourceAddress } from "@hukube/k8s";
import { useEffect, useLayoutEffect, useRef, useState, useCallback } from "react";
import {
  startSession,
  followManifest,
  isDirty,
  sessionNotice,
  type EditSession,
} from "./session.ts";
import { metadata, parseManifest } from "./yaml.ts";
import { guardPanel, useUnsavedEdits } from "./unsaved-edits.ts";
import { useReview } from "./use-review.ts";
import {
  fieldReason,
  inlineReason,
  parseInput,
  semanticEqual,
  updateDraft,
  valueAt,
} from "../overview/draft.ts";
import type { Definition, EditControl, FieldPath } from "../overview/definition.ts";

export interface PendingField {
  path: FieldPath;
  label: string;
  control: EditControl;
  raw: string;
  error?: string;
  original: unknown;
  lastWritten: unknown;
  newKey?: boolean;
}
interface State {
  session?: EditSession;
  field?: PendingField;
  generation: number;
  definition?: Definition;
  origin?: FieldPath;
}
export function usePanelEdit({
  address,
  kind,
  manifest,
  panelId,
  editAccess,
  onEdit,
}: {
  address?: ResourceAddress;
  kind: string;
  manifest: SubscriptionState<ResourceData>;
  panelId: string;
  editAccess?: Access;
  onEdit?: () => void;
}) {
  const client = useEngine();
  const connection = useConnectionState();
  const [state, setState] = useState<State>({ generation: 0 });
  const current = useRef(state);
  useLayoutEffect(() => {
    current.current = state;
  }, [state]);
  const [applied, setApplied] = useState(false);
  const focus = useRef<(() => void) | undefined>(undefined);
  const setFocus = useCallback((callback: () => void) => {
    focus.current = callback;
  }, []);
  const focusRequested = useRef(false);
  const submitted = useRef<{ text: string; generation: number } | undefined>(undefined);
  const live = manifest.data?.object;
  const deleted = !!manifest.data?.deleted;
  const addressCluster = address?.cluster;
  const label = `${kind} ${address?.name ?? ""}`;
  const review = useReview(
    client,
    live,
    () => {
      setState((previous) =>
        previous.session?.text === submitted.current?.text &&
        previous.generation === submitted.current?.generation
          ? { generation: previous.generation + 1, origin: previous.origin }
          : previous,
      );
      setApplied(true);
      focusRequested.current = true;
    },
    (refusal) =>
      setState((previous) =>
        previous.session ? { ...previous, session: { ...previous.session, refusal } } : previous,
      ),
  );
  const [seenLive, setSeenLive] = useState({ live, deleted });
  if (seenLive.live !== live || seenLive.deleted !== deleted) {
    setSeenLive({ live, deleted });
    if (
      state.session &&
      !state.field &&
      !review.pending &&
      !review.unknownOutcome &&
      review.state?.phase !== "applying"
    ) {
      const session = followManifest(state.session, live, deleted);
      setState({ ...state, session, definition: session ? state.definition : undefined });
    }
  }
  const dirty = isDirty(state.session) || !!state.field;
  const writing = ["applying", "disconnected", "applied"].includes(review.state?.phase ?? "");
  const gone =
    !!state.session && (deleted || (!!live && metadata(live)["uid"] !== state.session.uid));
  const editReason =
    !live || deleted
      ? "The Manifest is not available."
      : connection !== "open"
        ? "Reconnecting to the Engine"
        : editAccess?.allowed === false
          ? (editAccess.reason ?? "Not permitted")
          : undefined;
  const reviewReason = writing
    ? "Waiting for the apply result"
    : gone
      ? "Your edits cannot be applied."
      : connection !== "open"
        ? "Reconnecting to the Engine"
        : state.field?.newKey
          ? `${state.field.label}: Add or cancel the new key first.`
          : state.field?.error
            ? `${state.field.label}: ${state.field.error}`
            : !isDirty(state.session)
              ? "No unsaved edits"
              : undefined;
  const parsed = state.session ? parseManifest(state.session.text) : undefined;
  const inlineBlocked = state.session ? inlineReason(state.session.text) : undefined;
  const notice = state.session
    ? sessionNotice(state.session, live, deleted, label, kind)
    : undefined;
  const endReview = review.end;
  const hadSession = useRef(false);
  useLayoutEffect(() => {
    if (hadSession.current && !state.session) endReview();
    hadSession.current = !!state.session;
    if (focusRequested.current) {
      focusRequested.current = false;
      focus.current?.();
    }
    // An older successful apply can retain the same session when newer input exists.
    // oxlint-disable-next-line react/exhaustive-effect-dependencies
  }, [state.session, endReview, applied]);
  useEffect(() => {
    if (!applied) return;
    const timer = setTimeout(() => setApplied(false), 4000);
    return () => clearTimeout(timer);
  }, [applied]);
  useEffect(() => {
    if (
      (!dirty && !writing && !review.pending && !review.unknownOutcome) ||
      !state.session ||
      !addressCluster
    ) {
      useUnsavedEdits.getState().set(panelId);
      return;
    }
    useUnsavedEdits.getState().set(panelId, {
      cluster: addressCluster,
      label,
      read: () => current.current.session?.text ?? "",
      pendingApply: writing || review.pending || review.unknownOutcome,
    });
    return () => useUnsavedEdits.getState().set(panelId);
  }, [
    dirty,
    state.session,
    writing,
    review.pending,
    review.unknownOutcome,
    panelId,
    addressCluster,
    label,
  ]);
  const start = () => {
    if (editReason || !live) return false;
    if (!current.current.session) {
      const next = { ...current.current, session: startSession(live) };
      current.current = next;
      setState(next);
      onEdit?.();
    }
    return true;
  };
  const changeText = (text: string) => {
    setState((previous) => {
      if (!previous.session) return previous;
      const object = parseManifest(text).object;
      const field =
        previous.field &&
        semanticEqual(valueAt(object, previous.field.path), previous.field.lastWritten)
          ? previous.field
          : undefined;
      return {
        ...previous,
        session: { ...previous.session, text, refusal: undefined },
        field,
        generation: previous.generation + 1,
      };
    });
  };
  const beginField = (
    path: FieldPath,
    fieldLabel: string,
    control: EditControl,
    definition: Definition,
  ) => {
    if (current.current.field?.error || current.current.field?.newKey || !start()) return false;
    const previous = current.current;
    const session = previous.session!;
    const object = parseManifest(session.text).object;
    if (inlineReason(session.text) || fieldReason(object, path, control)) return false;
    const original = valueAt(object, path);
    const next = {
      ...previous,
      definition: previous.definition ?? definition,
      origin: path,
      field: {
        path,
        label: fieldLabel,
        control,
        raw:
          original === undefined
            ? ""
            : typeof original === "string" ||
                typeof original === "number" ||
                typeof original === "boolean"
              ? String(original)
              : "",
        original,
        lastWritten: original,
      },
      generation: previous.generation + 1,
    };
    current.current = next;
    setState(next);
    return true;
  };
  const input = (raw: string) => {
    const previous = current.current;
    if (!previous.field || !previous.session) return;
    if (previous.field.newKey) {
      const map = valueAt(parseManifest(previous.session.text).object, previous.field.path);
      const error = !raw
        ? "Enter a non-empty key."
        : ["__proto__", "prototype", "constructor"].includes(raw)
          ? "This key is not supported inline."
          : map && typeof map === "object" && Object.hasOwn(map, raw)
            ? "This key already exists."
            : undefined;
      const next = {
        ...previous,
        field: { ...previous.field, raw, error },
        generation: previous.generation + 1,
      };
      current.current = next;
      setState(next);
      return;
    }
    let field = { ...previous.field, raw, error: undefined as string | undefined };
    let session = previous.session;
    try {
      const value = parseInput(raw, field.control);
      session = {
        ...session,
        text: updateDraft(session.text, session.baseText, field.path, value, field.control),
        refusal: undefined,
      };
      field.lastWritten = value;
    } catch (error) {
      field.error = error instanceof Error ? error.message : String(error);
    }
    const next = { ...previous, session, field, generation: previous.generation + 1 };
    current.current = next;
    setState(next);
  };
  const finishField = (restore = false) => {
    const previous = current.current;
    if (!previous.field || !previous.session || (!restore && previous.field.error)) return;
    let session = previous.session;
    if (restore && !previous.field.newKey) {
      try {
        session = {
          ...session,
          text: updateDraft(
            session.text,
            session.baseText,
            previous.field.path,
            previous.field.original,
            { ...previous.field.control, remove: true },
          ),
          refusal: undefined,
        };
      } catch {
        return;
      }
    }
    const next = { ...previous, session, field: undefined, generation: previous.generation + 1 };
    current.current = next;
    setState(next);
  };
  const beginNewKey = (path: FieldPath, fieldLabel: string, definition: Definition) => {
    if (current.current.field || !start()) return;
    const previous = current.current;
    const next = {
      ...previous,
      definition: previous.definition ?? definition,
      origin: path,
      field: {
        path,
        label: fieldLabel,
        control: { type: "string" as const, remove: true },
        raw: "",
        error: "Enter a non-empty key.",
        original: undefined,
        lastWritten: valueAt(parseManifest(previous.session!.text).object, path),
        newKey: true,
      },
      generation: previous.generation + 1,
    };
    current.current = next;
    setState(next);
  };
  const addKey = () => {
    const previous = current.current;
    const field = previous.field;
    if (!field?.newKey || field.error || !previous.session) return;
    const path = [...field.path, field.raw];
    const text = updateDraft(
      previous.session.text,
      previous.session.baseText,
      path,
      "",
      field.control,
    );
    const next = {
      ...previous,
      session: { ...previous.session, text },
      field: {
        ...field,
        newKey: false,
        path,
        label: field.raw,
        raw: "",
        error: undefined,
        lastWritten: "",
      },
      generation: previous.generation + 1,
    };
    current.current = next;
    setState(next);
  };
  const setFieldValue = (
    path: FieldPath,
    value: unknown,
    control: EditControl,
    definition: Definition,
  ) => {
    if (!start()) return;
    const previous = current.current;
    if (!previous.session) return;
    const text = updateDraft(
      previous.session.text,
      previous.session.baseText,
      path,
      value,
      control,
    );
    const next = {
      ...previous,
      definition: previous.definition ?? definition,
      session: { ...previous.session, text, refusal: undefined },
      field:
        previous.field && !semanticEqual(previous.field.path, path)
          ? {
              ...previous.field,
              lastWritten: valueAt(parseManifest(text).object, previous.field.path),
            }
          : undefined,
      generation: previous.generation + 1,
    };
    current.current = next;
    setState(next);
  };
  const reviewChanges = (focusIssue?: () => void) => {
    const previous = current.current;
    if (!previous.session || reviewReason || !address) return;
    const object = parseManifest(previous.session.text).object;
    if (!object) {
      focusIssue?.();
      return;
    }
    if (previous.field?.error) return;
    if (previous.field) {
      const next = { ...previous, field: undefined };
      current.current = next;
      setState(next);
    }
    submitted.current = { text: previous.session.text, generation: previous.generation };
    review.begin({
      cluster: address.cluster,
      type: address.type,
      namespace: address.namespace,
      name: address.name,
      uid: previous.session.uid,
      base: previous.session.base,
      manifest: object,
    });
  };
  const cancel = () =>
    guardPanel(panelId, () => {
      review.end();
      const next = { generation: current.current.generation + 1 };
      current.current = next;
      focusRequested.current = true;
      setState(next);
    });
  return {
    ...state,
    parsed,
    dirty,
    applied,
    gone,
    notice,
    review,
    reviewReason,
    editReason,
    inlineBlocked,
    writing,
    start,
    changeText,
    beginField,
    input,
    finishField,
    setFieldValue,
    beginNewKey,
    addKey,
    reviewChanges,
    cancel,
    setFocus,
    returnFocus: () => focus.current?.(),
  };
}
export type PanelEdit = ReturnType<typeof usePanelEdit>;
