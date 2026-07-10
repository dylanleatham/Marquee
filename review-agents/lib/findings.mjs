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

/** Pull a JSON array out of a model reply — tolerant of prose or ```json fences around it. */
export function extractJsonArray(text) {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [];
  if (fenced) candidates.push(fenced[1]);
  const first = text.indexOf("[");
  const last = text.lastIndexOf("]");
  if (first !== -1 && last > first)
    candidates.push(text.slice(first, last + 1));
  for (const c of candidates) {
    try {
      const parsed = JSON.parse(c);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      /* try next candidate */
    }
  }
  return null;
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
