import { Button } from "@hukube/ui/components/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@hukube/ui/components/tooltip";
import { EyeIcon, Search01Icon, Cancel01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Skeleton } from "@hukube/ui/components/skeleton";
import { lazy, Suspense, useMemo, useRef, useState, useEffect } from "react";
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
    if (!dirty || !session) {
      useUnsavedEdits.getState().set(panelId);
      return;
    }
    useUnsavedEdits
      .getState()
      .set(panelId, { cluster: address.cluster, label, read: () => session.text });
    return () => useUnsavedEdits.getState().set(panelId);
  }, [dirty, session, panelId, address.cluster, label]);
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
      setSession((previous) => (previous?.text === submittedText.current ? undefined : previous));
      setApplied(true);
    },
    (refusal) => setSession((previous) => (previous ? { ...previous, refusal } : previous)),
  );
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
  const cancel = () => guardResource(panelId, () => setSession(undefined));
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
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        size="sm"
                        disabled={!!reviewReason}
                        focusableWhenDisabled
                        onClick={reviewChanges}
                        aria-label="Review changes"
                        className="aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
                      />
                    }
                  >
                    <span className="@max-[26rem]/switcher:hidden">Review changes</span>
                    <span className="hidden @max-[26rem]/switcher:block">Review</span>
                  </TooltipTrigger>
                  <TooltipContent>{reviewReason ?? "Review changes"}</TooltipContent>
                </Tooltip>
              </>
            ) : (
              <>
                <output className="text-xs text-muted-foreground not-empty:px-2">
                  {applied ? "Applied" : ""}
                </output>
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={!!editReason}
                        focusableWhenDisabled
                        className="aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
                        onClick={() => {
                          if (live) {
                            setSession(startSession(live));
                            onEdit?.();
                          }
                        }}
                      />
                    }
                  >
                    Edit
                  </TooltipTrigger>
                  <TooltipContent>{editReason ?? "Edit"}</TooltipContent>
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
          className="flex flex-wrap items-center gap-2 border-b bg-muted/40 px-3 py-2 text-xs break-words"
          aria-live="polite"
        >
          <div className="min-w-0 flex-1 basis-48">
            {gone ? (
              notice
            ) : refusal ? (
              <>
                <p className="font-medium">
                  {refusal.code === "forbidden" ? "Not permitted" : "The Cluster refused this edit"}
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
                  void copyText(session.text).catch((error: unknown) => setCopyError(String(error)))
                }
              >
                Copy YAML
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
      <div className="min-h-0 flex-1">
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
