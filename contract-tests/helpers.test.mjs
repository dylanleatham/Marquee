import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseCuratorUri,
  curatorUri,
  scanIgnoredReason,
  readPatternOverride,
  CURATOR_URI_KINDS,
  PATTERN_TYPES,
} from "@marquee/contracts";

// The scan-URI kind (album=sleeve, card=card, demo=one chosen track) is a cross-service fact
// (ADR 0034, ADR 0058) — pin the parse/build helpers so every service decodes and encodes it
// identically. The kind list is enumerated rather than restated, so a fourth kind is covered here
// the moment it is declared.

test("parseCuratorUri parses every declared kind", () => {
  assert.deepEqual(CURATOR_URI_KINDS, ["album", "card", "demo"]);
  for (const kind of CURATOR_URI_KINDS) {
    assert.deepEqual(parseCuratorUri(`curator:${kind}:2k7bxq9m`), {
      kind,
      curatorId: "2k7bxq9m",
    });
  }
});

test("parseCuratorUri rejects unknown kinds and malformed ids", () => {
  assert.equal(parseCuratorUri("curator:disc:2k7bxq9m"), null);
  assert.equal(parseCuratorUri("curator:album:TOOLONG9"), null); // uppercase / 8+ chars
  assert.equal(parseCuratorUri("spotify:album:2k7bxq9m"), null);
  assert.equal(parseCuratorUri(""), null);
});

test("curatorUri is the inverse of parseCuratorUri", () => {
  for (const kind of CURATOR_URI_KINDS) {
    const uri = curatorUri(kind, "2k7bxq9m");
    assert.equal(uri, `curator:${kind}:2k7bxq9m`);
    assert.deepEqual(parseCuratorUri(uri), { kind, curatorId: "2k7bxq9m" });
  }
});

// "A 2xx means it happened" is the cross-service fact that was wrong (issue #164). Conductor's
// accepted-but-ignored shape is decoded in exactly one place so no caller can read a documented
// no-op as success.

test("scanIgnoredReason surfaces every ignored outcome with its reason", () => {
  for (const reason of [
    "no listening room",
    "album not synced",
    "album not ready",
  ]) {
    assert.equal(
      scanIgnoredReason({ ok: true, action: "ignored", reason }),
      reason,
    );
  }
});

test("scanIgnoredReason still reports an ignored scan that gave no reason", () => {
  assert.equal(
    scanIgnoredReason({ ok: true, action: "ignored" }),
    "the scan was ignored",
  );
  assert.equal(
    scanIgnoredReason({ ok: true, action: "ignored", reason: "" }),
    "the scan was ignored",
  );
});

test("scanIgnoredReason treats anything that isn't an explicit ignore as acted on", () => {
  // Conductor acting, and Backdrop merely accepting — both ran.
  assert.equal(
    scanIgnoredReason({ ok: true, action: "playing", roomId: "7" }),
    null,
  );
  assert.equal(scanIgnoredReason({ ok: true, action: "stopped" }), null);
  assert.equal(scanIgnoredReason({ accepted: true }), null);
  // An unreadable or absent body is not evidence of a no-op.
  assert.equal(scanIgnoredReason(null), null);
  assert.equal(scanIgnoredReason(undefined), null);
  assert.equal(scanIgnoredReason("ignored"), null);
  assert.equal(scanIgnoredReason(42), null);
});

// --- readPatternOverride: the ADR 0039 field rename, read from both generations ------------------
// Conductor reads the synced album-asset store directly (ADR 0019) rather than asking Curator, so an
// album last saved under ADR 0035's `streamingEffect`/`streamingParams` must still play what its
// owner chose. That makes the rename a cross-service compatibility fact, which is why the guard
// lives here rather than in one service's unit tests.

test("readPatternOverride reads the current field names", () => {
  assert.deepEqual(
    readPatternOverride({
      patternOverride: "aurora",
      patternOverrideParams: { speed: 0.2 },
    }),
    { type: "aurora", params: { speed: 0.2 } },
  );
});

test("readPatternOverride still honours assets written before the ADR 0039 rename", () => {
  assert.deepEqual(
    readPatternOverride({
      streamingEffect: "shimmer",
      streamingParams: { intensity: 0.5 },
    }),
    { type: "shimmer", params: { intensity: 0.5 } },
  );
});

test("readPatternOverride prefers the current name when an asset carries both", () => {
  // A re-saved album keeps its legacy keys; the new field is the one the human last touched, and
  // its params must not be crossed with the old effect's.
  assert.deepEqual(
    readPatternOverride({
      patternOverride: "wave",
      patternOverrideParams: { angleDeg: 90 },
      streamingEffect: "aurora",
      streamingParams: { speed: 0.4 },
    }),
    { type: "wave", params: { angleDeg: 90 } },
  );
});

test("readPatternOverride reports no override for the default, untouched album", () => {
  for (const asset of [
    {},
    { patternOverride: null },
    { streamingEffect: null },
  ])
    assert.deepEqual(readPatternOverride(asset), { type: null, params: {} });
});

test("readPatternOverride drops a value that isn't a known pattern", () => {
  // Best-effort posture: an unrecognized override is ignored so the derived pattern plays, rather
  // than propagating a type no renderer knows into the payload.
  assert.deepEqual(
    readPatternOverride({
      patternOverride: "strobe",
      patternOverrideParams: { speed: 1 },
    }),
    { type: null, params: {} },
  );
});

test("readPatternOverride accepts every declared pattern type", () => {
  // Enumerated, so an eighth pattern is covered here the moment it is declared.
  for (const type of PATTERN_TYPES)
    assert.deepEqual(readPatternOverride({ patternOverride: type }), {
      type,
      params: {},
    });
});
