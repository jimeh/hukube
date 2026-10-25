import { expect, it, vi } from "vitest";
import { Updates, updateMenu, updateError, type UpdateFeedback } from "./updates.ts";
import { Quit } from "./quit.ts";

function fixture() {
  const feedback = {
    changed: vi.fn<UpdateFeedback["changed"]>(),
    current: vi.fn<UpdateFeedback["current"]>(),
    error: vi.fn<UpdateFeedback["error"]>(),
    ready: vi.fn<UpdateFeedback["ready"]>(),
    restart: vi.fn<UpdateFeedback["restart"]>(),
  } satisfies UpdateFeedback;
  const port = {
    check: vi.fn<() => Promise<{ version: string } | undefined>>(),
    download: vi.fn<() => Promise<void>>(),
    install: vi.fn<() => void>(),
  };
  return { feedback, port, updates: new Updates(port, feedback) };
}

it("reports current and error results only for manual checks and permits recovery", async () => {
  const { updates, feedback, port } = fixture();
  port.check.mockRejectedValueOnce(new Error("offline"));
  await updates.check();
  expect(updates.state).toEqual({ phase: "error", message: "offline" });
  expect(feedback.error).not.toHaveBeenCalled();
  port.check.mockRejectedValueOnce(new Error("bad metadata"));
  await updates.check(true);
  expect(feedback.error).toHaveBeenCalledWith("bad metadata");
  port.check.mockResolvedValue(undefined);
  await updates.check(true);
  expect(feedback.current).toHaveBeenCalledOnce();
  expect(updates.state.phase).toBe("current");
});

it("serializes checks and downloads, reports progress, and retains ready state after cancellation", async () => {
  const { updates, feedback, port } = fixture();
  let finish!: () => void;
  port.check.mockResolvedValue({ version: "0.2.0" });
  port.download.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const checking = updates.check(true);
  await vi.waitFor(() => expect(port.download).toHaveBeenCalledOnce());
  await updates.check(true);
  expect(port.check).toHaveBeenCalledOnce();
  updates.progress(34.8);
  expect(updateMenu(updates.state)).toEqual({ label: "Downloading 0.2.0 (35%)…", enabled: false });
  finish();
  await checking;
  updates.restart();
  expect(feedback.restart).toHaveBeenCalledOnce();
  expect(updates.state).toEqual({ phase: "ready", version: "0.2.0" });
  await updates.check(true);
  expect(port.check).toHaveBeenCalledOnce();
  updates.install();
  expect(port.install).toHaveBeenCalledOnce();
});

it("recovers from interrupted, integrity, and installer failures", async () => {
  for (const error of ["cancelled", "sha512 mismatch", "permission denied"]) {
    const { updates, feedback, port } = fixture();
    port.check.mockResolvedValue({ version: "0.2.0" });
    port.download.mockRejectedValueOnce(new Error(error));
    await updates.check(true);
    expect(updates.state).toEqual({ phase: "error", message: error });
    expect(feedback.ready).not.toHaveBeenCalled();
    await updates.check();
    expect(updates.state.phase).toBe("ready");
    port.install.mockImplementation(() => {
      throw new Error(error);
    });
    updates.install();
    expect(updates.state).toEqual({ phase: "error", message: error });
  }
});

it("never contacts a feed for unavailable installations", async () => {
  const { port, feedback } = fixture();
  const updates = new Updates(port, feedback, "Use a writable AppImage.");
  await updates.check();
  await updates.check(true);
  expect(port.check).not.toHaveBeenCalled();
  expect(feedback.error).toHaveBeenCalledWith("Use a writable AppImage.");
});

it("waits for every window before installing or stopping the Engine and permits a cancelled retry", async () => {
  const quitApp = vi.fn<() => void>();
  const installed = Promise.withResolvers<void>();
  const install = vi.fn<() => void>(() => installed.resolve());
  const quit = new Quit(quitApp, install);
  quit.restart();
  // beforeunload can cancel without reaching will-quit.
  quit.cancelled();
  expect(install).not.toHaveBeenCalled();
  expect(quit.restarting).toBe(false);
  quit.restart();
  expect(quitApp).toHaveBeenCalledTimes(2);
  expect(quit.willQuit()).toBe(false);
  expect(install).not.toHaveBeenCalled();
  await installed.promise;
  expect(install).toHaveBeenCalledOnce();
  // Installer's later quit may now stop the Engine.
  expect(quit.willQuit()).toBe(true);
  quit.failed();
  expect(quit.willQuit()).toBe(true);
});

it("explains unavailable installations without promising a retry, while transient errors keep recovery guidance", () => {
  const reason = "Automatic updates are disabled in snapshot packages. Install a release.";
  expect(updateError({ phase: "unavailable", reason }, reason)).toEqual({
    message: "Updates unavailable",
    detail: reason,
  });
  expect(updateError({ phase: "error", message: "offline" }, "offline").detail).toContain(
    "try Check for Updates again",
  );
});
