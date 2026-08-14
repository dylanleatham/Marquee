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
/**
 * Fold a specialist's N sampled runs into the single result the report and the gate see.
 *
 * The findings are **unioned**, not voted on: at a measured 33–50% detection per run, a majority
 * would throw away exactly the findings this exists to recover — one run noticing the bug is the
 * whole point (ADR 0088). `dedupe` collapses the overlap and keeps a blocking duplicate over an
 * info one, so a finding raised once as blocking still blocks.
 *
 * A specialist counts as having run if *any* sample did. All samples failing is `unavailable`,
 * which is what RA-3 gates on — a dimension that produced no verdict is a hole in the review, and
 * sampling must not turn that into a quiet pass just because one attempt of three came back empty.
 */
export function foldSamples(id, blocking, samples, dedupe) {
  const usable = samples.filter(
    (s) => s.status === "ran" || s.status === "no-findings",
  );
  const durationMs = samples.reduce((n, s) => n + (s.durationMs ?? 0), 0);
  if (!usable.length) {
    return {
      ...samples[0],
      id,
      blocking,
      durationMs,
      samples: samples.length,
      findings: [],
    };
  }
  const findings = dedupe(usable.flatMap((s) => s.findings));
  return {
    id,
    blocking,
    status: findings.length ? "ran" : "no-findings",
    repaired: samples.some((s) => s.repaired),
    unformattedSamples: samples.filter((s) => s.status === "unformatted")
      .length,
    failedSamples: samples.length - usable.length,
    samples: samples.length,
    durationMs,
    findings,
  };
}

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
