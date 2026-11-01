import { Input } from "@hukube/ui/components/input";
import { NativeSelect, NativeSelectOption } from "@hukube/ui/components/native-select";
import { definition, type CommandId } from "./catalog.ts";
/** Catalog metadata owns the field types shared by palette and Settings. */
export function ArgumentFields({
  id,
  value,
  onChange,
  onSubmit,
  types = [],
}: {
  id: CommandId;
  value: Record<string, unknown>;
  onChange: (v: Record<string, unknown>) => void;
  types?: string[];
  onSubmit?: () => void;
}) {
  return (
    <div className="flex flex-col gap-3">
      {definition(id).fields.map((field) => (
        <label key={field.name} className="flex min-w-0 flex-col gap-1 text-sm">
          {field.label}
          {field.required ? " (required)" : " (optional)"}
          {field.kind === "boolean" ? (
            <NativeSelect
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
              value={typeof value[field.name] === "string" ? (value[field.name] as string) : ""}
              onChange={(e) => onChange({ ...value, [field.name]: e.target.value })}
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
              name={field.name}
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
        </label>
      ))}
    </div>
  );
}
