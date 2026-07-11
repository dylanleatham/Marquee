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
  if (objectArrays.length === 0) return null;
  return objectArrays.reduce(
    (best, a) => (a.length > best.length ? a : best),
    objectArrays[0],
  );
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
