/**
 * The value of the picker's "All namespaces" row. Namespace names are DNS-1123
 * labels, so no Namespace can take it.
 */
export const allNamespacesItem = "*";

function sortedUnique(names: Iterable<string>): string[] {
  return [...new Set(names)].toSorted();
}

/**
 * The Namespaces a list's Tab params choose, sorted. Restored params are
 * untrusted, so anything but non-empty strings reads as no choice, and an
 * empty selection is All namespaces.
 */
export function readNamespaces(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return sortedUnique(value.filter((name): name is string => typeof name === "string" && !!name));
}

/**
 * Maps the picker's new value back to a selection. While nothing is chosen
 * the value holds the "All namespaces" row, so checking a name adds it to
 * that row, and checking the row while names are chosen clears them.
 */
export function nextSelection(current: readonly string[], value: readonly string[]): string[] {
  if (current.length > 0 && value.includes(allNamespacesItem)) return [];
  return sortedUnique(value.filter((name) => name !== allNamespacesItem));
}

/**
 * The picker's rows: "All namespaces" unless filtering, then the Namespaces
 * chosen when the popup opened (`pinned`), then the rest by name. A row does
 * not move when it is checked while the popup is open. A chosen Namespace
 * missing from `names`, such as a deleted one or one past the loaded names,
 * is listed with the pinned ones.
 */
export function pickerRows({
  names,
  pinned,
  chosen,
  filtering,
}: {
  names: readonly string[];
  pinned: readonly string[];
  chosen: readonly string[];
  filtering: boolean;
}): string[] {
  const listed = new Set(names);
  const first = sortedUnique([...pinned, ...chosen.filter((name) => !listed.has(name))]);
  const firstSet = new Set(first);
  return [
    ...(filtering ? [] : [allNamespacesItem]),
    ...first,
    ...names.filter((name) => !firstSet.has(name)),
  ];
}

/**
 * The chosen Namespaces the Cluster no longer has. Only a complete list of a
 * ready Namespace type can say so (`known`); otherwise none is marked.
 */
export function missingNamespaces(
  chosen: readonly string[],
  names: readonly string[] | undefined,
  known: boolean,
): Set<string> {
  if (!names || !known) return new Set();
  const listed = new Set(names);
  return new Set(chosen.filter((name) => !listed.has(name)));
}

export interface NamespaceLabel {
  /** The first chosen Namespace, absent for All namespaces. */
  name: string | undefined;
  /** The visible count of the other chosen Namespaces, such as "+2". */
  more: string | undefined;
  /** The count as read aloud in place of `more`, such as "and 2 more". */
  moreText: string | undefined;
  /** The label as read aloud, such as "shop and 2 more". */
  text: string;
}

/** The picker's trigger label for a sorted selection. */
export function namespaceLabel(selection: readonly string[], locale?: string): NamespaceLabel {
  const [name] = selection;
  if (name === undefined)
    return { name: undefined, more: undefined, moreText: undefined, text: "All namespaces" };
  if (selection.length === 1) return { name, more: undefined, moreText: undefined, text: name };
  const count = new Intl.NumberFormat(locale).format(selection.length - 1);
  return {
    name,
    more: `+${count}`,
    moreText: `and ${count} more`,
    text: `${name} and ${count} more`,
  };
}

export interface ListNotice {
  title: string;
  description: string;
}

/**
 * The empty state of a list with no Resources. When the Cluster has none of
 * the chosen Namespaces (`missing`), no Resource can appear until the
 * selection changes, so it says that whatever the other filters. Otherwise
 * it names the filters, or the selection that narrows the list.
 */
export function emptyListNotice({
  kind,
  chosen,
  missing,
  filtered,
  locale,
}: {
  kind: string;
  chosen: readonly string[];
  missing: ReadonlySet<string>;
  filtered: boolean;
  locale?: string;
}): ListNotice {
  const count = new Intl.NumberFormat(locale);
  if (chosen.length > 0 && chosen.every((name) => missing.has(name))) {
    return chosen.length === 1
      ? {
          title: `${chosen[0]} not found`,
          description:
            "The cluster has no namespace with this name. Choose another namespace, or show all namespaces.",
        }
      : {
          title: `${count.format(chosen.length)} chosen namespaces not found`,
          description:
            "The cluster has none of them. Choose other namespaces, or show all namespaces.",
        };
  }
  if (filtered) return { title: "No matches", description: "Nothing matches the current filters." };
  if (chosen.length === 0) {
    return {
      title: `No ${kind} resources`,
      description: "The cluster has none right now. This list updates live.",
    };
  }
  const scope = chosen.length === 1 ? chosen[0] : `${count.format(chosen.length)} namespaces`;
  return { title: `No ${kind} resources in ${scope}`, description: "This list updates live." };
}
