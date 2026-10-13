import { useEffect, useState } from "react";
import { useEngine } from "@hukube/engine-client/react";
import type { ResourceAccess, ResourceRef } from "@hukube/engine-client";
export function useResourceAccess(
  ref: ResourceRef | undefined,
  arrived: boolean,
): ResourceAccess | undefined {
  const client = useEngine();
  const [access, setAccess] = useState<ResourceAccess>();
  const key = ref ? JSON.stringify(ref) : undefined;
  useEffect(() => {
    if (!arrived || !key) return;
    const controller = new AbortController();
    void client
      .request("resource.access", JSON.parse(key) as ResourceRef, { signal: controller.signal })
      .then((answer) => {
        if (!controller.signal.aborted) setAccess(answer);
      })
      .catch(() => {});
    return () => controller.abort();
  }, [client, key, arrived]);
  return access;
}
