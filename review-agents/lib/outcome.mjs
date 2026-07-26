// What a review run actually concluded — separated from the printing so it can be tested (issue
// #116 / KNOWN-ISSUES RA-3).
//
// The bug this exists to prevent: a specialist that never produced a verdict was counted the same
// as one that reviewed the diff and found nothing. A run where `runtime` and `spec-adherence` both
// timed out still printed "No findings 🎵" and "0 blocking" — the harness asserting something it
// did not know. For a gate that a human trusts instead of re-reviewing, that is worse than no gate.

/** Statuses that mean "this specialist produced no usable verdict", as opposed to "found nothing". */
const NO_VERDICT = new Set(["unavailable", "error"]);

/**
 * Decide a run's outcome from the per-specialist summaries and the deduped findings.
 *
 * `silent` lists the **blocking** specialists that returned no verdict. Non-blocking ones are
 * reported but don't gate: the same rule findings already follow, applied to absence.
 *
 * @returns {{ blocking: object[], silent: {id: string, status: string, reason?: string}[], clean: boolean }}
 *   `clean` is true only when there is nothing to act on *and* every blocking specialist actually
 *   reviewed the diff — the one condition under which "no findings" is an honest thing to say.
 */
export function summarizeRun(runs = [], findings = []) {
  const blocking = findings.filter((f) => f.severity === "blocking");
  const silent = runs
    .filter((r) => r.blocking && NO_VERDICT.has(r.status))
    .map(({ id, status, reason }) => ({
      id,
      status,
      ...(reason ? { reason } : {}),
    }));
  return { blocking, silent, clean: !blocking.length && !silent.length };
}

/** Human-readable reason a run can't be called clean. Empty when nothing is silent. */
export function silentWarning(silent = []) {
  if (!silent.length) return "";
  const names = silent.map((s) => s.id).join(", ");
  return (
    `${silent.length} blocking specialist(s) produced no verdict: ${names}.\n` +
    "This run did NOT review those dimensions — treat it as incomplete, not as a pass.\n" +
    "A timeout is usually the cause; raise that specialist's `timeoutMs` in its config.json."
  );
}
