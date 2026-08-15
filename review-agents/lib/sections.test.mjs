// Tests for section-level context selection (issue #325).
//
// The bug: `readTruncated` takes the first 16KB of a context file, which for a 228KB spec is the
// front matter and the layout — orientation, not behaviour. Of curator-spec.md's 54 sections, 10
// survive, and the first one lost is `## 8. HTTP API`, which is exactly what a reviewer would need
// to check a change to `server.ts` against.
//
// The fix spends the same budget on the *relevant* sections instead of the first ones.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { selectSections, splitSections } from "./sections.mjs";

const REPO = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const CURATOR_SPEC = join(REPO, "docs", "specs", "curator-spec.md");

const doc = [
  "# Curator",
  "",
  "Intro prose that orients a reader.",
  "",
  "## 1. Layout",
  "",
  "Where the files live. Nothing about behaviour.",
  "",
  "## 8. HTTP API",
  "",
  "`GET /api/albums` returns the collection. `POST /api/albums` adds one.",
  "",
  "## 9. Roadie",
  "",
  "The queue drains in order.",
  "",
].join("\n");

test("splitSections: a document becomes its heading blocks, title block first", () => {
  // Every spec in this repo opens with `# Title`, so the first block is a heading block, not
  // heading-less prose. selectSections keeps whichever it is.
  const parts = splitSections(doc);
  assert.equal(parts[0].heading, "# Curator");
  assert.match(parts[0].body, /Intro prose/);
  assert.deepEqual(
    parts.slice(1).map((p) => p.heading),
    ["## 1. Layout", "## 8. HTTP API", "## 9. Roadie"],
  );
});

test("splitSections: a document with no headings is one block", () => {
  const parts = splitSections("just prose, no headings at all");
  assert.equal(parts.length, 1);
  assert.equal(parts[0].heading, null);
});

test("selectSections: keeps the section the change is about, drops the ones it is not", () => {
  // The whole point. A budget too small for the document must be spent on `## 8. HTTP API` rather
  // than on `## 1. Layout`, which is what taking the first N bytes does.
  const out = selectSections(doc, ["albums", "returns", "collection"], {
    maxBytes: 160,
  });
  assert.match(out, /8\. HTTP API/);
  assert.doesNotMatch(out, /1\. Layout/);
});

test("selectSections: the title block is always kept, so the reviewer knows what it is reading", () => {
  const out = selectSections(doc, ["roadie", "queue"], { maxBytes: 160 });
  assert.match(out, /# Curator/);
  assert.match(out, /9\. Roadie/);
});

test("selectSections: sections come back in document order, not score order", () => {
  // A spec read out of order is harder to follow than one with gaps, and the gaps are marked.
  const out = selectSections(doc, ["roadie", "albums", "queue", "returns"], {
    maxBytes: 400,
  });
  assert.ok(
    out.indexOf("8. HTTP API") < out.indexOf("9. Roadie"),
    "document order",
  );
});

test("selectSections: what was dropped is stated, not silently missing", () => {
  // The failure this replaces was silent. A gap the reviewer can see is a different thing from a
  // file that simply stops — it can go and read the rest, since specialists have file access.
  const out = selectSections(doc, ["albums"], { maxBytes: 160 });
  assert.match(out, /section\(s\) omitted/);
});

test("selectSections: a document under budget is returned whole and unmarked", () => {
  const out = selectSections(doc, ["albums"], { maxBytes: 100_000 });
  assert.match(out, /1\. Layout/);
  assert.match(out, /9\. Roadie/);
  assert.doesNotMatch(out, /omitted/);
});

test("selectSections: no keywords falls back to the front of the document", () => {
  // Degrades to the old behaviour rather than returning nothing — a reviewer with no keywords to
  // match on is no worse off than before this existed.
  const out = selectSections(doc, [], { maxBytes: 160 });
  assert.match(out, /# Curator/);
  assert.match(out, /1\. Layout/);
});

// --- the real file, which is what the issue is about ------------------------------------------

test("curator-spec.md: the HTTP API section reaches a reviewer of server.ts (#325)", () => {
  // Measured before the fix: of 54 sections, 10 survived the 16KB cap and `## 8. HTTP API` was the
  // first one lost. This is the regression test for that exact fact, against the real spec.
  const spec = readFileSync(CURATOR_SPEC, "utf8");
  assert.ok(spec.length > 100_000, "the spec is large; that is the premise");

  const naive = spec.slice(0, 16_000);
  assert.doesNotMatch(naive, /## 8\. HTTP API/, "the old behaviour lost it");

  const selected = selectSections(
    spec,
    ["http", "api", "albums", "endpoint", "route", "server"],
    { maxBytes: 16_000 },
  );
  assert.ok(selected.length <= 16_000 + 500, "stays within budget");
  assert.match(selected, /## 8\. HTTP API/, "the fix keeps it");
});
