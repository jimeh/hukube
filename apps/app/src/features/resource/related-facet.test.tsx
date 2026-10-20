// @vitest-environment jsdom

import type { Related, RelatedRow, ResourceType } from "@hukube/engine-client";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { WorkspaceContext, type WorkspaceValue } from "../workspace/workspace-context.tsx";
import type { FacetProps } from "./facet-props.ts";
import { RelatedBadge, RelatedFacet, relatedTabName } from "./related-facet.tsx";

const createdAt = new Date(Date.now() - 10_000).toISOString();
const row: RelatedRow = {
  depth: 0,
  status: "found",
  kind: "Pod",
  type: "pods",
  namespace: "shop",
  name: "web",
  createdAt,
};
const empty: Related = { found: true, sections: [], types: [], total: 0 };
const populated: Related = {
  ...empty,
  total: 1,
  sections: [{ relationship: "owns", direction: "out", total: 1, rows: [row] }],
};
const props: FacetProps = {
  address: { cluster: "c", type: "deployments.apps", namespace: "shop", name: "web" },
  kind: "Deployment",
  manifest: { stale: false },
  events: { stale: false },
  related: { stale: false },
  panelId: "source",
  showing: true,
  controls: null,
};
const workspace: WorkspaceValue = {
  cluster: "c",
  types: new Map(),
  openResource: vi.fn<WorkspaceValue["openResource"]>(),
  openList: vi.fn<WorkspaceValue["openList"]>(),
};
function panel(
  related: FacetProps["related"],
  overrides: Partial<FacetProps> = {},
  types = workspace.types,
) {
  return (
    <WorkspaceContext value={{ ...workspace, types }}>
      <RelatedFacet {...props} {...overrides} related={related} />
    </WorkspaceContext>
  );
}
function show(
  related: FacetProps["related"],
  overrides: Partial<FacetProps> = {},
  types = workspace.types,
) {
  return render(panel(related, overrides, types));
}
afterEach(() => {
  cleanup();
  workspace.status = undefined;
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("Related states", () => {
  it.each([
    ["no value", undefined, undefined],
    ["index before Manifest", { ...empty, found: false }, undefined],
    ["index after Manifest", { ...empty, found: false }, { object: {} }],
  ] as const)(
    "shows busy heading and three two-line skeleton rows: %s",
    (_name, data, manifest) => {
      show({ stale: false, data }, { manifest: { stale: false, data: manifest } });
      expect(screen.getByRole("treegrid").getAttribute("aria-busy")).toBe("true");
      expect(screen.getAllByRole("row")).toHaveLength(4);
      expect(screen.getAllByRole("gridcell")).toHaveLength(3);
      expect(screen.getAllByRole("gridcell").every((cell) => cell.children.length === 2)).toBe(
        true,
      );
    },
  );
  it("explains no owners or owned Resources when all types can be listed", () => {
    show({ stale: false, data: empty });
    expect(screen.getByText("No owners or owned Resources")).toBeDefined();
    expect(
      screen.getByText(
        "No Resource owns this Deployment, and it owns none. Owners and owned Resources appear here as they change.",
      ),
    ).toBeDefined();
    expect(screen.queryByText(/Resources of .* your credentials cannot list/)).toBeNull();
  });
  it.each([1, 2])(
    "qualifies the empty state for %s forbidden types without a bottom line",
    (count) => {
      const types = new Map(
        Array.from({ length: count }, (_, index) => [
          String(index),
          { state: "forbidden" } as ResourceType,
        ]),
      );
      const { container } = show({ stale: false, data: empty }, {}, types);
      expect(screen.getByText("No owners or owned Resources")).toBeDefined();
      const omitted = `Resources of ${count} ${count === 1 ? "Resource Type" : "Resource Types"} your credentials cannot list are not shown.`;
      expect(
        screen.getByText(
          `No Resource that your credentials can list owns this Deployment or is owned by it. ${omitted}`,
        ),
      ).toBeDefined();
      expect(screen.queryByText(omitted, { exact: true })).toBeNull();
      expect(container.querySelector("p.px-3.py-2.text-muted-foreground")).toBeNull();
    },
  );
  it("keeps the forbidden types line under populated sections", () => {
    show(
      { stale: false, data: populated },
      {},
      new Map([["constructor", { state: "forbidden" } as ResourceType]]),
    );
    expect(
      screen.getByText("Resources of 1 Resource Type your credentials cannot list are not shown."),
    ).toBeDefined();
  });
  it.each([empty, populated])("warns about a failed Cluster above content: %j", (data) => {
    workspace.status = { phase: "failed", message: "connection refused" };
    const view = show({ stale: false, data });
    expect(
      screen.getByText("Related Resources may be out of date: connection refused"),
    ).toBeDefined();
    workspace.status = { phase: "failed" };
    view.rerender(panel({ stale: false, data }));
    expect(
      screen.getByText("Related Resources may be out of date: the Cluster cannot be reached"),
    ).toBeDefined();
    view.rerender(
      panel({ stale: true, data, error: { code: "internal", message: "topic failed" } }),
    );
    expect(screen.getAllByText(/Related Resources may be out of date:/)).toHaveLength(1);
    expect(screen.getByText("Related Resources may be out of date: topic failed")).toBeDefined();
  });
  it("keeps failed Cluster warnings out of permission and unavailable notices", () => {
    workspace.status = { phase: "failed", message: "offline" };
    const view = show({ stale: false, error: { code: "forbidden", message: "denied" } });
    expect(screen.getByText("Not permitted")).toBeDefined();
    expect(screen.queryByText(/may be out of date/)).toBeNull();
    view.rerender(panel({ stale: false, error: { code: "internal", message: "topic failed" } }));
    expect(screen.getByText("Related Resources unavailable")).toBeDefined();
    expect(screen.queryByText(/may be out of date/)).toBeNull();
  });
  it("explains a deleted or never-found Resource and follows recreation", () => {
    const view = show(
      { stale: false, data: { ...empty, found: false } },
      { manifest: { stale: false, data: { deleted: true } } },
    );
    expect(
      screen.getByText(
        "This Deployment does not exist right now. Related Resources appear here if it is created.",
      ),
    ).toBeDefined();
    view.rerender(panel({ stale: false, data: populated }));
    expect(screen.getByRole("row", { name: /Pod web/ })).toBeDefined();
    expect(screen.queryByText("Nothing related")).toBeNull();
  });
  it("replaces held rows when permission is forbidden", () => {
    show({ stale: true, data: populated, error: { code: "forbidden", message: "denied" } });
    expect(screen.getByText("Not permitted")).toBeDefined();
    expect(
      screen.getByText(
        "Your credentials cannot list deployments.apps, so hukube cannot tell what this Deployment is related to.",
      ),
    ).toBeDefined();
    expect(screen.queryByRole("row")).toBeNull();
  });
  it("explains an error before any value", () => {
    show({ stale: false, error: { code: "internal", message: "offline" } });
    expect(screen.getByText("Related Resources unavailable")).toBeDefined();
    expect(screen.getByText("offline hukube keeps trying.")).toBeDefined();
  });
  it.each([false, true])(
    "keeps held sections during failures and reconnect, then clears the error (stale: %s)",
    (stale) => {
      const view = show({
        stale,
        data: populated,
        error: { code: "internal", message: "offline" },
      });
      expect(screen.getByText("Related Resources may be out of date: offline")).toBeDefined();
      expect(screen.getByRole("row", { name: /Pod web/ })).toBeDefined();
      view.rerender(panel({ stale: true, data: populated }));
      expect(screen.queryByText(/may be out of date/)).toBeNull();
      expect(screen.getByRole("row", { name: /Pod web/ })).toBeDefined();
    },
  );
  it.each([
    ["missing", "Not found. No Pod with this name and UID exists."],
    ["unserved", "This Cluster does not serve legacy.example/v1 Pod."],
    ["forbidden", "Your credentials cannot list pods."],
    ["failed", "The Cluster cannot list pods."],
    ["syncing", "Loading pods…"],
  ] as const)("explains an unresolved %s reference", (status, reason) => {
    show({
      stale: false,
      data: {
        ...populated,
        sections: [
          {
            ...populated.sections[0]!,
            rows: [{ ...row, status, apiVersion: "legacy.example/v1" }],
          },
        ],
      },
    });
    expect(screen.getByText(reason)).toBeDefined();
    expect(screen.getByTitle(reason).textContent).toBe(reason);
  });
  it("orders owners first, marks self, limits indentation, and explains omitted rows", () => {
    const data: Related = {
      ...populated,
      total: 2902,
      sections: [
        {
          ...populated.sections[0]!,
          total: 2901,
          truncated: true,
          rows: [row, { ...row, depth: 9, status: "more", more: 2900 }],
        },
        {
          relationship: "selects",
          direction: "out",
          total: 1,
          rows: [{ ...row, name: "ignored" }],
        },
        {
          relationship: "owns",
          direction: "in",
          total: 1,
          truncated: true,
          rows: [{ ...row, status: "self", depth: 1 }],
        },
      ],
    };
    const view = show({ stale: false, data });
    expect(screen.getAllByRole("columnheader").map((element) => element.textContent)).toEqual([
      "Owned by",
      "Owns",
    ]);
    expect(screen.getByText("This Pod")).toBeDefined();
    expect(screen.getByText("Not every owner is shown.")).toBeDefined();
    expect(screen.getByText("2,900 Pod Resources are not shown.")).toBeDefined();
    expect(screen.getByText("2,901")).toBeDefined();
    expect(screen.getByRole("row", { name: /2,900/ }).style.paddingLeft).toBe("140px");
    expect(screen.getByRole("row", { name: /This Pod/ }).getAttribute("aria-level")).toBe("2");
    expect(screen.queryByText("ignored")).toBeNull();
    view.rerender(
      panel({
        stale: false,
        data: {
          ...populated,
          sections: [{ ...populated.sections[0]!, rows: [{ ...row, status: "more", more: 1 }] }],
        },
      }),
    );
    expect(screen.getByText("1 Pod Resource is not shown.")).toBeDefined();
  });
  it.each([1, 30])(
    "names %s omitted Resources only as older when siblings of that type were shown",
    (count) => {
      const more = { ...row, depth: 1, status: "more" as const, more: count };
      const data = (rows: RelatedRow[]) => ({
        ...populated,
        total: count,
        sections: [{ ...populated.sections[0]!, rows }],
      });
      const noun = count === 1 ? "Resource is" : "Resources are";
      const owner = { ...row, type: "replicasets.apps", name: "owner" };
      const view = show({ stale: false, data: data([owner, { ...row, depth: 1 }, more]) });
      expect(screen.getByText(`${count} older Pod ${noun} not shown.`)).toBeDefined();
      // Another owner's same-type child, a deeper child, a different type, and an unresolved sibling do not qualify.
      view.rerender(
        panel({
          stale: false,
          data: data([
            owner,
            { ...row, depth: 1 },
            { ...owner, name: "other" },
            { ...row, depth: 2 },
            { ...row, depth: 1, type: "jobs.batch" },
            { ...row, depth: 1, status: "missing" },
            more,
          ]),
        }),
      );
      expect(screen.getByText(`${count} Pod ${noun} not shown.`)).toBeDefined();
    },
  );
  it("renders hostile type keys, names, and columns as text, skipping cells without values", () => {
    const hostile = "<script>text</script>";
    const data: Related = {
      ...populated,
      types: [
        {
          type: "__proto__",
          columns: ["constructor", "toString", "Name", "empty", "none", "missing", "null"].map(
            (name) => ({ name, type: "string", priority: 0 }),
          ),
        },
      ],
      sections: [
        {
          ...populated.sections[0]!,
          rows: [
            {
              ...row,
              type: "__proto__",
              kind: "constructor",
              name: hostile,
              namespace: "other",
              cells: [0, false, hostile, "", "<none>", undefined, null],
            },
          ],
        },
      ],
    };
    vi.useFakeTimers();
    vi.setSystemTime(new Date(createdAt).getTime() + 10_000);
    const { container } = show({ stale: false, data });
    expect(screen.getByTitle(hostile).textContent).toBe(hostile);
    const line = screen.getByTitle(/other · .* · constructor 0 · toString false · Name/);
    expect(line.textContent).toMatch(
      /^other · \d+s · constructor 0 · toString false · Name <script>text<\/script>$/,
    );
    expect(line.classList.contains("truncate")).toBe(true);
    expect(line.classList.contains("text-muted-foreground")).toBe(true);
    for (const [label, value] of [
      ["constructor", "0"],
      ["toString", "false"],
      ["Name", hostile],
    ]) {
      const valueElement = [...line.querySelectorAll(".text-foreground")].find(
        (element) => element.textContent === value,
      )!;
      expect(valueElement).toBeDefined();
      expect(valueElement.previousElementSibling?.textContent).toBe(label);
      expect(valueElement.previousElementSibling?.classList.contains("text-foreground")).toBe(
        false,
      );
    }
    expect(
      screen.getByRole("row", {
        name: `constructor ${hostile} ${line.textContent}`,
      }),
    ).toBeDefined();
    expect(container.querySelector("script")).toBeNull();
  });
  it("advances the age of retained rows with the shared clock", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(createdAt).getTime() + 10_000);
    show({ stale: true, data: populated });
    await act(async () => vi.advanceTimersByTime(1000));
    expect(screen.getByTitle("11s").textContent).toBe("11s");
    await act(async () => vi.advanceTimersByTime(10_000));
    expect(screen.getByTitle("21s").textContent).toBe("21s");
  });
});

