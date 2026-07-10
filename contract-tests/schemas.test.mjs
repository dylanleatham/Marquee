import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import Ajv from "ajv";
import addFormats from "ajv-formats";

const here = dirname(fileURLToPath(import.meta.url));
const schemaDir = join(here, "..", "packages", "contracts", "schemas");
const fixturesDir = join(here, "..", "fixtures");

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);

const loadJson = (p) => JSON.parse(readFileSync(p, "utf8"));

test("every schema is valid JSON Schema and compiles", () => {
  for (const file of readdirSync(schemaDir).filter((f) =>
    f.endsWith(".json"),
  )) {
    const schema = loadJson(join(schemaDir, file));
    assert.doesNotThrow(() => ajv.compile(schema), `${file} failed to compile`);
  }
});

test("Purple Rain reference payload validates against palette-payload schema", () => {
  const schema = loadJson(join(schemaDir, "palette-payload.schema.json"));
  const validate = ajv.compile(schema);
  const payload = loadJson(
    join(fixturesDir, "palettes", "purple-rain.payload.json"),
  );
  assert.ok(validate(payload), JSON.stringify(validate.errors, null, 2));
});

test("a malformed palette payload is rejected", () => {
  const schema = loadJson(join(schemaDir, "palette-payload.schema.json"));
  const validate = ajv.compile(schema);
  // lowercase hex violates the "^#[0-9A-F]{6}$" pattern
  const bad = {
    version: 1,
    source: { type: "album" },
    palette: { colors: [{ hex: "#4b0082", role: "primary" }] },
    pattern: { type: "static", params: {} },
  };
  assert.equal(validate(bad), false);
});
