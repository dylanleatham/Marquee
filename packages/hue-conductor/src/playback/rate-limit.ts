// Per-key token bucket. Guards Hue's ~10 commands/sec per light (conductor-spec §9): when a light
// is out of tokens, the caller *drops* that step rather than queuing it — queuing causes drift and
// lag on a bus that's already the bottleneck. The clock is injectable so the bucket is unit-testable
// without real time.

export class RateLimiter {
  private readonly tokens = new Map<string, number>();
  private readonly last = new Map<string, number>();

  constructor(
    /** Sustained commands per second per key. */
    private readonly ratePerSec: number,
    /** Burst size — how many commands can fire back-to-back before throttling. */
    private readonly capacity: number,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Take a token for `key`. Returns false (caller should drop the update) when the bucket is dry. */
  tryTake(key: string): boolean {
    const t = this.now();
    const last = this.last.get(key) ?? t;
    const refill = ((t - last) / 1000) * this.ratePerSec;
    const available = Math.min(
      this.capacity,
      (this.tokens.get(key) ?? this.capacity) + refill,
    );
    this.last.set(key, t);
    if (available < 1) {
      this.tokens.set(key, available);
      return false;
    }
    this.tokens.set(key, available - 1);
    return true;
  }
}