describe("Related badge", () => {
  it.each([
    [1, "1", "Related, 1 Resource"],
    [12, "12", "Related, 12 Resources"],
    [1234, "999+", "Related, 1234 Resources"],
  ] as const)(
    "names and caps the full total %s, including during an error",
    (total, text, name) => {
      const related: FacetProps["related"] = {
        stale: true,
        data: { ...populated, total: total },
        error: { code: "internal", message: "offline" },
      };
      render(
        <button aria-label={relatedTabName({ ...props, related })}>
          <RelatedBadge {...props} related={related} />
        </button>,
      );
      expect(screen.getByRole("button", { name: name })).toBeDefined();
      expect(screen.getByText(text).getAttribute("aria-hidden")).toBe("true");
    },
  );
  it.each([
    { stale: false },
    { stale: false, data: { ...populated, found: false } },
    { stale: false, data: empty },
    { stale: false, data: populated, error: { code: "forbidden" as const, message: "denied" } },
  ])("hides the count when unavailable, not found, empty, or forbidden: %j", (related) => {
    const { container } = render(<RelatedBadge {...props} related={related} />);
    expect(container.childElementCount).toBe(0);
    expect(relatedTabName({ ...props, related })).toBe("Related");
  });
});

const reference = (kind: string, uid: string): RelatedRow[] => [
  {
    depth: 0,
    status: "unserved",
    kind,
    apiVersion: "legacy.example.com/v1",
    name: "shared",
    uid,
  },
  { ...row, depth: 1, status: "self" },
];
const owners = (rows: RelatedRow[]) =>
  panel({
    stale: false,
    data: {
      ...populated,
      sections: [{ relationship: "owns", direction: "in", total: 2, rows }],
    },
  });
