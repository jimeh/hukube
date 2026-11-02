export interface LogFilter {
  include: string;
  exclude: string;
  matchCase: boolean;
}

export const emptyLogFilter: LogFilter = { include: "", exclude: "", matchCase: false };

export function sameLogFilter(a: LogFilter, b: LogFilter): boolean {
  return a.include === b.include && a.exclude === b.exclude && a.matchCase === b.matchCase;
}

export function hasLogFilter(filter: LogFilter): boolean {
  return filter.include !== "" || filter.exclude !== "";
}

/** Compile the needles once. The only searchable text is the retained payload. */
export function logPredicate(filter: LogFilter): (text: string) => boolean {
  const include = filter.matchCase ? filter.include : filter.include.toLowerCase();
  const exclude = filter.matchCase ? filter.exclude : filter.exclude.toLowerCase();
  return (text) => {
    const candidate = filter.matchCase ? text : text.toLowerCase();
    return (!include || candidate.includes(include)) && (!exclude || !candidate.includes(exclude));
  };
}
