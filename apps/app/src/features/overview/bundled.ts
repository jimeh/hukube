import { parseDefinition } from "./definition.ts";
export const bundledSources = Object.fromEntries(
  Object.values(
    import.meta.glob<string>("./builtins/*.yaml", {
      query: "?raw",
      import: "default",
      eager: true,
    }),
  ).map((source) => [parseDefinition(source).resourceType, source]),
);
export const bundledDefinitions = new Map(
  Object.entries(bundledSources).map(([key, source]) => [key, parseDefinition(source)]),
);
