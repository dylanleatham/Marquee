#!/usr/bin/env node
// Generate TypeScript types from packages/contracts/schemas/*.json.
// Wired as `pnpm --filter @marquee/contracts gen`.
//
// TODO(build order step 0): implement using json-schema-to-typescript:
//   import { compileFromFile } from "json-schema-to-typescript";
//   for each schema -> write packages/contracts/src/generated/<name>.ts
// Then export the generated types from packages/contracts/src/index.ts.
//
// Python models for Stylus can be generated separately (datamodel-code-generator),
// or Stylus can just validate against the raw .json with jsonschema (simpler; recommended).
console.log("gen-schemas: not implemented yet — see comments in this file.");
