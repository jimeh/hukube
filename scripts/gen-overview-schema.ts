import { definitionJsonSchema } from "../apps/app/src/features/overview/definition.ts";
await Bun.write(
  new URL("../docs/overview/definition.schema.json", import.meta.url),
  JSON.stringify(definitionJsonSchema(), null, 2) + "\n",
);
