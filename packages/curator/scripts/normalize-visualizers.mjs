#!/usr/bin/env node
// Backfill for issue #180 / ADR 0040: bring visualizers that were ingested BEFORE the decode budget
// existed inside it. Normalization runs at ingest, so files already in the store were never touched —
// on the hardware that found this bug that was six files at ~20 Mbps, every one of which stuttered on
// the Pi.
//
//   pnpm --filter @marquee/curator build          # the script reads the budget from dist/
//   node packages/curator/scripts/normalize-visualizers.mjs --dry-run
//   node packages/curator/scripts/normalize-visualizers.mjs
//
// Then re-push to Backdrop (contentHash changed): POST /api/backdrop/sync.
//
// The budget, the check, and the encode argv are all imported — this script deliberately owns no
// policy of its own, so it can't drift from what ingest does.
import { readdirSync, statSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import {
  ffmpegProber,
  budgetViolations,
  DECODE_BUDGET,
} from "../dist/media/video.js";

const dryRun = process.argv.includes("--dry-run");
const dataDir = process.env.MARQUEE_DATA_DIR ?? join(homedir(), "marquee");
const dir = join(dataDir, "media", "visualizers");

const mb = (bytes) => (bytes / 1_000_000).toFixed(1);
const mbps = (bps) => (bps / 1_000_000).toFixed(1);

let files;
try {
  files = readdirSync(dir).filter((f) => f.endsWith(".mp4"));
} catch {
  console.error(`No visualizers directory at ${dir}`);
  console.error("Set MARQUEE_DATA_DIR if your store lives elsewhere.");
  process.exit(1);
}

if (files.length === 0) {
  console.log(`No .mp4 files in ${dir}`);
  process.exit(0);
}

console.log(`${dir}`);
console.log(
  `Budget: <=${DECODE_BUDGET.maxWidth}x${DECODE_BUDGET.maxHeight}, ` +
    `<=${DECODE_BUDGET.maxFps}fps, <=${mbps(DECODE_BUDGET.maxBitrateBps)} Mbps, H.264, no audio\n`,
);

let converted = 0;
let skipped = 0;
let failed = 0;
let before = 0;
let after = 0;

for (const name of files) {
  const path = join(dir, name);
  let info;
  try {
    info = await ffmpegProber.probe(path);
  } catch (err) {
    console.log(`  ${name}: SKIP — could not probe (${err.message})`);
    failed += 1;
    continue;
  }

  const violations = budgetViolations(info);
  const sizeBefore = statSync(path).size;
  const shape =
    `${info.width}x${info.height} ${Math.round(info.fps)}fps ` +
    `${mbps(info.bitRateBps)}Mbps ${info.codec}${info.hasAudio ? "+audio" : ""}`;

  if (violations.length === 0) {
    console.log(`  ${name}: ok — ${shape}`);
    skipped += 1;
    before += sizeBefore;
    after += sizeBefore;
    continue;
  }

  console.log(
    `  ${name}: ${shape}  →  over budget on ${violations.join(", ")}`,
  );
  before += sizeBefore;

  if (dryRun) {
    after += sizeBefore;
    continue;
  }

  // Temp + rename: never leave a half-written mp4 where the old good one was. Backdrop would play it.
  const tmp = `${path}.tmp-${randomUUID()}`;
  try {
    await ffmpegProber.normalize(path, tmp, info);
    renameSync(tmp, path);
    const sizeAfter = statSync(path).size;
    after += sizeAfter;
    converted += 1;
    console.log(
      `    → ${mb(sizeBefore)} MB → ${mb(sizeAfter)} MB ` +
        `(${(sizeBefore / sizeAfter).toFixed(1)}x smaller)`,
    );
  } catch (err) {
    rmSync(tmp, { force: true });
    after += sizeBefore;
    failed += 1;
    console.log(`    → FAILED, original left in place: ${err.message}`);
  }
}

console.log(
  `\n${dryRun ? "[dry run] " : ""}` +
    `${converted} normalized, ${skipped} already in budget, ${failed} failed`,
);
if (!dryRun && converted > 0) {
  console.log(
    `Total: ${mb(before)} MB → ${mb(after)} MB. ` +
      `Re-push with POST /api/backdrop/sync (contentHash changed).`,
  );
}
process.exit(failed > 0 ? 1 : 0);
