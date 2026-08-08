import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { CURATOR_URI_KINDS } from "@marquee/contracts";

const here = dirname(fileURLToPath(import.meta.url));
const schemaDir = join(here, "..", "packages", "contracts", "schemas");
const fixturesDir = join(here, "..", "fixtures");

const loadJson = (p) => JSON.parse(readFileSync(p, "utf8"));

// Register every schema once, keyed by its $id. Lets cross-schema $refs resolve
// and avoids "schema already exists" from compiling the same $id twice.
const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);

const schemaFiles = readdirSync(schemaDir).filter((f) => f.endsWith(".json"));
for (const file of schemaFiles) ajv.addSchema(loadJson(join(schemaDir, file)));

const PALETTE_ID = "marquee/schemas/palette-payload-v1.json";
const SCAN_ID = "marquee/schemas/scan-event-v1.json";

test("every schema is valid JSON Schema and compiles", () => {
  for (const file of schemaFiles) {
    const { $id } = loadJson(join(schemaDir, file));
    assert.doesNotThrow(() => ajv.getSchema($id), `${file} failed to compile`);
    assert.ok(ajv.getSchema($id), `${file} produced no validator`);
  }
});

test("Purple Rain reference payload validates against palette-payload schema", () => {
  const validate = ajv.getSchema(PALETTE_ID);
  const payload = loadJson(
    join(fixturesDir, "palettes", "purple-rain.payload.json"),
  );
  assert.ok(validate(payload), JSON.stringify(validate.errors, null, 2));
});

test("a malformed palette payload is rejected", () => {
  const validate = ajv.getSchema(PALETTE_ID);
  // lowercase hex violates the "^#[0-9A-F]{6}$" pattern
  const bad = {
    version: 1,
    source: { type: "album" },
    palette: { colors: [{ hex: "#4b0082", role: "primary" }] },
    pattern: { type: "static", params: {} },
  };
  assert.equal(validate(bad), false);
});

// --- scan-event: every URI kind the fan-out can carry (ADR 0034 card, ADR 0058 demo) ---
// Driven off CURATOR_URI_KINDS so the schema's pattern and the parser's regex cannot drift apart:
// declaring a kind in the helper without widening the schema fails here.

test("a start scan validates for every declared URI kind", () => {
  const validate = ajv.getSchema(SCAN_ID);
  for (const kind of CURATOR_URI_KINDS) {
    const ev = {
      event: "start",
      uri: `curator:${kind}:2k7bxq9m`,
      tagUid: "04:A1:B2:C3:D4:E5:F6",
      at: "2026-07-24T20:15:22Z",
    };
    assert.ok(validate(ev), `${kind}: ${JSON.stringify(validate.errors)}`);
  }
});

test("a scan URI with an unknown kind is rejected", () => {
  const validate = ajv.getSchema(SCAN_ID);
  const bad = {
    event: "start",
    uri: "curator:disc:2k7bxq9m",
    tagUid: "04:A1:B2:C3:D4:E5:F6",
    at: "2026-07-24T20:15:22Z",
  };
  assert.equal(validate(bad), false);
});

test("a start scan without a uri is rejected", () => {
  const validate = ajv.getSchema(SCAN_ID);
  assert.equal(validate({ event: "start", at: "2026-07-24T20:15:22Z" }), false);
});
