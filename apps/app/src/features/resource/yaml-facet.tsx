import { Button } from "@hukube/ui/components/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@hukube/ui/components/tooltip";
import {
  EyeIcon,
  Search01Icon,
  Cancel01Icon,
  InformationCircleIcon,
  Alert02Icon,
  CancelCircleIcon,
  CheckmarkCircle02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Skeleton } from "@hukube/ui/components/skeleton";
import { lazy, Suspense, useMemo, useRef, useState, useEffect, useLayoutEffect } from "react";
import { createPortal } from "react-dom";

import { useEngine, useConnectionState } from "@hukube/engine-client/react";
import {
  isDirty,
  startSession,
  followManifest,
  sessionNotice,
  type EditSession,
} from "../edit/session.ts";
import { parseManifest, metadata } from "../edit/yaml.ts";
import { fieldIssue, refusalLines } from "../edit/field-paths.ts";
import { guardResource, useUnsavedEdits } from "../edit/unsaved-edits.ts";
import { copyText } from "../edit/clipboard.ts";
import { useReview } from "../edit/use-review.ts";
import { ReviewDialog } from "../edit/review-dialog.tsx";

import type { FacetProps } from "./facet-props.ts";
import { manifestYaml } from "./manifest.ts";
import { Notice } from "./notice.tsx";
import type { YamlEditorHandle } from "./yaml-editor.tsx";

const YamlEditor = lazy(() => import("./yaml-editor.tsx"));

