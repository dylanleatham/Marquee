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
const ASSET_ID = "marquee/schemas/album-asset-v1.json";

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

/**
 * `spotifyMatch` and `spotifyAmbiguous` answer the same question — "which Spotify album is this?" —
 * with contradictory answers ([ADR 0068](../docs/adrs/0068-ambiguous-is-a-third-answer-not-a-missing-one.md),
 * [#289](https://github.com/dylanleatham/Marquee/issues/289)). A record carrying both leaves every
 * consumer to pick whichever it happens to check first, and the two would disagree.
 *
 * `applySpotifyMatch` clears one when it writes the other, so this is the *contract* guard behind
 * that behaviour — a second producer (a migration, a hand-edited asset, a future importer) can't
 * reintroduce the state without failing here.
 */
const asset = (metadata) => ({
  version: 1,
  curatorId: "6byejted",
  createdAt: "2026-08-10T00:00:00.000Z",
  metadata: {
    name: "Weezer",
    artist: "Weezer",
    source: "discogs",
    ...metadata,
  },
  roadie: { state: "awaiting_review" },
});

test("an album may say which Spotify album it is", () => {
  const validate = ajv.getSchema(ASSET_ID);
  const ok = asset({
    spotifyUri: "spotify:album:5n15QbYKbO4pzAV2Iy1VVG",
    spotifyMatch: {
      confidence: "exact",
      name: "Weezer",
      artist: "Weezer",
      matchedAt: "2026-08-10T00:00:00.000Z",
    },
  });
  assert.ok(validate(ok), JSON.stringify(validate.errors, null, 2));
});

test("an album may say why nothing can name it", () => {
  const validate = ajv.getSchema(ASSET_ID);
  const ok = asset({
    spotifyAmbiguous: {
      candidateCount: 6,
      detectedAt: "2026-08-10T00:00:00.000Z",
    },
  });
  assert.ok(validate(ok), JSON.stringify(validate.errors, null, 2));
});

test("an album may not claim a match and an ambiguity at once", () => {
  const validate = ajv.getSchema(ASSET_ID);
  const contradictory = asset({
    spotifyMatch: {
      confidence: "exact",
      name: "Weezer",
      artist: "Weezer",
      matchedAt: "2026-08-10T00:00:00.000Z",
    },
    spotifyAmbiguous: {
      candidateCount: 6,
      detectedAt: "2026-08-10T00:00:00.000Z",
    },
  });
  assert.equal(validate(contradictory), false);
});

// --- library-entry: what Curator is allowed to tell Backdrop about a record ---------------------
// An entry either names a file of its own or declares it has none yet and should play Backdrop's
// default clip ([ADR 0073](../docs/adrs/0073-a-record-with-no-visualizer-plays-the-default.md)).
// The schema has to allow the second shape *and* keep rejecting an entry that says neither —
// "no filePath" must be something Curator meant, not something a malformed push fell into, or a
// sync bug would park the whole library on the fallback and look like it worked.

const LIBRARY_ID = "marquee/schemas/library-entry-v1.json";

test("a library entry naming a visualizer file validates", () => {
  const validate = ajv.getSchema(LIBRARY_ID);
  const ok = {
    uri: "curator:album:2k7bxq9m",
    filePath: "/home/pi/backdrop/media/visualizers/2k7bxq9m.mp4",
    durationSec: 187,
    contentHash: "sha256:abc123",
  };
  assert.ok(validate(ok), JSON.stringify(validate.errors, null, 2));
});

test("a library entry may declare it has no visualizer and plays the default", () => {
  const validate = ajv.getSchema(LIBRARY_ID);
  const ok = { uri: "curator:album:2k7bxq9m", usesDefault: true };
  assert.ok(validate(ok), JSON.stringify(validate.errors, null, 2));
});

test("a library entry that names neither a file nor the default is rejected", () => {
  const validate = ajv.getSchema(LIBRARY_ID);
  assert.equal(validate({ uri: "curator:album:2k7bxq9m" }), false);
});

test("usesDefault: false is not a way to omit filePath", () => {
  const validate = ajv.getSchema(LIBRARY_ID);
  assert.equal(
    validate({ uri: "curator:album:2k7bxq9m", usesDefault: false }),
    false,
  );
});

test("an empty filePath is rejected rather than read as 'no file'", () => {
  const validate = ajv.getSchema(LIBRARY_ID);
  assert.equal(
    validate({ uri: "curator:album:2k7bxq9m", filePath: "" }),
    false,
  );
});

test("a library entry may not name a file and claim the default at once", () => {
  const validate = ajv.getSchema(LIBRARY_ID);
  // Contradictory: readers already resolve it two different ways (Backdrop's `entryHasOwnVideo`
  // prefers the file, `/api/library/update` prefers the marker), so neither answer is the entry's.
  // Same rule, and the same reasoning, as spotifyMatch/spotifyAmbiguous above (ADR 0068).
  assert.equal(
    validate({
      uri: "curator:album:2k7bxq9m",
      filePath: "/media/2k7bxq9m.mp4",
      usesDefault: true,
    }),
    false,
  );
});
