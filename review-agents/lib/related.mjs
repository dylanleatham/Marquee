// Finding the files a change might contradict, when a glob can't name them.
//
// A reviewer normally reads context chosen by `contextGlobs` — a fixed list, decided when the
// reviewer was written. That works when the relevant context is known in advance (a schema reviewer
// always wants the schemas). It cannot work for `spec-adherence`'s doc↔doc half, whose whole
// question is *"which other copies of this fact are now wrong?"*: the answer is "whichever of 90+
// ADRs and 17 specs happen to mention what this diff touched", which is a search, not a glob.
//
// So `contextRelated` resolves context by keyword overlap, bounded on every axis (ADR 0086). The
// alternative considered and rejected was letting the reviewer grep for itself: cheaper to build,
// but it would make one reviewer
// tool-using when every other reads a fixed prompt, put an unbounded amount of work behind a fixed
// timeout, and make the context invisible to `--explain` — which is how false positives get
// diagnosed today.
//
// Everything here is deterministic. Two runs over the same tree must select the same files in the
// same order, or a reviewer's context reshuffles between runs and two reviews of one diff cannot be
// compared at all.

import { join } from "node:path";
import { filesMatching, readTruncated } from "./util.mjs";

/**
 * Words too common to indicate that two documents are about the same thing. Deliberately short:
 * over-filtering costs a real signal, while a stray common word only ever adds noise to a score
 * that is already a ranking rather than a threshold.
 */
const STOPWORDS = new Set(
  (
    "the and that this with from have has been will not are was were for its it's into out off " +
    "when where which what who why how all any can could should would may might must shall " +
    "then than there their they them these those such some more most other another each every " +
    "also only just even still yet but nor because while during before after above below over " +
    "under again further once here both few own same too very does did done doing about " +
    "adr docs doc spec specs note notes see also section issue issues pull request commit " +
    "https http github com www md json yaml yml ts tsx mjs js py toml " +
    "add adds added remove removed removes update updated updates change changed changes fix " +
    "fixed fixes file files line lines code test tests run runs running use used uses using " +
    "make makes made get gets got set sets setting settings new old " +
    "true false null undefined const let var function return import export default async await"
  )
    .split(/\s+/)
    .filter(Boolean),
);

/**
 * The distinctive words a diff is about.
 *
 * Reads the changed lines and the changed paths — a path is a strong signal (`runbook`,
 * `bring-up-checklist`) and costs nothing. Ranked by frequency, ties broken alphabetically so the
 * result never depends on iteration order.
 */
/**
 * Words of four or more letters, with compounds split apart.
 *
 * `bring-up-checklist` yields "bring" and "checklist" rather than one hyphenated token, because
 * these words are matched against the *prose* of other documents — and a spec discussing the
 * checklist writes "checklist", not the filename. Keeping the compound whole would match nothing.
 */
const WORD = /[a-z][a-z0-9]{3,}/g;

export function extractKeywords(text, { limit = 24 } = {}) {
  const counts = new Map();
  for (const raw of String(text ?? "").split("\n")) {
    // Only changed lines carry the subject; context lines are the surrounding document.
    const line = /^[+-]/.test(raw) && !/^[+-]{3}/.test(raw) ? raw.slice(1) : "";
    for (const token of line.toLowerCase().matchAll(WORD)) {
      const word = token[0];
      if (STOPWORDS.has(word)) continue;
      counts.set(word, (counts.get(word) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([word]) => word);
}

/** Path tokens, so `docs/runbook.md` contributes "runbook" even if the word never appears in a hunk. */
export function keywordsFromPaths(paths = []) {
  const out = new Set();
  for (const p of paths)
    for (const token of String(p).toLowerCase().matchAll(WORD))
      if (!STOPWORDS.has(token[0])) out.add(token[0]);
  return [...out].sort();
}

/**
 * Files that share vocabulary with the change, best first.
 *
 * Bounded on four axes, because this is the one place in the harness that reads files nobody named
 * in advance: how many candidates are scanned at all (`maxScan`), how much of each is read
 * (`perFileBytes`), how many are returned (`maxFiles`), and how many bytes they may contribute in
 * total (`maxBytes`). An unbounded version would put the whole `docs/` tree behind a fixed timeout.
 *
 * Score is the number of *distinct* keywords a file contains, not total occurrences: a spec that
 * mentions one word forty times is not more related than one that mentions eight words once.
 */
export function relatedFiles({
  root,
  changed = [],
  over = [],
  keywords = [],
  maxFiles = 6,
  maxBytes = 100_000,
  perFileBytes = 24_000,
  maxScan = 400,
}) {
  if (!over.length || !keywords.length) return [];
  const exclude = new Set(changed);
  // Sorted before slicing so the scan set is the same on every machine — `filesMatching` walks in
  // directory order, which is stable per filesystem but not guaranteed across them.
  const candidates = filesMatching(root, over)
    .filter((f) => !exclude.has(f))
    .sort()
    .slice(0, maxScan);

  const scored = [];
  for (const rel of candidates) {
    const body = readTruncated(join(root, rel), perFileBytes);
    if (!body) continue;
    const haystack = body.toLowerCase();
    let score = 0;
    for (const word of keywords) if (haystack.includes(word)) score++;
    if (score > 0) scored.push({ file: rel, score, body });
  }

  scored.sort((a, b) => b.score - a.score || a.file.localeCompare(b.file));

  const picked = [];
  let bytes = 0;
  for (const entry of scored) {
    if (picked.length >= maxFiles) break;
    if (bytes + entry.body.length > maxBytes) continue; // a big file must not evict several small ones
    picked.push(entry);
    bytes += entry.body.length;
  }
  return picked;
}

/**
 * Resolve a specialist's `contextRelated` block against a change.
 *
 * Shape: `{ over: string[], maxFiles?: number, maxBytes?: number }`.
 *
 * There is deliberately no `by` discriminator. An earlier draft carried `by: "keywords"` to leave
 * room for a second strategy, and the `consistency` reviewer caught that the config had a field
 * neither the README nor ADR 0086 documented. A key that nothing reads is speculative generality
 * plus a drift risk; the next strategy can add it when it exists.
 */
export function resolveContextRelated(config, { files, diff, root }) {
  const spec = config?.contextRelated;
  if (!spec?.over?.length) return [];
  const keywords = [
    ...new Set([...extractKeywords(diff), ...keywordsFromPaths(files)]),
  ].sort();
  return relatedFiles({
    root,
    changed: files,
    over: spec.over,
    keywords,
    maxFiles: spec.maxFiles,
    maxBytes: spec.maxBytes,
  });
}
