import type { Related } from "@hukube/engine-client";

const logTypes = new Set([
  "pods",
  "deployments.apps",
  "replicasets.apps",
  "statefulsets.apps",
  "daemonsets.apps",
  "jobs.batch",
  "cronjobs.batch",
  "replicationcontrollers",
]);

export function typeHasLogs(type: string): boolean {
  return logTypes.has(type);
}
export function ownsPods(related: Related | undefined): boolean {
  return (
    related?.sections.some(
      (section) =>
        section.relationship === "owns" &&
        section.direction === "out" &&
        (section.truncated || section.rows.some((row) => row.type === "pods")),
    ) ?? false
  );
}
