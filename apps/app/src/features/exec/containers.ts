import type { Access, ConnectionState } from "@hukube/engine-client";
import { metadata } from "../edit/yaml.ts";

export interface ExecContainer {
  name: string;
  kind: "container" | "init" | "ephemeral";
  state: string;
}
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

/** Spec order, with the default container first and the other kinds last. */
export function execContainers(object: Record<string, unknown> | undefined): ExecContainer[] {
  const spec = record(object?.["spec"]);
  const status = record(object?.["status"]);
  const defaultName = record(metadata(object)["annotations"])[
    "kubectl.kubernetes.io/default-container"
  ];
  const result: ExecContainer[] = [];
  for (const [field, statuses, kind] of [
    ["containers", "containerStatuses", "container"],
    ["initContainers", "initContainerStatuses", "init"],
    ["ephemeralContainers", "ephemeralContainerStatuses", "ephemeral"],
  ] as const) {
    const states = new Map<string, string>();
    for (const raw of Array.isArray(status[statuses]) ? status[statuses] : []) {
      const item = record(raw);
      const state = record(item["state"]);
      if (typeof item["name"] === "string")
        states.set(
          item["name"],
          state["running"] ? "running" : state["terminated"] ? "terminated" : "waiting",
        );
    }
    const names = (Array.isArray(spec[field]) ? spec[field] : [])
      .map((raw: unknown) => record(raw)["name"])
      .filter((name: unknown): name is string => typeof name === "string");
    if (kind === "container" && typeof defaultName === "string" && names.includes(defaultName))
      names.splice(0, 0, ...names.splice(names.indexOf(defaultName), 1));
    for (const name of names) result.push({ name, kind, state: states.get(name) ?? "waiting" });
  }
  return result;
}

export function execDisabledReason(
  available: boolean,
  connection: ConnectionState,
  access: Access | undefined,
  running: boolean,
): string | undefined {
  if (!available) return "The Pod is not available.";
  if (connection !== "open") return "Reconnecting to the Engine";
  if (access?.allowed === false) return access.reason || "Not permitted";
  if (!running) return "No container is running.";
  return undefined;
}
