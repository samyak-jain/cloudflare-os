import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { WORKSHOP_AGENT_TOOL_DEFINITIONS } from
  "../packages/workshop-backend/src/agent-tool-definitions.ts";

type JsonValue = null | boolean | number | string | JsonValue[] | {[key: string]: JsonValue};

function canonicalize(value: JsonValue): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).toSorted().map((key) =>
      `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

let outputDirectory = process.argv[2];
if (!outputDirectory) {
  throw new Error("usage: node scripts/export-workshop-tool-schemas.ts <output-directory>");
}

let tools = Object.values(WORKSHOP_AGENT_TOOL_DEFINITIONS)
  .map(({name, description, parameters}) => ({name, description, parameters}))
  .toSorted((left, right) => left.name.localeCompare(right.name)) as unknown as JsonValue[];

let resolvedOutputDirectory = resolve(outputDirectory);
mkdirSync(resolvedOutputDirectory, {recursive: true});

let entries = tools.map((tool) => {
  let name = (tool as {name: string}).name;
  let file = `${name}.json`;
  let canonical = canonicalize(tool);
  writeFileSync(resolve(resolvedOutputDirectory, file), `${JSON.stringify(tool, null, 2)}\n`);
  return {name, file, sha256: sha256(canonical)};
});

let catalogCanonical = canonicalize(tools);
let index = {
  algorithm: "sha256",
  digest: sha256(catalogCanonical),
  canonicalization: "JSON object keys sorted recursively; tools sorted by name",
  tools: entries,
};
writeFileSync(resolve(resolvedOutputDirectory, "index.json"), `${JSON.stringify(index, null, 2)}\n`);

console.log(index.digest);
