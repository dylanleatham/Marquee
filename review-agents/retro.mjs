#!/usr/bin/env node
// Read the harness's own evidence and write a proposal file. See lib/retro.mjs for the reasoning
// and docs/specs/harness-self-improvement.md §4.6.
//
// Usage:
//   node review-agents/retro.mjs                 # write review-agents/retro/<date>.md
//     --since <ref|date>   fix(...) commits to consider (default: since the last retro, else 30 days)
//     --stdout             print instead of writing a file
//
// **This never edits a prompt, a config, or an example.** It writes one markdown file and nothing
// else — a test asserts the rest of the tree is untouched. Any change made from its output still has
// to pass the eval, which is the half that makes a wrong proposal harmless.

import {
  readFileSync,
  writeFileSync,
  readdirSync,
  existsSync,
  mkdirSync,
  statSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadLedger } from "./lib/ledger.mjs";
import { loadSpecialists } from "./lib/specialists.mjs";
import { buildRetro, formatRetro } from "./lib/retro.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const RETRO_DIR = join(HERE, "retro");
const CASES_DIR = join(HERE, "eval", "cases");
const BASELINE = join(HERE, "eval", "baseline.json");
const LEDGER = join(HERE, "ledger.jsonl");

const argv = process.argv.slice(2);
const val = (f) => {
  const i = argv.indexOf(f);
  return i !== -1 ? argv[i + 1] : undefined;
};

/** The window: since the newest existing retro, else the last 30 days. */
function defaultSince() {
  if (!existsSync(RETRO_DIR)) return "30 days ago";
  const previous = readdirSync(RETRO_DIR)
    .filter((f) => f.endsWith(".md"))
    .sort();
  if (!previous.length) return "30 days ago";
  return previous[previous.length - 1].replace(/\.md$/, "");
}

/** `fix(...)` commits in the window — the escaped bugs §12 says should become checks. */
function fixCommits(since) {
  try {
    const out = execFileSync(
      "git",
      ["log", `--since=${since}`, "--format=%H%x00%s", "--no-merges"],
      {
        cwd: ROOT,
        encoding: "utf8",
        timeout: 30_000,
        maxBuffer: 8 * 1024 * 1024,
      },
    );
    return out
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [sha, subject] = line.split("\0");
        return { sha, subject };
      })
      .filter((c) => /^fix[(:]/.test(c.subject));
  } catch {
    // No git, a shallow clone, or a bad --since. A retro without commit history is thinner, not
    // wrong, so it degrades rather than failing.
    return [];
  }
}

function loadCases() {
  if (!existsSync(CASES_DIR)) return [];
  return readdirSync(CASES_DIR)
    .filter((d) => statSync(join(CASES_DIR, d)).isDirectory())
    .map((d) => {
      try {
        return JSON.parse(
          readFileSync(join(CASES_DIR, d, "case.json"), "utf8"),
        );
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

const since = val("--since") ?? defaultSince();
const { records, skipped } = loadLedger(LEDGER);
const baseline = existsSync(BASELINE)
  ? JSON.parse(readFileSync(BASELINE, "utf8"))
  : null;

if (skipped)
  console.warn(
    `[WARN ] ${skipped} unparseable ledger line(s) skipped — the evidence below covers less than the ledger claims to hold.`,
  );

const retro = buildRetro({
  ledger: records,
  fixCommits: fixCommits(since),
  baseline,
  cases: loadCases(),
  specialistIds: loadSpecialists().map((s) => s.id),
  now: Date.now(),
});

const date = new Date().toISOString().slice(0, 10);
const text = formatRetro(retro, { date, baseline });

if (argv.includes("--stdout")) {
  console.log(text);
} else {
  mkdirSync(RETRO_DIR, { recursive: true });
  const path = join(RETRO_DIR, `${date}.md`);
  writeFileSync(path, text + "\n");
  console.log(
    `review-agents: wrote review-agents/retro/${date}.md — ${retro.proposals.length} proposal(s), ` +
      `${retro.proposals.filter((p) => p.severity === "act").length} to act on.\n` +
      `Nothing else was changed. Anything you do from it still has to pass \`pnpm run review:eval\`.`,
  );
}
