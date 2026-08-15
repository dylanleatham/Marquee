// Spending a context budget on the sections that matter, instead of on the first ones (issue #325).
//
// `readTruncated` caps a context file at 16KB by taking its front. For a 228KB spec that is the
// title, the layout, and the orientation — and it drops the behaviour. Measured on
// `docs/specs/curator-spec.md`: 10 of 54 sections survived, and the first one lost was
// `## 8. HTTP API`, which is precisely the section a reviewer needs to check `server.ts` against.
// So `spec-adherence` — whose entire job is code-versus-spec drift — has been reading the parts of
// the spec least likely to describe what the code does.
//
// This spends the same budget differently: split the document into heading blocks, score each
// against the keywords already extracted from the diff, and keep the best until the budget runs out.
// Same cost, relevant content.
//
// Two decisions worth stating because the obvious alternatives are worse:
//
//   * **Not "raise the cap".** Loading Curator's four specs whole is ~330KB per review — roughly
//     80k tokens on a reviewer that already carries a 300s budget. That swaps a silent gap for a
//     bill and a timeout.
//   * **Not "let the reviewer read it".** Specialists do have file access and the truncation marker
//     does reach them, so one *could* go and read the rest. Nothing tells it which part is missing
//     or that the missing part is the relevant one, and a reviewer that has to notice and go looking
//     is not a mechanism.

/** The keyword scoring shared with `contextRelated` — same notion of "related", one definition. */
import { extractKeywords, keywordsFromPaths } from "./related.mjs";

export { extractKeywords, keywordsFromPaths };

/** Markdown ATX headings, level 1–3. Deeper headings ride along with their parent section. */
const HEADING = /^(#{1,3}) .*/;

/**
 * A document as its heading blocks, in order.
 *
 * The **first block** — whether that is prose before any heading, or the `# Title` block every spec
 * in this repo actually starts with — carries the name of the document and the sentence saying what
 * it is. `selectSections` keeps it unconditionally: a reviewer handed three disconnected sections of
 * an unnamed file is worse off than one handed the front of it.
 */
export function splitSections(text) {
  const lines = String(text ?? "").split("\n");
  const parts = [];
  let heading = null;
  let level = 0;
  let parent = null;
  let buffer = [];
  /** The still-open heading at each level, so a leaf can name the section it sits under. */
  const openAt = new Map();

  const flush = () => {
    const body = buffer.join("\n");
    if (heading !== null || body.trim())
      parts.push({ heading, level, parent, body });
    buffer = [];
  };

  let inFence = false;
  for (const line of lines) {
    // A ``` fence hides its contents. `# push_assets = false` inside a TOML block is a comment, not
    // a heading, and splitting there tore config examples out of the prose that explains them —
    // curator-spec.md has several.
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    const m = inFence ? null : HEADING.exec(line);
    if (m) {
      flush();
      heading = line;
      level = m[1].length;
      for (const l of [...openAt.keys()]) if (l >= level) openAt.delete(l);
      parent =
        [...openAt.keys()].sort((a, b) => b - a).map((l) => openAt.get(l))[0] ??
        null;
      openAt.set(level, line);
      buffer = [line];
    } else {
      buffer.push(line);
    }
  }
  flush();
  return parts.length
    ? parts
    : [{ heading: null, level: 0, parent: null, body: String(text ?? "") }];
}

/** Distinct keywords a block mentions. Distinct, not total: forty mentions of one word is one topic. */
function score(part, keywords) {
  const haystack = `${part.heading ?? ""}\n${part.body}`.toLowerCase();
  let n = 0;
  for (const word of keywords) if (haystack.includes(word)) n++;
  // A heading match is worth more than a body match — a section *called* "HTTP API" is about the
  // HTTP API, while one that mentions it in passing may not be.
  const inHeading = keywords.filter((w) =>
    `${part.parent ?? ""} ${part.heading ?? ""}`.toLowerCase().includes(w),
  ).length;
  return n + inHeading * 2;
}

/**
 * The parts of `text` most related to `keywords`, within `maxBytes`, in document order.
 *
 * A document that already fits is returned untouched. With no keywords it degrades to the front of
 * the document — the old behaviour — so a caller with nothing to match on is no worse off.
 *
 * Omissions are **stated**, not silent. That is the whole complaint in #325: the previous version
 * ended mid-sentence with a marker that said a file was truncated but not what was missing, and a
 * reviewer cannot reason about a gap it cannot see the shape of.
 */
export function selectSections(
  text,
  keywords = [],
  { maxBytes = 16_000 } = {},
) {
  const source = String(text ?? "");
  if (source.length <= maxBytes) return source;

  const parts = splitSections(source);
  // Always the first block, heading or not — see splitSections.
  const keep = new Set([0]);
  let used = parts[0].body.length + 1;

  const ranked = parts
    .slice(1)
    .map((part, i) => ({
      index: i + 1,
      part,
      score: keywords.length ? score(part, keywords) : 0,
    }))
    // Score first, then document order — with no keywords every score is 0 and this is the front of
    // the document, which is exactly the behaviour being replaced.
    .sort((a, b) => b.score - a.score || a.index - b.index);

  for (const { index, part } of ranked) {
    const cost = part.body.length + 1;
    if (used + cost > maxBytes) continue; // a big section must not evict several small ones
    keep.add(index);
    used += cost;
  }

  const out = [];
  let omitted = 0;
  const keptHeadings = new Set(
    [...keep].map((i) => parts[i].heading).filter(Boolean),
  );
  for (const [i, part] of parts.entries()) {
    if (keep.has(i)) {
      if (omitted) {
        out.push(
          `\n… ${omitted} section(s) omitted as unrelated to this change …\n`,
        );
        omitted = 0;
      }
      // A subsection whose parent was dropped arrives with no home. `### Inventory (adding and
      // removing albums)` means something different once you know it sits under `## 8. HTTP API`,
      // so the parent heading is carried even when its body is not.
      if (part.parent && !keptHeadings.has(part.parent)) {
        out.push(`${part.parent}\n\n_(body omitted — subsection follows)_`);
        keptHeadings.add(part.parent);
      }
      out.push(part.body);
    } else {
      omitted++;
    }
  }
  if (omitted)
    out.push(`\n… ${omitted} section(s) omitted as unrelated to this change …`);
  return out.join("\n");
}
