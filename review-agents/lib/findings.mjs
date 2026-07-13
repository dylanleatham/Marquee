// Findings: the shared shape every specialist emits, plus parsing + dedupe.
//
// Finding = {
//   specialist: string,               // "contract-guardian"
//   severity: "blocking" | "info",
//   file: string,                     // repo-relative path
//   line: number | null,
//   message: string,                  // one-sentence statement of the issue
//   suggestion?: string,              // optional fix hint
// }

/**
 * Pull the findings array out of a model reply — tolerant of prose, ```json fences, and
 * incidental brackets in the prose (e.g. a specialist quoting `headers["x"]`). Strategy:
 * collect every balanced `[...]` span that parses as JSON, plus the whole text and any
 * fenced block, then pick an array *of objects* (what a findings array is). This avoids
 * grabbing a stray string array from the explanation.
 *
 * Fallback (RA-1): when there's no array at all, the model may have emitted a lone finding
 * as a bare object `{…}` (or one object per line), mirroring the single-object template in
 * the output contract instead of wrapping it in `[ … ]`. Recover any object that looks like
 * a finding rather than dropping the whole specialist's review.
 */
export function extractJsonArray(text) {
  if (!text) return null;

  const candidates = [];
  const tryPush = (s) => {
    try {
      const v = JSON.parse(s);
      if (Array.isArray(v)) candidates.push(v);
    } catch {
      /* not JSON — ignore */
    }
  };

  const trimmed = text.trim();
  tryPush(trimmed);
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) tryPush(fence[1].trim());

  // Every balanced top-level `[...]` span (string-aware, so brackets inside strings don't count).
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "[") continue;
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let j = i; j < text.length; j++) {
      const c = text[j];
      if (inStr) {
        if (esc) esc = false;
        else if (c === "\\") esc = true;
        else if (c === '"') inStr = false;
      } else if (c === '"') inStr = true;
      else if (c === "[") depth++;
      else if (c === "]" && --depth === 0) {
        tryPush(text.slice(i, j + 1));
        break;
      }
    }
  }

  // A findings array is an array of objects (possibly empty). Prefer those; among ties,
  // take the longest. Reject arrays of non-objects (stray string arrays from prose).
  const isObjectArray = (a) =>
    a.every((x) => x && typeof x === "object" && !Array.isArray(x));
  const objectArrays = candidates.filter(isObjectArray);
  if (objectArrays.length > 0) {
    return objectArrays.reduce(
      (best, a) => (a.length > best.length ? a : best),
      objectArrays[0],
    );
  }

  // No array found. Recover lone finding object(s) emitted without the array wrapper.
  // Only objects with a `message` count as findings — incidental JSON-ish prose objects
  // (e.g. `{"retries": 3}`) must still yield null, not a phantom finding.
  const looseFindings = extractObjects(text).filter(
    (o) => typeof o.message === "string" && o.message.trim(),
  );
  return looseFindings.length ? looseFindings : null;
}

/**
 * RA-1 last resort: a specialist replied with substantive prose but no findings array *or*
 * lone finding object the parsers above could recover (e.g. a paragraph describing one issue,
 * which is exactly how `test-auditor` reported the Roadie `downloadArt` gap on 2026-07-13).
 * `extractJsonArray` returns null for that, and the orchestrator would otherwise drop the whole
 * review silently. Instead, surface the prose as a single **info** finding so the reviewer's
 * substance still reaches the human. Returns a one-element raw findings array, or null for an
 * empty/trivial reply (so a genuinely blank response stays "no findings", not a phantom one).
 */
export function salvageProse(text, { maxLen = 500 } = {}) {
  if (!text) return null;
  // Drop code fences and collapse whitespace so the surfaced message prints on one line.
  const clean = text.replace(/```/g, " ").replace(/\s+/g, " ").trim();
  // Require real sentence-like content: enough length and an actual word. Blank/garbage → null.
  if (clean.length < 40 || !/[a-z]{3}/i.test(clean)) return null;
  const snippet =
    clean.length > maxLen ? `${clean.slice(0, maxLen)} […]` : clean;
  return [
    {
      severity: "info",
      file: "(unparsed)",
      line: null,
      message: `Specialist replied in prose, not the JSON findings contract — review manually: ${snippet}`,
    },
  ];
}

/** Every balanced top-level `{...}` span that parses as a JSON object (string-aware). */
function extractObjects(text) {
  const objs = [];
  let i = 0;
  while (i < text.length) {
    if (text[i] !== "{") {
      i++;
      continue;
    }
    let depth = 0;
    let inStr = false;
    let esc = false;
    let end = -1;
    for (let j = i; j < text.length; j++) {
      const c = text[j];
      if (inStr) {
        if (esc) esc = false;
        else if (c === "\\") esc = true;
        else if (c === '"') inStr = false;
      } else if (c === '"') inStr = true;
      else if (c === "{") depth++;
      else if (c === "}" && --depth === 0) {
        end = j;
        break;
      }
    }
    if (end === -1) break; // unbalanced — stop
    try {
      const v = JSON.parse(text.slice(i, end + 1));
      if (v && typeof v === "object" && !Array.isArray(v)) objs.push(v);
    } catch {
      /* not JSON — ignore */
    }
    i = end + 1; // skip past this span so nested braces aren't re-captured
  }
  return objs;
}

/** Normalize + tag raw model findings for one specialist. Drops malformed entries. */
export function normalizeFindings(raw, { specialist, blocking }) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((f) => f && typeof f.message === "string" && f.message.trim())
    .map((f) => ({
      specialist,
      // A blocking-capable specialist may still emit informational findings; only
      // findings it explicitly marks "blocking" gate the push.
      severity: blocking && f.severity === "blocking" ? "blocking" : "info",
      file: typeof f.file === "string" ? f.file : "(unknown)",
      line: Number.isInteger(f.line) ? f.line : null,
      message: f.message.trim(),
      ...(typeof f.suggestion === "string" && f.suggestion.trim()
        ? { suggestion: f.suggestion.trim() }
        : {}),
    }));
}

/** Dedupe by file+line+message (keeps a blocking duplicate over an info one). */
export function dedupe(findings) {
  const byKey = new Map();
  for (const f of findings) {
    const key = `${f.file}:${f.line}:${f.message}`;
    const existing = byKey.get(key);
    if (
      !existing ||
      (f.severity === "blocking" && existing.severity !== "blocking")
    ) {
      byKey.set(key, f);
    }
  }
  return [...byKey.values()];
}
