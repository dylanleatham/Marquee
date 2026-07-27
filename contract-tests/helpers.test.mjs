import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCuratorUri, curatorUri } from "@marquee/contracts";

// The scan-URI kind (album=sleeve, card=card) is a cross-service fact (ADR 0034) — pin the
// parse/build helpers so every service decodes and encodes it identically.

test("parseCuratorUri parses album and card kinds", () => {
  assert.deepEqual(parseCuratorUri("curator:album:2k7bxq9m"), {
    kind: "album",
    curatorId: "2k7bxq9m",
  });
  assert.deepEqual(parseCuratorUri("curator:card:2k7bxq9m"), {
    kind: "card",
    curatorId: "2k7bxq9m",
  });
});

test("parseCuratorUri rejects unknown kinds and malformed ids", () => {
  assert.equal(parseCuratorUri("curator:disc:2k7bxq9m"), null);
  assert.equal(parseCuratorUri("curator:album:TOOLONG9"), null); // uppercase / 8+ chars
  assert.equal(parseCuratorUri("spotify:album:2k7bxq9m"), null);
  assert.equal(parseCuratorUri(""), null);
});

test("curatorUri is the inverse of parseCuratorUri", () => {
  for (const kind of ["album", "card"]) {
    const uri = curatorUri(kind, "2k7bxq9m");
    assert.equal(uri, `curator:${kind}:2k7bxq9m`);
    assert.deepEqual(parseCuratorUri(uri), { kind, curatorId: "2k7bxq9m" });
  }
});
