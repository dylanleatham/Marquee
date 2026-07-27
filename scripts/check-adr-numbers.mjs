#!/usr/bin/env node
// Fail if two ADRs claim the same number, or if an ADR's heading disagrees with its filename
// (issue #151).
//
// Both failures come from the same place: two branches each take "the next number", both merge, and
// nothing notices. It happened three times before anyone looked — 0022, 0023, and 0026 (the last on
// a branch that was never opened as a PR). A fourth was queued in PR #82.
//
// The cost isn't the duplicate filenames, it's the citations. ADRs are cited as bare "ADR 0022" in
// prose and code comments far more often than they're linked, and a duplicated number makes ~70 of
// those ambiguous at a glance — including to an agent told to "grep the keywords and fix every hit".
//
// Usage:
//   node scripts/check-adr-numbers.mjs          # prints offenders, exits 1 if any
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** `0032-card-art-refusal-drops-the-cover-reference.md` → `0032`. */
const FILENAME = /^(\d{4})-[a-z0-9-]+\.md$/;
/** The `# ADR 0032 — …` heading on line 1. */
const HEADING = /^#\s*ADR\s*(\d{4})\b/m;

export function adrsIn(dir) {
  return readdirSync(dir)
    .filter((name) => name.endsWith(".md"))
    .map((name) => {
      const match = FILENAME.exec(name);
      const heading = HEADING.exec(readFileSync(join(dir, name), "utf8"));
      return {
        name,
        number: match?.[1] ?? null,
        heading: heading?.[1] ?? null,
      };
    });
}

/**
 * Every problem found, as human-readable lines. Empty array = clean.
 *
 * Three checks, because each has actually happened: a number used twice, a filename that isn't
 * numbered at all, and a heading that disagrees with its filename (the shape a half-finished
 * renumber leaves behind).
 */
export function checkAdrNumbers(dir) {
  const adrs = adrsIn(dir);
  const problems = [];

  const byNumber = new Map();
  for (const adr of adrs) {
    if (!adr.number) {
      problems.push(
        `${adr.name}: filename doesn't start with a 4-digit ADR number`,
      );
      continue;
    }
    if (!byNumber.has(adr.number)) byNumber.set(adr.number, []);
    byNumber.get(adr.number).push(adr.name);
  }

  for (const [number, names] of [...byNumber].sort()) {
    if (names.length > 1)
      problems.push(
        `ADR ${number} is used by ${names.length} files: ${names.join(", ")} — ` +
          `renumber all but one to the next free number (highest is currently ${highest(adrs)})`,
      );
  }

  for (const adr of adrs) {
    if (!adr.number) continue;
    if (adr.heading === null)
      problems.push(`${adr.name}: no "# ADR NNNN" heading found`);
    else if (adr.heading !== adr.number)
      problems.push(
        `${adr.name}: heading says ADR ${adr.heading} but the filename says ${adr.number}`,
      );
  }

  return problems;
}

/** The highest number in use — what a new ADR should exceed. */
export function highest(adrs) {
  const numbers = adrs.map((a) => a.number).filter(Boolean);
  return numbers.length ? numbers.sort().at(-1) : "0000";
}

// Run directly (the test imports the functions above instead).
if (
  process.argv[1] &&
  import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"))
) {
  const dir = join(import.meta.dirname, "..", "docs", "adrs");
  const problems = checkAdrNumbers(dir);
  if (problems.length) {
    console.error("ADR numbering problems:\n");
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log(
    `ADR numbering clean (${adrsIn(dir).length} ADRs, highest ${highest(adrsIn(dir))}).`,
  );
}
