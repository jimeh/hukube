import jsep from "jsep";
export const vocabulary = {
  platform: ["mac", "windows", "linux"],
  host: ["web", "desktop"],
  route: ["clusters", "workspace", "settings"],
  workspace: [false, true],
  focus: ["input", "editor", "log", "terminal", "other"],
  tabKind: ["none", "list", "resource", "exec"],
  facet: ["none", "overview", "form", "yaml", "logs", "events", "related", "history"],
  terminalLive: [false, true],
  terminalSelection: [false, true],
  manifestDirty: [false, true],
  engineConnected: [false, true],
  modalOpen: [false, true],
  paletteOpen: [false, true],
  recording: [false, true],
} as const;
export type Context = { [K in keyof typeof vocabulary]: (typeof vocabulary)[K][number] };
export interface Condition {
  test(context: Context): boolean;
  keys: Set<keyof Context>;
}
/** Bound parser recursion before calling jsep; quotes do not contribute nesting. */
function preflight(text: string) {
  if (new TextEncoder().encode(text).length > 1024) throw Error("Condition exceeds 1 KiB");
  let quote = "",
    depth = 0,
    unary = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = "";
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      unary = 0;
      continue;
    }
    if (c === "(") {
      depth++;
      unary = 0;
    } else if (c === ")") {
      depth--;
      unary = 0;
    } else if (c === "!" && text[i + 1] !== "=") unary++;
    else if (!/\s/.test(c)) unary = 0;
    if (depth + unary > 32) throw Error("Condition nesting exceeds 32");
  }
}
export function compileCondition(text: string): Condition {
  preflight(text);
  if (!text.trim()) return { test: () => true, keys: new Set() };
  const ast = jsep(text),
    keys = new Set<keyof Context>();
  let count = 0;
  const stack = [{ node: ast, depth: 1 }];
  while (stack.length) {
    const { node, depth } = stack.pop()!;
    if (++count > 256 || depth > 32) throw Error("Condition is too complex");
    const child = (n: jsep.Expression) => stack.push({ node: n, depth: depth + 1 });
    if (node.type === "Identifier") {
      const name = (node as jsep.Identifier).name;
      if (!Object.hasOwn(vocabulary, name)) throw Error(`Unknown context: ${name}`);
      keys.add(name as keyof Context);
    } else if (node.type === "Literal") {
      const value = (node as jsep.Literal).value;
      if (typeof value !== "string" && typeof value !== "boolean")
        throw Error("Use quoted strings or booleans");
    } else if (node.type === "UnaryExpression" && (node as jsep.UnaryExpression).operator === "!")
      child((node as jsep.UnaryExpression).argument);
    else if (
      node.type === "BinaryExpression" &&
      ["&&", "||", "==", "!="].includes((node as jsep.BinaryExpression).operator)
    ) {
      const n = node as jsep.BinaryExpression;
      child(n.left);
      child(n.right);
      if (n.operator === "==" || n.operator === "!=") {
        if (n.left.type !== "Identifier" || n.right.type !== "Literal")
          throw Error("Compare a context key to a quoted string or boolean");
        const values = vocabulary[(n.left as jsep.Identifier).name as keyof Context] as
          | readonly unknown[]
          | undefined;
        if (!values?.includes((n.right as jsep.Literal).value))
          throw Error("Wrong context value type or unknown value");
      }
    } else throw Error(`Unsupported condition syntax: ${node.type}`);
  }
  const evaluate = (node: jsep.Expression, context: Context): string | boolean => {
    if (node.type === "Identifier") {
      const name = (node as jsep.Identifier).name as keyof Context;
      return context[name];
    }
    if (node.type === "Literal") return (node as jsep.Literal).value as string | boolean;
    if (node.type === "UnaryExpression") {
      const v = evaluate((node as jsep.UnaryExpression).argument, context);
      if (typeof v !== "boolean") throw Error("Boolean expression required");
      return !v;
    }
    const n = node as jsep.BinaryExpression,
      a = evaluate(n.left, context),
      b = evaluate(n.right, context);
    if (n.operator === "==") return a === b;
    if (n.operator === "!=") return a !== b;
    if (typeof a !== "boolean" || typeof b !== "boolean")
      throw Error("Boolean expression required");
    return n.operator === "&&" ? a && b : a || b;
  };
  const sample = Object.fromEntries(
    Object.entries(vocabulary).map(([k, v]) => [k, v[0]]),
  ) as Context;
  if (typeof evaluate(ast, sample) !== "boolean") throw Error("Boolean condition required");
  return { test: (c) => evaluate(ast, c) === true, keys };
}
/** Exhaustive small truth space, otherwise conservatively overlapping. */
export function disjoint(a: Condition, b: Condition): boolean {
  const keys = [...new Set([...a.keys, ...b.keys])];
  if (keys.reduce((n, k) => n * vocabulary[k].length, 1) > 4096) return false;
  const sample = Object.fromEntries(
    Object.entries(vocabulary).map(([k, v]) => [k, v[0]]),
  ) as Context;
  const overlaps = (i: number): boolean => {
    if (i === keys.length) return a.test(sample) && b.test(sample);
    const key = keys[i]!;
    return vocabulary[key].some((value) => {
      Object.assign(sample, { [key]: value });
      return overlaps(i + 1);
    });
  };
  return !overlaps(0);
}