describe("Related navigation", () => {
  it("opens click, Enter, and Space in the source Pane, and leaves a burst's further clicks alone", () => {
    show({ stale: false, data: populated });
    const resource = screen.getByRole("row", { name: /Pod web/ });
    const expected = { type: "pods", namespace: "shop", name: "web" };
    fireEvent.click(resource, { detail: 1 });
    expect(workspace.openResource).toHaveBeenLastCalledWith(expected, {
      preview: true,
      pane: "source",
    });
    // The Resource tab handles the second click of a double-click, wherever it lands.
    fireEvent.click(resource, { detail: 2 });
    fireEvent.click(resource, { detail: 3 });
    expect(workspace.openResource).toHaveBeenCalledTimes(1);
    const grid = screen.getByRole("treegrid");
    fireEvent.keyDown(grid, { key: "Enter" });
    expect(workspace.openResource).toHaveBeenLastCalledWith(expected, {
      preview: false,
      pane: "source",
    });
    fireEvent.keyDown(grid, { key: " " });
    expect(workspace.openResource).toHaveBeenLastCalledWith(expected, {
      preview: true,
      pane: "source",
    });
    expect(workspace.openResource).toHaveBeenCalledTimes(3);
    expect(grid.tabIndex).toBe(0);
  });
  it.each(["click", "double-click", "Enter", " "])(
    "focuses only the newly mounted Related Facet at the opened address: %s",
    (action) => {
      show({ stale: false, data: populated });
      if (action === "click" || action === "double-click") {
        fireEvent.click(screen.getByRole("row", { name: /Pod web/ }), { detail: 1 });
        if (action === "double-click")
          fireEvent.click(screen.getByRole("row", { name: /Pod web/ }), { detail: 2 });
      } else {
        fireEvent.keyDown(screen.getByRole("treegrid"), { key: "ArrowDown" });
        fireEvent.keyDown(screen.getByRole("treegrid"), { key: action });
      }
      cleanup();
      const opened = { cluster: "c", type: "pods", namespace: "shop", name: "web" };
      for (const difference of [
        { cluster: "other" },
        { type: "other" },
        { namespace: "other" },
        { name: "other" },
      ]) {
        show({ stale: false, data: populated }, { address: { ...opened, ...difference } });
        expect(document.activeElement).not.toBe(screen.getByRole("treegrid"));
        cleanup();
      }
      const focus = vi.spyOn(HTMLElement.prototype, "focus");
      show({ stale: false, data: populated }, { address: opened });
      expect(document.activeElement).toBe(screen.getByRole("treegrid"));
      expect(focus).toHaveBeenCalledWith({ preventScroll: true });
      expect(screen.getByRole("treegrid").getAttribute("aria-activedescendant")).toBeNull();
      expect(screen.getByRole("row", { name: /Pod web/ }).getAttribute("aria-selected")).toBe(
        "false",
      );
      focus.mockRestore();
      cleanup();
      show({ stale: false, data: populated }, { address: opened });
      expect(document.activeElement).not.toBe(screen.getByRole("treegrid"));
    },
  );
  it("leaves focus alone when the opened Resource's Facet mounts long after the row was used", () => {
    vi.useFakeTimers();
    show({ stale: false, data: populated });
    fireEvent.click(screen.getByRole("row", { name: /Pod web/ }), { detail: 1 });
    cleanup();
    // A tab that was already open mounts nothing, so the record must not wait for a later one.
    vi.advanceTimersByTime(2000);
    show(
      { stale: false, data: populated },
      { address: { cluster: "c", type: "pods", namespace: "shop", name: "web" } },
    );
    expect(document.activeElement).not.toBe(screen.getByRole("treegrid"));
  });
  it("keeps two references with one name apart, and drops one that leaves", () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const view = render(owners([...reference("Gadget", "1"), ...reference("Widget", "2")]));
    expect(screen.getAllByRole("row", { name: /shared/ })).toHaveLength(2);
    view.rerender(owners(reference("Widget", "2")));
    expect(screen.queryByRole("row", { name: /^Gadget shared/ })).toBeNull();
    expect(screen.getAllByRole("row", { name: /shared/ })).toHaveLength(1);
    // Two incarnations of one owner differ only by UID.
    view.rerender(owners([...reference("Widget", "2"), ...reference("Widget", "3")]));
    expect(screen.getAllByRole("row", { name: /^Widget shared/ })).toHaveLength(2);
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });
  it("skips non-openable rows with arrows and ignores their pointer actions", () => {
    const rows: RelatedRow[] = [
      "self",
      "missing",
      "unserved",
      "forbidden",
      "failed",
      "syncing",
      "more",
    ].map((status, i) => ({
      ...row,
      name: `closed-${i}`,
      status: status as RelatedRow["status"],
      more: 1,
    }));
    show({
      stale: false,
      data: {
        ...populated,
        sections: [{ ...populated.sections[0]!, rows: [...rows, row, { ...row, name: "second" }] }],
      },
    });
    for (const resource of screen.getAllByRole("row").slice(1, 8)) {
      fireEvent.click(resource, { detail: 1 });
      fireEvent.click(resource, { detail: 2 });
    }
    expect(workspace.openResource).not.toHaveBeenCalled();
    const grid = screen.getByRole("treegrid");
    fireEvent.keyDown(grid, { key: "ArrowDown" });
    expect(screen.getByRole("row", { name: /Pod web/ }).getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(grid, { key: "ArrowDown" });
    expect(screen.getByRole("row", { name: /Pod second/ }).getAttribute("aria-selected")).toBe(
      "true",
    );
    fireEvent.keyDown(grid, { key: "ArrowUp" });
    expect(screen.getByRole("row", { name: /Pod web/ }).getAttribute("aria-selected")).toBe("true");
    expect(grid.getAttribute("aria-activedescendant")).toBe(
      screen.getByRole("row", { name: /Pod web/ }).id,
    );
  });
  it("keeps keyboard selection below its sticky section heading", () => {
    show({ stale: false, data: populated });
    const grid = screen.getByRole("treegrid");
    const resource = screen.getByRole("row", { name: /Pod web/ });
    const heading = screen.getByRole("columnheader", { name: "Owns" }).parentElement!;
    grid.getBoundingClientRect = () => ({ top: 100, bottom: 200 }) as DOMRect;
    resource.getBoundingClientRect = () => ({ top: 100, bottom: 148 }) as DOMRect;
    heading.getBoundingClientRect = () => ({ height: 28 }) as DOMRect;
    grid.scrollTop = 50;
    fireEvent.keyDown(grid, { key: "ArrowDown" });
    expect(grid.scrollTop).toBe(22);
    expect(resource.getAttribute("aria-selected")).toBe("true");
  });
  it("retains selection when rows arrive above it and clears it when its path leaves", () => {
    const view = show({ stale: false, data: populated });
    const grid = screen.getByRole("treegrid");
    fireEvent.keyDown(grid, { key: "ArrowDown" });
    const changed = (rows: RelatedRow[]) =>
      panel({
        stale: false,
        data: { ...populated, sections: [{ ...populated.sections[0]!, rows }] },
      });
    view.rerender(changed([{ ...row, name: "new" }, row]));
    expect(screen.getByRole("row", { name: /Pod web/ }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("row", { name: /Pod new/ }).getAttribute("aria-selected")).toBe(
      "false",
    );
    view.rerender(changed([{ ...row, name: "new" }]));
    expect(screen.getByRole("row", { name: /Pod new/ }).getAttribute("aria-selected")).toBe(
      "false",
    );
    fireEvent.keyDown(grid, { key: "Enter" });
    expect(workspace.openResource).not.toHaveBeenCalled();
  });
  it("selects one path when the same Resource appears under two owners", () => {
    const rows = [
      { ...row, name: "owner-a" },
      { ...row, depth: 1 },
      { ...row, name: "owner-b" },
      { ...row, depth: 1 },
    ];
    show({ stale: false, data: { ...populated, sections: [{ ...populated.sections[0]!, rows }] } });
    const duplicates = screen.getAllByRole("row", { name: /Pod web/ });
    fireEvent.click(duplicates[1]!);
    expect(duplicates.map((element) => element.getAttribute("aria-selected"))).toEqual([
      "false",
      "true",
    ]);
  });
});
