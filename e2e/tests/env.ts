import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

export const enginePort = 7555;
export const engineToken = "e2e";
export const kubeconfig = resolve(
  import.meta.dirname,
  "..",
  process.env["E2E_KUBECONFIG"] ?? "../.data/e2e/kubeconfig",
);
/** The kubeconfig context k3d creates for the e2e cluster. */
export const clusterId = `k3d-${process.env["E2E_CLUSTER"] ?? "hukube-e2e"}`;

/** Runs kubectl against the e2e cluster. */
export function kubectl(...args: string[]): string {
  return execFileSync("kubectl", ["--kubeconfig", kubeconfig, ...args], { encoding: "utf8" });
}
