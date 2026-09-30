import "./styles.css";

import { WorkerEngineClient } from "@hukube/engine-client";
import { EngineProvider } from "@hukube/engine-client/react";
import { detectHost } from "@hukube/host";
import { TooltipProvider } from "@hukube/ui/components/tooltip";
import { createRouter, RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { HostProvider } from "./lib/host.tsx";
import { applyStoredTheme } from "./lib/theme.ts";
import { routeTree } from "./routeTree.gen.ts";

const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

applyStoredTheme();
const root = createRoot(document.getElementById("root")!);
const host = detectHost({ engineUrl: import.meta.env.VITE_ENGINE_URL });

host.engine().then(
  (endpoint) => {
    const client = new WorkerEngineClient(endpoint);
    root.render(
      <StrictMode>
        <HostProvider host={host}>
          <EngineProvider client={client}>
            <TooltipProvider>
              <RouterProvider router={router} />
            </TooltipProvider>
          </EngineProvider>
        </HostProvider>
      </StrictMode>,
    );
  },
  (err: unknown) => {
    root.render(
      <div className="flex h-full flex-col items-start justify-center gap-2 p-10">
        <h1 className="text-lg font-semibold">Cannot find the Engine</h1>
        <p className="max-w-prose text-muted-foreground">
          {err instanceof Error ? err.message : String(err)}
        </p>
      </div>,
    );
  },
);
