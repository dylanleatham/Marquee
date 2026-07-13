// Exponential backoff with jitter (roadie-spec §8). Short first try so a WiFi hiccup resolves in
// seconds; long tail so a Spotify outage doesn't get hammered. After the schedule is exhausted the
// worker gives up (→ errored) — capping total attempts, per the "retry storms" gotcha (§15).

/** Base delays in ms for retry attempts 1..4. `maxRetries` = schedule length. */
export const BACKOFF_MS = [1000, 4000, 15000, 60000] as const;

export const maxRetries = BACKOFF_MS.length;

/**
 * Delay before the given retry attempt (1-indexed), with ±25% jitter so parallel retries don't
 * synchronize. Returns 0 for attempts past the schedule (caller should stop retrying by then).
 */
export function backoffDelay(
  attempt: number,
  rand: () => number = Math.random,
): number {
  const base = BACKOFF_MS[attempt - 1];
  if (base === undefined) return 0;
  const jitter = base * 0.25 * (rand() * 2 - 1);
  return Math.max(0, Math.round(base + jitter));
}

/** Real timer; injectable so tests run with fake time (a full suite completes in <1s). */
export const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));
