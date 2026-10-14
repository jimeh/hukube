import { create } from "zustand";
import { holdsSession, useExecSessions } from "../exec/sessions.ts";
export interface UnsavedEdit {
  cluster: string;
  label: string;
  read: () => string;
  pendingApply?: boolean;
}
interface Guard {
  title: string;
  description?: string;
  cancel: string;
  discard: string;
  proceed: () => void;
}
interface UnsavedEdits {
  entries: ReadonlyMap<string, UnsavedEdit>;
  guard?: Guard;
  set: (id: string, edit?: UnsavedEdit) => void;
  confirm: (guard: Guard) => void;
  dismiss: () => void;
}
export const useUnsavedEdits = create<UnsavedEdits>((set) => ({
  entries: new Map(),
  set: (id, edit) =>
    set((state) => {
      const entries = new Map(state.entries);
      if (edit) entries.set(id, edit);
      else entries.delete(id);
      return { entries };
    }),
  confirm: (guard) => set({ guard }),
  dismiss: () => set({ guard: undefined }),
}));
export const pendingApplyDescription =
  "An apply of these edits may already have reached the Cluster. Discarding stops hukube from checking the result.";
const sessionCloseDescription =
  "Its shell is told to exit. A command still running in the container may keep running.";

export function guardPanel(id: string, proceed: () => void): void {
  const store = useUnsavedEdits.getState();
  const session = id.startsWith("exec:")
    ? useExecSessions.getState().entries.get(id.slice(5))
    : undefined;
  if (session && holdsSession(session)) {
    store.confirm({
      title: `End the Exec Session in ${session.params.container} of ${session.params.pod}?`,
      description: sessionCloseDescription,
      cancel: "Keep session",
      discard: "End session",
      proceed,
    });
    return;
  }
  const edit = store.entries.get(id);
  if (!edit) {
    proceed();
    return;
  }
  store.confirm({
    title: `Discard your edits to ${edit.label}?`,
    description: edit.pendingApply ? pendingApplyDescription : undefined,
    cancel: "Keep editing",
    discard: "Discard edits",
    proceed,
  });
}
export function guardWorkspace(cluster: string, proceed: () => void): void {
  const store = useUnsavedEdits.getState();
  const edits = [...store.entries.values()].filter((edit) => edit.cluster === cluster);
  const count = edits.length;
  if (!count) {
    proceed();
    return;
  }
  store.confirm({
    title: `Discard unsaved edits in ${cluster}?`,
    description: [
      count === 1 ? "1 Resource has unsaved edits." : `${count} Resources have unsaved edits.`,
      edits.some((edit) => edit.pendingApply) ? pendingApplyDescription : "",
    ]
      .filter(Boolean)
      .join(" "),
    cancel: "Cancel",
    discard: "Discard and close",
    proceed,
  });
}