/** Shows the last Manifest and places its controls in the switcher while visible. */
export function YamlFacet({
  address,
  kind,
  manifest,
  lastObject,
  showing,
  controls,
  panelId,
  editAccess,
  onEdit,
}: FacetProps) {
  const [showManagedFields, setShowManagedFields] = useState(false);
  const editor = useRef<YamlEditorHandle>(null);
  const editButton = useRef<HTMLButtonElement>(null);
  const focusEdit = useRef(false);
  const [copied, setCopied] = useState(false);
  const client = useEngine();
  const connection = useConnectionState();
  const [session, setSession] = useState<EditSession>();
  const [applied, setApplied] = useState(false);
  const [copyError, setCopyError] = useState<string>();
  const dirty = isDirty(session);
  const label = `${kind} ${address.name}`;
  const live = manifest.data?.object;
  const deleted = !!manifest.data?.deleted;
  const [seenLive, setSeenLive] = useState({ live, deleted });
  if (seenLive.live !== live || seenLive.deleted !== deleted) {
    setSeenLive({ live, deleted });
    if (session) setSession(followManifest(session, live, deleted));
  }
  useEffect(() => {
    if (!applied) return;
    const timer = setTimeout(() => setApplied(false), 4000);
    return () => clearTimeout(timer);
  }, [applied]);
  const submittedText = useRef<string | undefined>(undefined);
  const review = useReview(
    client,
    live,
    () => {
      setSession((previous) => {
        if (previous?.text !== submittedText.current) return previous;
        focusEdit.current = true;
        return undefined;
      });
      setApplied(true);
    },
    (refusal) => setSession((previous) => (previous ? { ...previous, refusal } : previous)),
  );
  useEffect(() => {
    if ((!dirty && !review.pending && !review.unknownOutcome) || !session) {
      useUnsavedEdits.getState().set(panelId);
      return;
    }
    useUnsavedEdits.getState().set(panelId, {
      cluster: address.cluster,
      label,
      read: () => session.text,
      pendingApply: review.pending || review.unknownOutcome,
    });
    return () => useUnsavedEdits.getState().set(panelId);
  }, [dirty, session, panelId, address.cluster, label, review.pending, review.unknownOutcome]);
  const endReview = review.end;
  const hadSession = useRef(false);
  useLayoutEffect(() => {
    if (hadSession.current && !session) endReview();
    hadSession.current = !!session;
    if (!session && focusEdit.current) {
      focusEdit.current = false;
      editButton.current?.focus();
    }
  }, [session, endReview]);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);
  const [parsedText, setParsedText] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setParsedText(session?.text ?? ""), 200);
    return () => clearTimeout(timer);
  }, [session?.text]);
  const parsed = useMemo(() => parseManifest(parsedText), [parsedText]);
  const refusalIssues =
    session?.refusal?.causes?.flatMap((cause) => {
      const issue = cause.field ? fieldIssue(parsed, cause.field, cause.message) : undefined;
      return issue ? [issue] : [];
    }) ?? [];
  const issues = session ? [...parsed.issues, ...refusalIssues] : [];
  const gone = !!session && (deleted || (!!live && metadata(live)["uid"] !== session.uid));
  const writing =
    review.state?.phase === "applying" ||
    review.state?.phase === "disconnected" ||
    review.state?.phase === "applied";
  const reviewReason = writing
    ? "Waiting for the apply result"
    : gone
      ? "Your edits cannot be applied."
      : connection !== "open"
        ? "Reconnecting to the Engine"
        : !dirty
          ? "No unsaved edits"
          : undefined;
  const reviewChanges = () => {
    if (!session || reviewReason) return;
    const current = parseManifest(session.text);
    setParsedText(session.text);
    if (!current.object) {
      editor.current?.focus(current.issues[0]);
      return;
    }
    submittedText.current = session.text;
    review.begin({
      cluster: address.cluster,
      type: address.type,
      namespace: address.namespace,
      name: address.name,
      uid: session.uid,
      base: session.base,
      manifest: current.object,
    });
  };
  const cancel = () =>
    guardResource(panelId, () => {
      review.end();
      focusEdit.current = true;
      setSession(undefined);
    });
  const editReason =
    !live || deleted
      ? "The Manifest is not available."
      : editAccess?.allowed === false
        ? (editAccess.reason ?? "Not permitted")
        : undefined;
  const changeText = (text: string) =>
    setSession((previous) => (previous ? { ...previous, text, refusal: undefined } : previous));
  const sessionUid = session?.uid;
  const baseText = session?.baseText;
  // Not on every keystroke: the notice depends on what the edit started from, not on its text.
  const notice = useMemo(
    () =>
      sessionUid === undefined || baseText === undefined
        ? undefined
        : sessionNotice({ uid: sessionUid, baseText }, live, deleted, label, kind),
    [sessionUid, baseText, live, deleted, label, kind],
  );
  const refusal = session?.refusal;
  const yamlError = parsedText === session?.text && !!parsed.issues.length;
  const unconfirmed = review.unknownOutcome && !review.pending;
  const noticeKind = unconfirmed
    ? "warning"
    : gone || (!review.pending && (refusal || yamlError))
      ? "error"
      : review.pending || notice
        ? "warning"
        : "neutral";

  const yaml = useMemo(
    () => (lastObject ? manifestYaml(lastObject, { managedFields: showManagedFields }) : undefined),
    [lastObject, showManagedFields],
  );
  return (
    <div className="flex h-full min-h-0 flex-col">
      {showing &&
        controls &&
        createPortal(
          <>
            <Tooltip>
              <TooltipTrigger
                render={<Button variant="ghost" size="sm" disabled={yaml === undefined} />}
                className="shrink-0 @max-[26rem]/switcher:size-7 @max-[26rem]/switcher:p-0"
                aria-label="Search"
                onClick={() => editor.current?.search()}
              >
                <HugeiconsIcon
                  icon={Search01Icon}
                  aria-hidden="true"
                  className="hidden @max-[26rem]/switcher:block"
                />
                <span className="@max-[26rem]/switcher:hidden">Search</span>
              </TooltipTrigger>
              <TooltipContent>Search</TooltipContent>
            </Tooltip>
            {!session && (
              <Tooltip>
                <TooltipTrigger
                  render={<Button variant="ghost" size="sm" />}
                  className="shrink-0 @max-[26rem]/switcher:size-7 @max-[26rem]/switcher:p-0"
                  aria-label={showManagedFields ? "Hide managed fields" : "Show managed fields"}
                  aria-pressed={showManagedFields}
                  onClick={() => setShowManagedFields(!showManagedFields)}
                >
                  <HugeiconsIcon
                    icon={EyeIcon}
                    aria-hidden="true"
                    className="hidden @max-[26rem]/switcher:block"
                  />
                  <span className="@max-[26rem]/switcher:hidden">
                    {showManagedFields ? "Hide managed fields" : "Show managed fields"}
                  </span>
                </TooltipTrigger>
                <TooltipContent>
                  {showManagedFields ? "Hide managed fields" : "Show managed fields"}
                </TooltipContent>
              </Tooltip>
            )}
            {session ? (
              <>
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={cancel}
                        aria-label="Cancel"
                        className="@max-[26rem]/switcher:size-7 @max-[26rem]/switcher:p-0"
                      />
                    }
                  >
                    <HugeiconsIcon
                      icon={Cancel01Icon}
                      className="hidden @max-[26rem]/switcher:block"
                    />
                    <span className="@max-[26rem]/switcher:hidden">Cancel</span>
                  </TooltipTrigger>
                  <TooltipContent>Cancel changes</TooltipContent>
                </Tooltip>
                <Tooltip disabled={!reviewReason}>
                  <TooltipTrigger
                    render={
                      <Button
                        size="sm"
                        aria-disabled={!!reviewReason}
                        onClick={reviewChanges}
                        aria-label="Review changes"
                        className="aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
                      />
                    }
                  >
                    <span className="@max-[26rem]/switcher:hidden">Review changes</span>
                    <span className="hidden @max-[26rem]/switcher:block">Review</span>
                  </TooltipTrigger>
                  <TooltipContent>{reviewReason}</TooltipContent>
                </Tooltip>
              </>
            ) : (
              <>
                <Tooltip disabled={!editReason}>
                  <TooltipTrigger
                    render={
                      <Button
                        variant="outline"
                        size="sm"
                        ref={editButton}
                        aria-disabled={!!editReason}
                        className="aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
                        onClick={() => {
                          if (live && !editReason) {
                            setSession(startSession(live));
                            onEdit?.();
                          }
                        }}
                      />
                    }
                  >
                    Edit
                  </TooltipTrigger>
                  <TooltipContent>{editReason}</TooltipContent>
                </Tooltip>
              </>
            )}
          </>,
          controls,
        )}
      {manifest.error && (
        <p className="border-b px-3 py-2 text-destructive">{manifest.error.message}</p>
      )}
      {session && (
        <div
          data-notice={noticeKind}
          className={`flex max-h-32 shrink-0 flex-wrap items-start gap-2 overflow-auto border-b px-3 py-2 text-xs [overflow-wrap:anywhere] ${noticeKind === "error" ? "border-destructive/30 bg-destructive/10" : noticeKind === "warning" ? "border-warning/30 bg-warning/10" : "bg-muted/40"}`}
          aria-live="polite"
        >
          <HugeiconsIcon
            icon={
              noticeKind === "error"
                ? CancelCircleIcon
                : noticeKind === "warning"
                  ? Alert02Icon
                  : InformationCircleIcon
            }
            className={`size-4 shrink-0 ${noticeKind === "error" ? "text-destructive" : noticeKind === "warning" ? "text-warning" : "text-muted-foreground"}`}
            aria-hidden="true"
          />
          <div className="min-w-0 flex-1 basis-48">
            {unconfirmed ? (
              "hukube could not confirm whether your apply went through. Review changes shows the Cluster as it is now."
            ) : gone ? (
              notice
            ) : review.pending ? (
              "An apply of this edit was in flight when the connection to the Engine was lost. hukube checks the result when it reconnects."
            ) : refusal ? (
              <>
                <p className="font-medium">
                  {refusal.code === "forbidden"
                    ? "Not permitted"
                    : refusal.reason
                      ? "The Cluster refused this edit"
                      : "This edit cannot be applied"}
                </p>
                {refusalLines(refusal)
                  .slice(0, 3)
                  .map((line, i) => (
                    <p key={i}>{line}</p>
                  ))}
                {refusalLines(refusal).length > 3 && (
                  <p>and {refusalLines(refusal).length - 3} more</p>
                )}
              </>
            ) : parsedText === session.text && parsed.issues.length ? (
              `${parsed.issues[0]!.message} (line ${parsed.issues[0]!.line})`
            ) : (
              (notice ??
              "Editing. Fields the Cluster sets, such as status, are hidden. Nothing changes on the Cluster until you review and apply.")
            )}
          </div>
          {gone && (
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  void copyText(session.text)
                    .then(() => {
                      setCopied(true);
                      setCopyError(undefined);
                    })
                    .catch((error: unknown) => setCopyError(String(error)))
                }
              >
                <span aria-live="polite">{copied ? "Copied" : "Copy YAML"}</span>
              </Button>
              <Button variant="outline" size="sm" onClick={cancel}>
                Discard edits
              </Button>
            </div>
          )}
          {copyError && <p role="alert">{copyError}</p>}
        </div>
      )}
      <ReviewDialog
        review={review}
        cluster={address.cluster}
        label={label}
        namespace={address.namespace}
        onBack={() => editor.current?.focus()}
      />
      <div className="relative min-h-0 flex-1">
        {applied && (
          <output className="pointer-events-none absolute top-2 right-3 z-10 flex items-center gap-1 rounded-full border border-success/30 bg-popover px-2 py-1 text-xs text-foreground shadow-sm">
            <HugeiconsIcon
              icon={CheckmarkCircle02Icon}
              className="size-3.5 text-success"
              aria-hidden="true"
            />
            Applied
          </output>
        )}
        {yaml !== undefined ? (
          <Suspense fallback={<EditorSkeleton />}>
            <YamlEditor
              ref={editor}
              value={session?.text ?? yaml}
              editing={!!session}
              dirty={dirty && !reviewReason}
              issues={parsedText === session?.text ? issues : []}
              onChange={changeText}
              onReview={reviewChanges}
            />
          </Suspense>
        ) : manifest.data?.deleted ? (
          <Notice
            title="Not found"
            description={`No ${kind} named ${address.name} exists right now. This view updates if it is created.`}
          />
        ) : (
          <EditorSkeleton />
        )}
      </div>
    </div>
  );
}

function EditorSkeleton() {
  return (
    <div className="flex flex-col gap-2 p-3">
      <Skeleton className="h-3 w-40" />
      <Skeleton className="h-3 w-64" />
      <Skeleton className="h-3 w-52" />
    </div>
  );
}
