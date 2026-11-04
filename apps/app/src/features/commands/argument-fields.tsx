import { useId } from "react";
import { formatResourceUri } from "@hukube/k8s";
import { Input } from "@hukube/ui/components/input";
import { NativeSelect, NativeSelectOption } from "@hukube/ui/components/native-select";
import { definition, type ArgumentIssue, type CommandId } from "./catalog.ts";
/** Catalog metadata owns the field types shared by palette and Settings. */
export function ArgumentFields({
  id,
  value,
  onChange,
  onSubmit,
  types = [],
  issues = [],
  cluster = "cluster",
}: {
  id: CommandId;
  value: Record<string, unknown>;
  onChange: (v: Record<string, unknown>) => void;
  types?: string[];
  issues?: ArgumentIssue[];
  cluster?: string;
  onSubmit?: () => void;
}) {
  const base = useId();
  const example = formatResourceUri({
    cluster,
    type: "pods",
    namespace: "default",
    name: "example",
  });
  return (
    <div className="flex flex-col gap-3">
      {definition(id).fields.map((field) => {
        const fieldId = `${base}-${field.name}`;
        const error = issues.find((issue) => issue.field === field.name);
        const describedBy =
          [field.name === "uri" && `${fieldId}-help`, error && `${fieldId}-error`]
            .filter(Boolean)
            .join(" ") || undefined;
        const attributes = {
          id: fieldId,
          name: field.name,
          "data-argument-field": field.name,
          "aria-invalid": error ? true : undefined,
          "aria-describedby": describedBy,
        };
        return (
          <div key={field.name} className="flex min-w-0 flex-col gap-1 text-sm">
            <label htmlFor={fieldId}>
              {field.label}
              {field.required ? " (required)" : " (optional)"}
            </label>
            {field.kind === "boolean" ? (
              <NativeSelect
                {...attributes}
                value={value[field.name] === undefined ? "" : String(value[field.name])}
                onChange={(e) => {
                  const next = { ...value };
                  if (e.target.value === "") delete next[field.name];
                  else next[field.name] = e.target.value === "true";
                  onChange(next);
                }}
              >
                <NativeSelectOption value="">Choose…</NativeSelectOption>
                <NativeSelectOption value="true">Yes</NativeSelectOption>
                <NativeSelectOption value="false">No</NativeSelectOption>
              </NativeSelect>
            ) : field.kind === "enum" || (field.name === "type" && types.length) ? (
              <NativeSelect
                {...attributes}
                value={typeof value[field.name] === "string" ? (value[field.name] as string) : ""}
                onChange={(e) => {
                  const next = { ...value };
                  if (e.target.value === "") delete next[field.name];
                  else next[field.name] = e.target.value;
                  onChange(next);
                }}
              >
                <NativeSelectOption value="">Choose…</NativeSelectOption>
                {(field.options ?? types).map((v) => (
                  <NativeSelectOption key={v} value={v}>
                    {v}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            ) : (
              <Input
                {...attributes}
                placeholder={field.name === "uri" ? example : undefined}
                onKeyDown={(event) => {
                  if (
                    onSubmit &&
                    event.key === "Enter" &&
                    !event.repeat &&
                    !event.nativeEvent.isComposing &&
                    event.nativeEvent.keyCode !== 229 &&
                    !event.ctrlKey &&
                    !event.metaKey &&
                    !event.altKey
                  ) {
                    event.preventDefault();
                    onSubmit();
                  }
                }}
                autoComplete="off"
                spellCheck={false}
                value={typeof value[field.name] === "string" ? (value[field.name] as string) : ""}
                onChange={(e) => onChange({ ...value, [field.name]: e.target.value })}
              />
            )}
            {field.name === "uri" && (
              <p id={`${fieldId}-help`} className="break-words text-xs text-muted-foreground">
                Use{" "}
                <span className="break-all">
                  hukube://resource/v1/&#123;cluster&#125;/&#123;type&#125;/&#123;namespace&#125;/&#123;name&#125;
                </span>{" "}
                with percent-encoded segments. Use _ for cluster-scoped Resources. The Cluster must
                match the captured Workspace. Example: <span className="break-all">{example}</span>
              </p>
            )}
            {error && (
              <p id={`${fieldId}-error`} role="alert" className="text-sm text-destructive">
                {error.message}
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** Focus in catalog order, falling back to JSON for object/unknown-field errors. */
export function focusInvalidArgument(form: HTMLFormElement | null, issues: ArgumentIssue[]) {
  const fields = form?.querySelectorAll<HTMLElement>("[data-argument-field]");
  const first = issues.some((issue) => !issue.field)
    ? undefined
    : Array.from(fields ?? []).find((field) =>
        issues.some((issue) => issue.field === field.dataset["argumentField"]),
      );
  (first ?? form?.querySelector<HTMLElement>("[name=arguments]"))?.focus();
}
