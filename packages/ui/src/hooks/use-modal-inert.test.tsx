// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { useModalCount, useModalInert } from "./use-modal-inert.ts";
afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});
function Modal({ open }: { open: boolean }) {
  useModalInert(open);
  return null;
}
function Count() {
  return <output>{useModalCount()}</output>;
}
const content = (a: boolean, b: boolean) => (
  <>
    <Modal open={a} />
    <Modal open={b} />
    <Count />
  </>
);
it.each([false, true])(
  "subscribes to nested modal count and restores original inert=%s",
  (original) => {
    const root = document.createElement("div");
    root.id = "root";
    root.inert = original;
    document.body.append(root);
    const view = render(content(true, true), { container: root });
    expect(root.inert).toBe(true);
    expect(root.querySelector("output")?.textContent).toBe("2");
    view.rerender(content(false, true));
    expect(root.inert).toBe(true);
    expect(root.querySelector("output")?.textContent).toBe("1");
    view.rerender(content(false, false));
    expect(root.inert).toBe(original);
    expect(root.querySelector("output")?.textContent).toBe("0");
  },
);
