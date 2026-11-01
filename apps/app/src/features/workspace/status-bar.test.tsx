// @vitest-environment jsdom
import type { ClusterStatus } from "@hukube/engine-client";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { StatusBar } from "./status-bar.tsx";
import { WorkspaceContext } from "./workspace-context.tsx";

vi.mock("@hukube/engine-client/react", () => ({ useConnectionState: () => "open" }));

afterEach(cleanup);

it.each([
  {
    status: {
      phase: "failed",
      message: "discovery: unknown",
      error: { code: "forbidden", reason: "Forbidden", message: "unknown" },
    },
    text: "Not permitted to access the Cluster: Forbidden",
  },
  {
    status: {
      phase: "failed",
      message: "server version: connection refused",
      error: { code: "unavailable", message: "connection refused" },
    },
    text: "Cluster unavailable: server version: connection refused",
  },
] satisfies { status: ClusterStatus; text: string }[])(
  "labels the Cluster fault as $text",
  ({ status, text }) => {
    render(
      <WorkspaceContext value={{ cluster: "fault", status } as never}>
        <StatusBar />
      </WorkspaceContext>,
    );
    expect(screen.getByText(text)).toBeDefined();
  },
);
