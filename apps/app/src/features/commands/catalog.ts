import { z } from "zod";
import { parseResourceUri, formatResourceUri } from "@hukube/k8s";
const empty = z.strictObject({});
const opening = { preview: z.boolean().optional(), beside: z.boolean().optional() };
const schemas = {
  "app.commandPalette": empty,
  "app.goToResource": empty,
  "app.openSettings": z.strictObject({
    section: z
      .enum(["appearance", "log-streams", "overview-definitions", "keyboard-shortcuts"])
      .optional(),
  }),
  "resource.openType": z.strictObject({ type: z.string().min(1), ...opening }),
  "resource.open": z.strictObject({
    uri: z.string().refine((v) => {
      const a = parseResourceUri(v);
      return !!a && formatResourceUri(a) === v;
    }, "Use a canonical Resource URI"),
    ...opening,
  }),
  "tab.close": empty,
  "tab.pin": empty,
  "editor.find": empty,
  "manifest.review": empty,
  "appearance.setTheme": z.strictObject({ theme: z.enum(["light", "dark"]) }),
  "logs.setWrap": z.strictObject({ enabled: z.boolean() }),
  "logs.setTimestamps": z.strictObject({ enabled: z.boolean() }),
  "terminal.copy": empty,
  "terminal.paste": empty,
  "terminal.selectAll": empty,
  "terminal.clear": empty,
};
export type CommandId = keyof typeof schemas;
export type CommandArgs<K extends CommandId> = z.infer<(typeof schemas)[K]>;
export interface PromptField {
  name: string;
  label: string;
  kind: "string" | "boolean" | "enum";
  options?: readonly string[];
  required?: boolean;
}
interface Definition {
  id: CommandId;
  title: string;
  category: string;
  description: string;
  target: "window" | "workspace" | "tab" | "editor" | "terminal";
  fields: PromptField[];
  repeat: "once";
}
const titles: Record<CommandId, string> = {
  "app.commandPalette": "Command palette",
  "app.goToResource": "Go to Resource",
  "app.openSettings": "Open Settings",
  "resource.openType": "Open Resource Type",
  "resource.open": "Open Resource",
  "tab.close": "Close Tab",
  "tab.pin": "Pin Preview Tab",
  "editor.find": "Find",
  "manifest.review": "Review Manifest changes",
  "appearance.setTheme": "Set theme",
  "logs.setWrap": "Set Log Stream wrapping",
  "logs.setTimestamps": "Set Log Stream timestamps",
  "terminal.copy": "Copy terminal selection",
  "terminal.paste": "Paste into terminal",
  "terminal.selectAll": "Select all terminal text",
  "terminal.clear": "Clear terminal scrollback",
};
const descriptions: Record<CommandId, string> = {
  "app.commandPalette": "Search app actions and their arguments.",
  "app.goToResource": "Find a Resource Type or Resource by name in the captured Workspace.",
  "app.openSettings": "Open Appearance, Log Streams, Overview definitions or Keyboard shortcuts.",
  "resource.openType": "Open a Resource Type list in the captured Workspace.",
  "resource.open": "Open a canonical Resource URI in the captured Workspace.",
  "tab.close": "Close the captured Tab, confirming unsaved edits or a running Exec Session.",
  "tab.pin": "Keep the captured Preview Tab when another Resource opens.",
  "editor.find": "Search the captured Manifest, Log Stream or terminal scrollback.",
  "manifest.review": "Review the captured Manifest edits before applying them.",
  "appearance.setTheme": "Save a light or dark theme for every window on this Engine.",
  "logs.setWrap": "Save wrapping for Log Streams in every window.",
  "logs.setTimestamps": "Save timestamp visibility for Log Streams in every window.",
  "terminal.copy": "Copy the captured terminal selection to the clipboard.",
  "terminal.paste": "Paste clipboard text into the captured live Exec Session.",
  "terminal.selectAll": "Select text in the captured terminal scrollback.",
  "terminal.clear": "Clear the captured terminal scrollback without restarting its process.",
};
export const catalog: Definition[] = (Object.keys(schemas) as CommandId[]).map((id) => ({
  id,
  title: titles[id],
  category: id.split(".")[0]!,
  description: descriptions[id],
  repeat: "once",
  target:
    id.startsWith("resource.") || id === "app.goToResource"
      ? "workspace"
      : id.startsWith("tab.")
        ? "tab"
        : id.startsWith("terminal.")
          ? "terminal"
          : id === "editor.find" || id === "manifest.review"
            ? "editor"
            : "window",
  fields:
    id === "app.openSettings"
      ? [
          {
            name: "section",
            label: "Settings category",
            kind: "enum",
            options: ["appearance", "log-streams", "overview-definitions", "keyboard-shortcuts"],
          },
        ]
      : id.startsWith("resource.")
        ? [
            {
              name: id === "resource.open" ? "uri" : "type",
              label: id === "resource.open" ? "Resource URI" : "Resource Type",
              kind: "string",
              required: true,
            },
            { name: "preview", label: "Preview Tab", kind: "boolean" },
            { name: "beside", label: "Open beside captured Tab", kind: "boolean" },
          ]
        : id === "appearance.setTheme"
          ? [
              {
                name: "theme",
                label: "Theme",
                kind: "enum",
                options: ["light", "dark"],
                required: true,
              },
            ]
          : id.startsWith("logs.")
            ? [{ name: "enabled", label: "Enabled", kind: "boolean", required: true }]
            : [],
}));
export function isCommand(id: string): id is CommandId {
  return Object.hasOwn(schemas, id);
}
export interface ArgumentIssue {
  field?: string;
  message: string;
}
/** One schema and readable diagnostics for invocation and both argument forms. */
export function validateArguments(id: CommandId, raw: unknown, prompt = false) {
  const schema = schemas[id];
  // Partial validates supplied arguments without accepting unknown ones. Missing required fields prompt later.
  const result = (prompt ? schema.partial() : schema).safeParse(raw);
  if (result.success) return { data: result.data as Record<string, unknown>, issues: [] };
  const issues: ArgumentIssue[] = result.error.issues.map((issue) => {
    const field = definition(id).fields.find((f) => f.name === issue.path[0]);
    if (!field)
      return {
        message:
          issue.code === "unrecognized_keys"
            ? `Arguments: Unknown field${issue.keys.length === 1 ? "" : "s"}: ${issue.keys.join(", ")}.`
            : "Arguments: Enter a JSON object.",
      };
    const value =
      raw && typeof raw === "object" ? (raw as Record<string, unknown>)[field.name] : undefined;
    const missing = value === undefined || value === "";
    const detail =
      field.kind === "boolean"
        ? "Choose Yes or No."
        : missing
          ? field.kind === "enum"
            ? "Choose a value."
            : "Enter a value."
          : field.kind === "enum"
            ? `Choose ${field.options!.join(" or ")}.`
            : typeof value !== "string"
              ? "Enter text."
              : field.name === "uri"
                ? "Use a canonical Resource URI."
                : issue.message;
    return { field: field.name, message: `${field.label}: ${detail}` };
  });
  return { data: undefined, issues };
}
export function argumentsFor(id: CommandId, raw: unknown, prompt = false) {
  const result = validateArguments(id, raw ?? {}, prompt);
  if (!result.data) throw Error(result.issues.map((issue) => issue.message).join("; "));
  return result.data;
}
export function definition(id: CommandId) {
  return catalog.find((c) => c.id === id)!;
}
