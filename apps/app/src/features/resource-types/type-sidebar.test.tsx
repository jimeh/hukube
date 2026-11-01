// @vitest-environment jsdom
import type { ClusterStatus } from "@hukube/engine-client";
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";

import { WorkspaceContext } from "@/features/workspace/workspace-context.tsx";

import { TypeSidebar } from "./type-sidebar.tsx";

vi.mock("@hukube/ui/components/scroll-area", () => ({
  ScrollArea: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("@hukube/ui/components/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ render: trigger }: { render: ReactNode }) => <>{trigger}</>,
  TooltipContent: () => null,
}));

afterEach(cleanup);

function show(status: ClusterStatus) {
  render(
    <WorkspaceContext
      value={{ cluster: "fault", status, types: new Map(), openList: () => {} } as never}
    >
      <TypeSidebar />
    </WorkspaceContext>,
  );
}

it.each([
  {
    status: {
      phase: "failed",
      message: "discovery: unknown",
      error: { code: "forbidden", reason: "Forbidden", message: "unknown" },
    },
    title: "Not permitted",
    description: "Your Kubernetes credentials cannot discover Resource Types for this Cluster.",
  },
  {
    status: {
      phase: "failed",
      message: "server version: connection refused",
      error: { code: "unavailable", message: "connection refused" },
    },
    title: "Cluster unavailable",
    description:
      "hukube could not discover Resource Types because it could not reach this Cluster.",
  },
] satisfies { status: ClusterStatus; title: string; description: string }[])(
  "shows $title instead of healthy empty copy",
  ({ status, title, description }) => {
    show(status);
    expect(screen.getByText(title)).toBeDefined();
    expect(screen.getByText(description)).toBeDefined();
    expect(screen.queryByText("No resource types match.")).toBeNull();
  },
);

it("keeps the empty copy for a healthy Cluster", () => {
  show({ phase: "ready", serverVersion: "v1.31.0" });
  expect(screen.getByText("No resource types match.")).toBeDefined();
});
