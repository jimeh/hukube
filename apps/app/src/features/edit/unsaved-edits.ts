import { create } from "zustand";
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

export function guardResource(id: string, proceed: () => void): void {
  const store = useUnsavedEdits.getState();
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
export function guardCluster(cluster: string, proceed: () => void): void {
  const store = useUnsavedEdits.getState();
  const edits = [...store.entries.values()].filter((edit) => edit.cluster === cluster);
  const count = edits.length;
  if (!count) {
    proceed();
    return;
  }
  store.confirm({
    title: `Discard unsaved edits in ${cluster}?`,
    description:
      (count === 1 ? "1 Resource has unsaved edits." : `${count} Resources have unsaved edits.`) +
      (edits.some((edit) => edit.pendingApply) ? ` ${pendingApplyDescription}` : ""),
    cancel: "Cancel",
    discard: "Discard and close",
    proceed,
  });
}
