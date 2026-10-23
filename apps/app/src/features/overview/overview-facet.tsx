import { isNode } from "yaml";
import { useLayoutEffect, useRef, useState, useId } from "react";
import { Button } from "@hukube/ui/components/button";
import { Input } from "@hukube/ui/components/input";
import { Textarea } from "@hukube/ui/components/textarea";
import { NativeSelect, NativeSelectOption } from "@hukube/ui/components/native-select";
import { Badge } from "@hukube/ui/components/badge";
import { Skeleton } from "@hukube/ui/components/skeleton";
import { cn } from "@hukube/ui/lib/utils";
import { fieldIssue } from "../edit/field-paths.ts";
import { isRecord } from "../edit/yaml.ts";
import type { FacetProps } from "../resource/facet-props.ts";
import { Notice } from "../resource/notice.tsx";
import {
  secretPath,
  fieldReason,
  valueAt,
  semanticEqual,
  changedPaths,
  isLivePath,
} from "./draft.ts";
import type { Definition, EditControl, FieldPath, OverviewField } from "./definition.ts";
import type { PanelEdit } from "../edit/use-panel-edit.ts";

const rowLimit = 100;
function display(value: unknown, format: string): string {
  if (value === undefined) return "Not set";
  if (value === null) return "null";
  if (format === "timestamp" && typeof value === "string") {
    const date = new Date(value);
    if (Number.isFinite(date.valueOf())) return date.toLocaleString();
  }
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? String(value)
    : JSON.stringify(value, null, 2);
}
function revealed(value: unknown, encoded: boolean) {
  if (typeof value !== "string") return "Binary value";
  if (!encoded) return value;
  try {
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value))
      return "Binary value";
    return new TextDecoder("utf-8", { fatal: true }).decode(
      Uint8Array.from(atob(value), (c) => c.charCodeAt(0)),
    );
  } catch {
    return "Binary value";
  }
}
export function OverviewFacet(props: FacetProps) {
  const { definition, edit, lastObject, manifest, showing } = props;
  const root = useRef<HTMLDivElement>(null);
  const setFocus = edit?.setFocus;
  useLayoutEffect(() => {
    if (showing && setFocus)
      setFocus(() => {
        const target =
          root.current?.querySelector<HTMLElement>("[data-inline-active]") ??
          root.current?.querySelector<HTMLElement>("[data-inline-origin] button") ??
          root.current?.querySelector<HTMLElement>("button");
        target?.focus();
      });
  }, [showing, setFocus]);
  if (!definition || !edit) return null;
  if (!lastObject)
    return manifest.data?.deleted ? (
      <Notice
        title="Not found"
        description={`No ${props.kind} named ${props.address.name} exists right now.`}
      />
    ) : manifest.error ? (
      <Notice title="Could not load Resource" description={manifest.error.message} />
    ) : (
      <div className="flex flex-col gap-3 p-4">
        <Skeleton className="h-24" />
        <Skeleton className="h-24" />
      </div>
    );
  const object = edit.session ? edit.parsed?.object : lastObject;
  const rendered: FieldPath[] = [];
  for (const section of definition.sections)
    for (const f of section.fields) {
      if (f.type !== "table") rendered.push(f.path);
      else {
        const rows = valueAt(object, f.path);
        if (Array.isArray(rows))
          rows
            .slice(0, rowLimit)
            .forEach((_row, i) =>
              f.columns.forEach((c) => rendered.push([...f.path, i, ...c.path])),
            );
      }
    }
  const outside =
    edit.session &&
    object &&
    changedPaths(edit.session.base, object).some(
      (p) => !rendered.some((r) => r.length <= p.length && r.every((key, i) => p[i] === key)),
    );
  return (
    <div ref={root} className="@container/overview h-full min-h-0 overflow-auto">
      {manifest.error && (
        <p className="border-b px-3 py-2 text-destructive">{manifest.error.message}</p>
      )}
      {edit.inlineBlocked && (
        <p className="border-b px-3 py-2 text-xs text-warning">
          {edit.inlineBlocked}{" "}
          <Button size="sm" variant="link" onClick={() => props.onFacet?.("yaml")}>
            Open YAML
          </Button>
        </p>
      )}
      {outside && (
        <p className="border-b px-3 py-2 text-xs text-muted-foreground">
          This draft also changes fields outside this Overview.{" "}
          <Button size="sm" variant="link" onClick={() => props.onFacet?.("yaml")}>
            View YAML
          </Button>
        </p>
      )}
      <div className="grid grid-cols-1 items-start gap-4 p-4 @[42rem]/overview:grid-cols-2">
        {definition.sections.map((section) => {
          if (
            section.hideEmpty &&
            section.fields.every(
              (f) => !("edit" in f && f.edit) && isEmpty(valueAt(lastObject, f.path)),
            )
          )
            return null;
          return (
            <section
              key={section.id}
              aria-label={section.title}
              className="min-w-0 overflow-hidden rounded-md border bg-card"
            >
              <h3 className="border-b px-3 py-2 text-xs font-semibold">{section.title}</h3>
              <div className="flex flex-col gap-3 p-3">
                {section.fields.map((f) => (
                  <Field
                    key={f.id}
                    {...props}
                    definition={definition}
                    edit={edit}
                    field={f}
                    object={object}
                  />
                ))}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}
function isEmpty(value: unknown) {
  return (
    value === undefined ||
    value === null ||
    (typeof value === "object" && Object.keys(value).length === 0)
  );
}
function Field(
  props: FacetProps & {
    definition: Definition;
    edit: PanelEdit;
    field: OverviewField;
    object: unknown;
  },
) {
  const { field: f, edit, definition, object, lastObject } = props;
  const reasonId = useId();
  const value = valueAt(isLivePath(f.path) ? lastObject : object, f.path);
  const sensitive =
    (props.address.type === "secrets" && ["data", "stringData"].includes(String(f.path[0]))) ||
    (f.type === "map" && f.sensitive);
  if (f.type === "field")
    return (
      <Value
        {...props}
        path={f.path}
        label={f.label}
        format={f.format}
        control={f.edit}
        sensitive={sensitive || f.format === "sensitive"}
      />
    );
  if (f.type === "map") {
    const entries = isRecord(value) ? Object.entries(value) : [];
    const adding = edit.field?.newKey && semanticEqual(edit.field.path, f.path);
    const allowed =
      f.edit &&
      !sensitive &&
      (value === undefined || (isRecord(value) && entries.every(([, v]) => typeof v === "string")));
    return (
      <div className="flex min-w-0 flex-col gap-2">
        <h4 className="text-xs font-medium text-muted-foreground">{f.label}</h4>
        {value !== undefined && !isRecord(value) ? (
          <p className="break-all text-xs">
            {sensitive || secretPath(props.address.type, f.path)
              ? "Masked value"
              : display(value, "text")}{" "}
            <span className="text-muted-foreground">Edit in YAML.</span>
          </p>
        ) : (
          <>
            {!entries.length && (
              <p className="text-xs text-muted-foreground">{f.empty ?? "No entries"}</p>
            )}
            {entries.slice(0, rowLimit).map(([key, entry]) => (
              <Value
                key={key}
                {...props}
                path={[...f.path, key]}
                label={key}
                format="multiline"
                control={
                  allowed
                    ? {
                        ...f.edit!,
                        multiline:
                          f.edit!.multiline || (typeof entry === "string" && entry.includes("\n")),
                      }
                    : undefined
                }
                sensitive={sensitive}
              />
            ))}
            {entries.length > rowLimit && (
              <p className="text-xs text-muted-foreground">
                {entries.length - rowLimit} more entries. See YAML for the complete value.
              </p>
            )}
          </>
        )}
        {f.edit && !allowed && !sensitive && isRecord(value) && (
          <p className="text-xs text-muted-foreground">
            This map contains non-string values. Edit in YAML.
          </p>
        )}
        {allowed && !adding && (
          <Button
            size="sm"
            variant="outline"
            className="self-start"
            disabled={!!edit.editReason || !!edit.inlineBlocked || !!edit.field}
            onClick={() => edit.beginNewKey(f.path, f.label, definition)}
          >
            Add {f.label.toLowerCase()} key
          </Button>
        )}
        {adding && (
          <div className="flex flex-col gap-2">
            <Input
              aria-label={`New ${f.label.toLowerCase()} key`}
              value={edit.field!.raw}
              onChange={(e) => edit.input(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") edit.finishField(true);
                if (e.key === "Enter") edit.addKey();
              }}
              aria-invalid={!!edit.field?.error}
              aria-describedby={edit.field?.error ? reasonId : undefined}
            />
            {edit.field?.error && (
              <p id={reasonId} className="text-xs text-destructive">
                {edit.field.error}
              </p>
            )}
            <div className="flex gap-1">
              <Button size="sm" disabled={!!edit.field?.error} onClick={edit.addKey}>
                Add key
              </Button>
              <Button size="sm" variant="ghost" onClick={() => edit.finishField(true)}>
                Cancel key
              </Button>
            </div>
          </div>
        )}
      </div>
    );
  }
  const rows = Array.isArray(value) ? value : [];
  return (
    <div className="min-w-0">
      <h4 className="mb-2 text-xs font-medium text-muted-foreground">{f.label}</h4>
      {!rows.length ? (
        <p className="text-xs text-muted-foreground">
          {value !== undefined && !Array.isArray(value)
            ? sensitive || secretPath(props.address.type, f.path)
              ? "Masked value. Edit in YAML."
              : `${display(value, "text")}. Edit in YAML.`
            : (f.empty ?? "No rows")}
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead>
              <tr>
                {f.columns.map((c) => (
                  <th key={c.id} className="px-2 pb-2 font-medium text-muted-foreground">
                    {c.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, rowLimit).map((_row, i) => (
                <tr key={i} className="border-t">
                  {f.columns.map((c) => (
                    <td key={c.id} className="min-w-28 px-2 py-2 align-top">
                      <Value
                        {...props}
                        path={[...f.path, i, ...c.path]}
                        label={`${f.label} ${i + 1} ${c.label}`}
                        format={c.format}
                        control={c.edit}
                        compact
                        sensitive={
                          secretPath(props.address.type, f.path) || c.format === "sensitive"
                        }
                      />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {rows.length > rowLimit && (
        <p className="mt-2 text-xs text-muted-foreground">
          {rows.length - rowLimit} more rows. See YAML for the complete value.
        </p>
      )}
    </div>
  );
}
function Value({
  path,
  label,
  format,
  control,
  compact,
  sensitive: definedSensitive,
  ...props
}: FacetProps & {
  definition: Definition;
  edit: PanelEdit;
  object: unknown;
  path: FieldPath;
  label: string;
  format: string;
  control?: EditControl;
  compact?: boolean;
  sensitive?: boolean;
}) {
  const { edit, definition, object, lastObject } = props;
  const sensitive = definedSensitive || secretPath(props.address.type, path);
  const input = useRef<HTMLInputElement & HTMLTextAreaElement & HTMLSelectElement>(null);
  const fieldRoot = useRef<HTMLDivElement>(null);
  const reasonId = useId();
  const [reveal, setReveal] = useState(false);
  const live = isLivePath(path);
  const value = valueAt(live ? lastObject : object, path);
  const base = valueAt(edit.session?.base ?? lastObject, path);
  const changed = !!edit.session && !live && !semanticEqual(value, base);
  const active = !edit.field?.newKey && !!edit.field && semanticEqual(edit.field.path, path);
  const choices = control?.type === "boolean" ? ["true", "false"] : (control?.choices ?? []);
  useLayoutEffect(() => {
    if (active && props.showing) input.current?.focus();
  }, [active, props.showing]);
  const reason = control
    ? ((edit.gone
        ? "This Resource was deleted or replaced. Your edit cannot be applied."
        : undefined) ??
      edit.editReason ??
      edit.inlineBlocked ??
      (sensitive
        ? "Sensitive values are read-only in Overview."
        : fieldReason(object, path, control)))
    : undefined;
  const node = edit.parsed?.document.getIn(path, true);
  const position =
    isNode(node) && node.range ? edit.parsed?.lines.linePos(node.range[0]) : undefined;
  const refusal =
    position &&
    edit.session?.refusal?.causes?.find((cause) => {
      const issue =
        cause.field && edit.parsed
          ? fieldIssue(edit.parsed, cause.field, cause.message)
          : undefined;
      return issue && issue.line === position.line && issue.column === position.col;
    });
  const text = sensitive
    ? reveal
      ? props.address.type === "secrets" && path[0] === "data"
        ? revealed(value, true)
        : display(value, "text")
      : value === undefined
        ? "Not set"
        : "••••••••"
    : display(value, format);
  const events = {
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        edit.finishField(true);
      } else if (
        e.key === "Enter" &&
        !control?.multiline &&
        control?.type !== "boolean" &&
        control?.type !== "enum"
      ) {
        e.preventDefault();
        edit.finishField();
      }
    },
    onBlur: (event: React.FocusEvent<HTMLElement>) => {
      if (!control?.multiline && !fieldRoot.current?.contains(event.relatedTarget))
        edit.finishField();
    },
  };
  return (
    <div
      data-inline-origin={semanticEqual(edit.origin, path) || undefined}
      className={cn(
        "flex min-w-0 flex-col gap-1",
        changed && "rounded border-l-2 border-warning pl-2",
      )}
    >
      {!compact && <span className="text-xs text-muted-foreground">{label}</span>}
      {active ? (
        <div ref={fieldRoot} className="flex min-w-0 flex-col gap-1">
          {control?.type === "boolean" || control?.type === "enum" ? (
            <NativeSelect
              ref={input}
              data-inline-active
              aria-label={label}
              aria-invalid={!!edit.field?.error}
              aria-describedby={edit.field?.error ? reasonId : undefined}
              value={
                edit.field!.lastWritten === undefined
                  ? ""
                  : String(choices.indexOf(edit.field!.raw))
              }
              onChange={(e) => {
                const choice = choices[Number(e.target.value)];
                if (e.target.value !== "" && choice !== undefined) edit.input(choice);
              }}
              {...events}
            >
              <NativeSelectOption value="" disabled>
                Choose a value
              </NativeSelectOption>
              {edit.field!.lastWritten !== undefined && !choices.includes(edit.field!.raw) && (
                <NativeSelectOption value="-1" disabled>
                  {edit.field!.raw || "(empty string)"} (current value)
                </NativeSelectOption>
              )}
              {choices.map((choice, index) => (
                <NativeSelectOption key={choice} value={String(index)}>
                  {choice || "(empty string)"}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          ) : control?.multiline ? (
            <Textarea
              ref={input}
              data-inline-active
              aria-label={label}
              value={edit.field!.raw}
              aria-invalid={!!edit.field?.error}
              aria-describedby={edit.field?.error ? reasonId : undefined}
              onChange={(e) => edit.input(e.target.value)}
              {...events}
            />
          ) : (
            <Input
              ref={input}
              data-inline-active
              aria-label={label}
              inputMode={
                control?.type === "integer" || control?.type === "number" ? "decimal" : "text"
              }
              value={edit.field!.raw}
              aria-invalid={!!edit.field?.error}
              aria-describedby={edit.field?.error ? reasonId : undefined}
              onChange={(e) => edit.input(e.target.value)}
              {...events}
            />
          )}
          {edit.field?.error && (
            <p id={reasonId} className="text-xs text-destructive">
              {edit.field.error}
            </p>
          )}
          <div className="flex flex-wrap gap-1">
            <Button
              size="sm"
              variant="outline"
              disabled={!!edit.field?.error}
              onClick={() => edit.finishField()}
            >
              Done
            </Button>
            <Button size="sm" variant="ghost" onClick={() => edit.finishField(true)}>
              Cancel field
            </Button>
            {control?.remove && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => edit.setFieldValue(path, undefined, control, definition)}
              >
                Remove
              </Button>
            )}
          </div>
        </div>
      ) : control && !sensitive && !live ? (
        <Button
          variant="ghost"
          className={cn(
            "h-auto min-h-7 justify-start whitespace-pre-wrap px-1 py-1 text-left font-mono text-xs [overflow-wrap:anywhere]",
            changed && "text-warning",
          )}
          aria-label={`Edit ${label}`}
          aria-describedby={reason ? reasonId : undefined}
          disabled={!!reason || !!edit.field?.error || !!edit.field?.newKey}
          onClick={() => edit.beginField(path, label, control, definition)}
        >
          {text}
        </Button>
      ) : (
        <div className="whitespace-pre-wrap font-mono text-xs [overflow-wrap:anywhere]">
          {format === "badge" && !sensitive ? <Badge variant="secondary">{text}</Badge> : text}
        </div>
      )}
      {reason && reason !== edit.inlineBlocked && (
        <p id={reasonId} className="text-xs text-muted-foreground">
          {reason}
        </p>
      )}
      {sensitive && value !== undefined && (
        <Button
          size="sm"
          variant="outline"
          className="self-start"
          aria-label={`${reveal ? "Hide" : "Reveal"} ${label}`}
          onClick={() => setReveal(!reveal)}
        >
          {reveal ? "Hide" : "Reveal"}
        </Button>
      )}
      {changed && (
        <div className="flex items-center gap-2">
          <span className="text-xs text-warning">Changed</span>
          {control && !sensitive && !live ? (
            <Button
              variant="link"
              size="sm"
              disabled={!!reason}
              onClick={() =>
                edit.setFieldValue(path, base, { ...control, remove: true }, definition)
              }
            >
              Revert {compact ? "field" : label}
            </Button>
          ) : (
            <Button variant="link" size="sm" onClick={() => props.onFacet?.("yaml")}>
              View YAML
            </Button>
          )}
        </div>
      )}
      {refusal && <p className="text-xs text-destructive">{refusal.message}</p>}
    </div>
  );
}
