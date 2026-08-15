// Loading specialists, deciding which ones a change triggers, and assembling what they read.
//
// Extracted from orchestrator.mjs when the eval harness arrived
// (docs/specs/harness-self-improvement.md §4.2). The eval scores a specialist against a frozen
// diff, and it is only a measurement of the *real* reviewer if it hands that reviewer byte-for-byte
// the context a real review would. A second, parallel copy of `buildContext` living in the eval
// would drift, and the eval would keep reporting green about a reviewer that no longer exists —
// the silent-green class dev-harness §11 is about, aimed this time at the instrument itself.
//
// So there is one copy, here, and both callers use it.

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { matchesAny, filesMatching, readTruncated } from "./util.mjs";
import { resolveContextRelated } from "./related.mjs";

const HERE = dirname(dirname(fileURLToPath(import.meta.url))); // review-agents/
const ROOT = dirname(HERE); // repo root

/** Which specs to hand a specialist when a given package changes (dev-harness §6). */
export const PACKAGE_SPECS = {
  curator: [
    "curator-spec.md",
    "roadie-spec.md",
    "album-onboarding-workflow.md",
  ],
  "palette-press": ["palette-press-spec.md", "integration-contract.md"],
  "hue-conductor": ["hue-conductor-spec.md", "integration-contract.md"],
  backdrop: ["backdrop-spec.md"],
  stylus: ["stylus-spec.md"],
  contracts: ["integration-contract.md"],
};

/**
 * Every specialist on disk: any directory under `review-agents/` holding a `config.json`, with its
 * prompt and examples read in. Auto-discovery is the documented way to add one (README), so nothing
 * here enumerates them.
 */
export function loadSpecialists(dir = HERE) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const cfgPath = join(dir, entry, "config.json");
    if (!existsSync(cfgPath)) continue;
    const config = JSON.parse(readFileSync(cfgPath, "utf8"));
    config.systemPrompt =
      readTruncated(join(dir, entry, "system-prompt.md"), 40_000) ?? "";
    config.examples =
      readTruncated(join(dir, entry, "examples.md"), 20_000) ?? "";
    out.push(config);
  }
  return out;
}

export function isTriggered(config, files, { root = ROOT } = {}) {
  if (!files.length) return false;
  if (config.triggerAll) return true;
  if (
    config.triggerGlobs &&
    files.some((f) => matchesAny(f, config.triggerGlobs))
  )
    return true;
  if (config.triggerImports?.length) {
    // Only scan real source files — not lockfiles, docs, or generated output.
    const sourceFiles = files.filter((f) =>
      /\.(ts|tsx|mjs|cjs|js|py)$/.test(f),
    );
    for (const f of sourceFiles) {
      const src = readTruncated(join(root, f), 40_000);
      if (src && config.triggerImports.some((imp) => src.includes(imp)))
        return true;
    }
  }
  return false;
}

export function changedPackages(files) {
  const pkgs = new Set();
  for (const f of files) {
    const m = f.match(/^packages\/([^/]+)\//);
    if (m) pkgs.add(m[1]);
  }
  return pkgs;
}

/**
 * What one specialist reads: the changed-file list, the diff, and whatever its `contextGlobs` /
 * `includePackageSpecs` pull in.
 *
 * `root` is injectable only so tests can point it at a fixture tree; both real callers pass the
 * repo root, because context resolved against anything else would not be the context the reviewer
 * actually gets.
 */
export const TRUNCATION_MARKER = "… (file truncated)";

/** Context files that were cut short on the last `buildContext` call, by specialist id. */
const truncatedBySpecialist = new Map();

/** Which context files a specialist received only a fragment of. Empty is the healthy case. */
export const truncatedContext = (id) => truncatedBySpecialist.get(id) ?? [];

export function buildContext(config, { files, diff, root = ROOT }) {
  const truncated = [];
  truncatedBySpecialist.set(config.id, truncated);
  const parts = [
    `# Changed files\n${files.map((f) => `- ${f}`).join("\n")}`,
    `# Diff\n\`\`\`diff\n${diff}\n\`\`\``,
  ];

  const ctxFiles = new Set(filesMatching(root, config.contextGlobs ?? []));
  if (config.includePackageSpecs) {
    for (const pkg of changedPackages(files)) {
      for (const spec of PACKAGE_SPECS[pkg] ?? [])
        ctxFiles.add(`docs/specs/${spec}`);
    }
    ctxFiles.add("docs/specs/runtime-overview.md");
  }
  for (const rel of ctxFiles) {
    const body = readTruncated(join(root, rel));
    if (!body) continue;
    // `readTruncated` caps at 16KB by default and says so only inside the string it returns, where
    // nothing reads it. Several specs are far larger — curator-spec.md is 230KB, so a reviewer
    // handed it sees the first 7% — and the reviewer cannot tell it is looking at a fragment. That
    // is a review quietly covering less than it claims (dev-harness §11), so it is at least
    // reported here. See truncatedContext() for what the caller does with it.
    if (body.endsWith(TRUNCATION_MARKER)) truncated.push(rel);
    parts.push(`# Context: ${rel}\n\`\`\`\n${body}\n\`\`\``);
  }

  // Context a glob cannot name: files that share vocabulary with this change (ADR 0086). Labelled
  // differently from `# Context:` on purpose — these were selected by a heuristic, and a reviewer
  // told they are "possibly related" will hedge where one told they are "the context" would not.
  for (const { file, score } of resolveContextRelated(config, {
    files,
    diff,
    root,
  })) {
    if (ctxFiles.has(file)) continue;
    const body = readTruncated(join(root, file));
    if (body)
      parts.push(
        `# Possibly related (matched ${score} keyword(s) from this change): ${file}\n\`\`\`\n${body}\n\`\`\``,
      );
  }
  return parts.join("\n\n");
}
