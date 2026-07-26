// The specialist prompt: the system prompt, the diff, and the output contract — in that order.
//
// Extracted from the orchestrator for issue #117 so the one thing that actually fixes RA-4 — where
// the contract sits — is pinned by a test rather than left to survive the next edit by luck.

export const OUTPUT_CONTRACT = `
# Output contract (STRICT)
Respond with ONLY a JSON array of findings — no prose, and no markdown fences, before or after.
The response MUST be a JSON array even for a single finding — wrap it as [ { ... } ], never a bare object.
Each element of the array is one finding object:
{ "severity": "blocking" | "info", "file": "<repo-relative path>", "line": <int or null>, "message": "<one sentence>", "suggestion": "<optional fix>" }
Emit "blocking" ONLY for issues your role is defined to block on. When in doubt, use "info".
Signal over volume — a false positive costs the reader's trust. Prefer fewer, high-confidence findings.

Two findings look exactly like this, and nothing else:
[
  { "severity": "blocking", "file": "packages/curator/src/server.ts", "line": 412, "message": "The upload handler has no timeout, so a stalled client wedges the event loop.", "suggestion": "Wrap the read in AbortSignal.timeout(5000)." },
  { "severity": "info", "file": "packages/curator/ui/src/api.ts", "line": null, "message": "addAlbumsBatch duplicates the error shaping in addSpotify." }
]

**Finding nothing is the common case, and it has a shape too.** Do not explain that you found
nothing, do not summarise what you checked, do not congratulate the change. Respond with exactly:
[]`;

/**
 * The contract goes **last**, after the diff (issue #117 / KNOWN-ISSUES RA-4).
 *
 * It used to sit before the review context, which on a 20-file diff put thousands of tokens between
 * "reply with JSON only" and the moment of replying — and the specialists reliably drifted into
 * prose. Nearly every real finding this harness has produced arrived as a paragraph, which
 * `salvageProse` can only surface as one unstructured **info** finding, so a blocking issue written
 * in prose could not block. Restating the contract adjacent to generation is the cheap half of the
 * fix; `repairPrompt` below is the backstop.
 */
export function composePrompt(config, context) {
  return [
    config.systemPrompt,
    config.examples ? `\n# Examples\n${config.examples}` : "",
    `\n# Review this change\n${context}`,
    OUTPUT_CONTRACT,
  ].join("\n");
}

/**
 * Ask once for the same verdict in the required shape, before falling back to salvaging prose.
 *
 * Deliberately a *translation* task, not a re-review: the specialist already did the thinking, and a
 * second opinion here would be a different reviewer's answer smuggled in under the first one's name.
 * It carries no diff, so it is cheap and fast.
 */
export function repairPrompt(text) {
  return [
    "Your previous reply to a code review was prose, not the JSON findings array the contract requires.",
    "Convert it verbatim into the array: the same findings, the same severities, none added, none dropped.",
    "If it reported nothing worth acting on, the answer is exactly [].",
    OUTPUT_CONTRACT,
    "\n# Your previous reply\n" + text,
  ].join("\n");
}
