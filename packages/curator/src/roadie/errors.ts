// Roadie's failure taxonomy (roadie-spec §8). Steps throw these; the worker classifies each
// into a state transition: transient → retry with backoff then errored; permanent → needs_manual
// (a real album in an unusual case); config/unexpected → errored (something is broken, fix me).

/** Retryable: network hiccup, Spotify 429/5xx/timeout. Worker backs off and retries. */
export class TransientError extends Error {
  constructor(
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = "TransientError";
  }
}

/**
 * Not retryable, but not "broken": a legitimate album in a case Roadie can't finish on its own
 * (not on Spotify, art URL 404). Parks the album in `needs_manual` with `reason` for the UI.
 */
export class PermanentError extends Error {
  constructor(
    message: string,
    readonly reason: string,
  ) {
    super(message);
    this.name = "PermanentError";
  }
}

/**
 * A system problem: Spotify auth broken, filesystem unwritable, an unexpected bug. No retry;
 * park in `errored` and surface prominently — the human needs to fix the environment, not the album.
 */
export class ConfigError extends Error {
  constructor(
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = "ConfigError";
  }
}
