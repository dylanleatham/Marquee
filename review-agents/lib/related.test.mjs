// Tests for keyword-resolved context (ADR 0086).
//
// The point of `contextRelated` is that `spec-adherence` cannot name its doc context in advance — the
// question "which other copies of this fact are now wrong?" is a search. The risk of a search is
// that it is unbounded and non-deterministic, so that is what these pin.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import {
  extractKeywords,
  keywordsFromPaths,
  relatedFiles,
  resolveContextRelated,
} from "./related.mjs";

/** A throwaway docs tree, so these never depend on what the real repo happens to contain. */
function tree(files) {
  const root = mkdtempSync(join(tmpdir(), "related-"));
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  }
  return root;
}
const cleanup = (root) => rmSync(root, { recursive: true, force: true });

test("extractKeywords: reads changed lines, not the surrounding document", () => {
  // Context lines are what the file already said; only the +/- lines are what this change is about.
  const diff = [
    "--- a/docs/runbook.md",
    "+++ b/docs/runbook.md",
    " the backdrop kiosk sits untouched in this hunk",
    "-the pi5 address lives in three places",
    "+the pi5 address lives in two places",
  ].join("\n");
  const words = extractKeywords(diff);
  assert.ok(words.includes("address"));
  assert.ok(words.includes("places"));
  assert.ok(
    !words.includes("backdrop"),
    "a context line is not the subject of the change",
  );
  // The `+++`/`---` headers are not content.
  assert.ok(!words.includes("runbook"));
});

test("extractKeywords: drops stopwords and ranks deterministically", () => {
  const diff = "+the the the and and drift drift drift cadence\n+drift";
  const words = extractKeywords(diff);
  assert.equal(words[0], "drift"); // 4 occurrences
  assert.ok(!words.includes("the"));
  assert.ok(!words.includes("and"));
  // Same input, same order, every time — the eval cache key depends on it.
  assert.deepEqual(extractKeywords(diff), words);
});

test("keywordsFromPaths: a filename is a signal even when the word never appears in a hunk", () => {
  const words = keywordsFromPaths([
    "docs/bring-up-checklist.md",
    "docs/runbook.md",
  ]);
  assert.ok(words.includes("runbook"));
  assert.ok(words.includes("checklist"));
  assert.deepEqual(words, [...words].sort(), "sorted, so the result is stable");
});

test("relatedFiles: ranks by distinct keywords matched, not total occurrences", () => {
  // A file repeating one word forty times is not more related than one matching eight words once.
  const root = tree({
    "docs/repeats.md": "address ".repeat(40),
    "docs/broad.md": "address places pi5 kiosk systemd",
  });
  try {
    const picked = relatedFiles({
      root,
      over: ["docs/**/*.md"],
      keywords: ["address", "places", "pi5", "kiosk", "systemd"],
    });
    assert.deepEqual(
      picked.map((p) => p.file),
      ["docs/broad.md", "docs/repeats.md"],
    );
    assert.equal(picked[0].score, 5);
    assert.equal(picked[1].score, 1);
  } finally {
    cleanup(root);
  }
});

test("relatedFiles: the changed files themselves are never returned as context", () => {
  // They are already in the diff; sending them again spends budget to say nothing.
  const root = tree({
    "docs/runbook.md": "address places",
    "docs/other.md": "address places",
  });
  try {
    const picked = relatedFiles({
      root,
      changed: ["docs/runbook.md"],
      over: ["docs/**/*.md"],
      keywords: ["address", "places"],
    });
    assert.deepEqual(
      picked.map((p) => p.file),
      ["docs/other.md"],
    );
  } finally {
    cleanup(root);
  }
});

test("relatedFiles: bounded by file count and by total bytes", () => {
  // This is the one place in the harness that reads files nobody named in advance. Unbounded, it
  // would put the whole docs tree behind a fixed timeout.
  const root = tree(
    Object.fromEntries(
      Array.from({ length: 12 }, (_, i) => [
        `docs/d${i}.md`,
        "address places pi5",
      ]),
    ),
  );
  try {
    const byCount = relatedFiles({
      root,
      over: ["docs/**/*.md"],
      keywords: ["address"],
      maxFiles: 3,
    });
    assert.equal(byCount.length, 3);

    const byBytes = relatedFiles({
      root,
      over: ["docs/**/*.md"],
      keywords: ["address"],
      maxFiles: 99,
      maxBytes: 40, // "address places pi5" is 18 bytes → two fit, the third does not
    });
    assert.equal(byBytes.length, 2);
  } finally {
    cleanup(root);
  }
});

test("relatedFiles: a file matching nothing is not context", () => {
  const root = tree({
    "docs/hit.md": "address",
    "docs/unrelated.md": "entirely different subject matter",
  });
  try {
    const picked = relatedFiles({
      root,
      over: ["docs/**/*.md"],
      keywords: ["address"],
    });
    assert.deepEqual(
      picked.map((p) => p.file),
      ["docs/hit.md"],
    );
  } finally {
    cleanup(root);
  }
});

test("relatedFiles: same tree, same selection and order", () => {
  // A reshuffle between runs would void the eval cache and could read as a regression.
  const root = tree({
    "docs/a.md": "address places",
    "docs/b.md": "address places",
    "docs/c.md": "address",
  });
  try {
    const once = relatedFiles({
      root,
      over: ["docs/**/*.md"],
      keywords: ["address", "places"],
    }).map((p) => p.file);
    const twice = relatedFiles({
      root,
      over: ["docs/**/*.md"],
      keywords: ["address", "places"],
    }).map((p) => p.file);
    assert.deepEqual(once, twice);
    assert.deepEqual(once, ["docs/a.md", "docs/b.md", "docs/c.md"]);
  } finally {
    cleanup(root);
  }
});

test("relatedFiles: nothing to search, or nothing to search for, returns nothing", () => {
  const root = tree({ "docs/a.md": "address" });
  try {
    assert.deepEqual(
      relatedFiles({ root, over: [], keywords: ["address"] }),
      [],
    );
    assert.deepEqual(
      relatedFiles({ root, over: ["docs/**/*.md"], keywords: [] }),
      [],
    );
  } finally {
    cleanup(root);
  }
});

test("resolveContextRelated: a specialist without the block resolves nothing", () => {
  // Every other reviewer must be completely unaffected by this capability existing.
  const root = tree({ "docs/a.md": "address" });
  try {
    assert.deepEqual(
      resolveContextRelated({ id: "runtime" }, { files: [], diff: "", root }),
      [],
    );
    assert.deepEqual(
      resolveContextRelated(
        { contextRelated: { over: [] } },
        { files: [], diff: "+address", root },
      ),
      [],
    );
  } finally {
    cleanup(root);
  }
});

test("resolveContextRelated: combines diff keywords with path keywords", () => {
  const root = tree({
    "docs/checklist.md": "the bring-up checklist mentions the kiosk",
    "docs/unrelated.md": "nothing in common at all",
  });
  try {
    const picked = resolveContextRelated(
      { contextRelated: { over: ["docs/**/*.md"], maxFiles: 4 } },
      {
        files: ["docs/kiosk-notes.md"], // contributes "kiosk" via the path alone
        diff: "+the checklist changed",
        root,
      },
    );
    assert.deepEqual(
      picked.map((p) => p.file),
      ["docs/checklist.md"],
    );
  } finally {
    cleanup(root);
  }
});
