import { Harness, readEnvironment } from "../harness.ts";

const owner = readEnvironment();
const harness = new Harness(owner);
export const engineToken = "e2e";
export const kubeconfig = owner.kubeconfig;
/** The kubeconfig context k3d creates for this checkout's private test Cluster. */
export const clusterId = `k3d-${owner.cluster}`;

/** Runs kubectl only after validating the private kubeconfig's current context. */
export function kubectl(...args: string[]): string {
  return harness.kubectl(args);
}

/** Creates a Resource from JSON in the private test Cluster. */
export function kubectlCreate(resource: Record<string, unknown>): string {
  return harness.kubectl(["create", "-f", "-"], JSON.stringify(resource));
}
