// The auto-sync poller (issue #234 / ADR 0051). Timers are injected, so scheduling is asserted
// directly rather than waited for.
import { describe, it, expect, vi } from "vitest";
import {
  DiscogsPoller,
  MIN_POLL_INTERVAL_MS,
  DEFAULT_POLL_INTERVAL_MS,
} from "../src/discogs/poller.js";
import type { GenerationJob } from "../src/jobs/manager.js";

const job = (id = "job-1"): GenerationJob => ({
  id,
  kind: "discogsSync",
  status: "running",
  progress: { done: 0, total: 0 },
  createdAt: "2026-08-03T00:00:00.000Z",
  updatedAt: "2026-08-03T00:00:00.000Z",
});

/** Injected timers that expose the scheduled callback so a tick can be fired on demand. */
function fakeTimers() {
  const scheduled: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
  return {
    scheduled,
    fire: (i = 0) => scheduled[i]!.fn(),
    timers: {
      set(fn: () => void, ms: number) {
        scheduled.push({ fn, ms, cleared: false });
        return scheduled.length - 1;
      },
      clear(handle: unknown) {
        const entry = scheduled[handle as number];
        if (entry) entry.cleared = true;
      },
    },
  };
}

const build = (
  opts: Partial<ConstructorParameters<typeof DiscogsPoller>[0]> = {},
) => {
  const t = fakeTimers();
  const trigger = vi.fn(() => job());
  const poller = new DiscogsPoller({
    trigger,
    enabled: true,
    timers: t.timers,
    now: () => "2026-08-03T12:00:00.000Z",
    ...opts,
  });
  return { poller, trigger, ...t };
};

describe("DiscogsPoller", () => {
  it("schedules at the configured interval once started", () => {
    const { poller, scheduled } = build({ intervalMs: 30 * 60_000 });
    poller.start();
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]!.ms).toBe(30 * 60_000);
  });

  it("defaults to hourly", () => {
    const { poller, scheduled } = build();
    poller.start();
    expect(scheduled[0]!.ms).toBe(DEFAULT_POLL_INTERVAL_MS);
  });

  it("clamps a too-eager interval up to the floor", () => {
    // Each tick walks the whole collection against a 60/min budget Roadie also draws on; polling
    // every 10 seconds would spend the rate limit the actual work needs.
    const { poller, scheduled } = build({ intervalMs: 10_000 });
    poller.start();
    expect(poller.intervalMs).toBe(MIN_POLL_INTERVAL_MS);
    expect(scheduled[0]!.ms).toBe(MIN_POLL_INTERVAL_MS);
  });

  it("does nothing at all when disabled", () => {
    const { poller, scheduled, trigger } = build({ enabled: false });
    poller.start();
    expect(scheduled).toHaveLength(0);
    expect(trigger).not.toHaveBeenCalled();
  });

  it("does not sweep on boot — the first sweep is a tick away", () => {
    // A restart (deploy, crash, closing the desktop app) must not each spend a full collection walk.
    const { poller, trigger } = build();
    poller.start();
    expect(trigger).not.toHaveBeenCalled();
  });

  it("starting twice keeps one timer, so stop really stops", () => {
    const { poller, scheduled } = build();
    poller.start();
    poller.start();
    expect(scheduled).toHaveLength(1);
    poller.stop();
    expect(scheduled[0]!.cleared).toBe(true);
  });

  it("stop is safe on a poller that never started", () => {
    const { poller } = build();
    expect(() => poller.stop()).not.toThrow();
  });

  it("a tick starts a sweep and records it", () => {
    const { poller, trigger, fire } = build();
    poller.start();
    fire();

    expect(trigger).toHaveBeenCalledTimes(1);
    expect(poller.status()).toMatchObject({
      enabled: true,
      lastRunAt: "2026-08-03T12:00:00.000Z",
      lastJobId: "job-1",
      lastError: null,
    });
  });

  it("survives a trigger that throws, and keeps the schedule", () => {
    // An unreachable Discogs must not throw out of a timer callback — unhandled, that takes the
    // process down — and must not end the schedule.
    const trigger = vi.fn(() => {
      throw new Error("Discogs unreachable");
    });
    const { poller, fire, scheduled } = build({ trigger });
    poller.start();

    expect(() => fire()).not.toThrow();
    expect(poller.status().lastError).toMatch(/unreachable/);
    expect(poller.status().lastJobId).toBeNull();
    expect(scheduled[0]!.cleared).toBe(false);

    // The next tick tries again.
    expect(() => fire()).not.toThrow();
    expect(trigger).toHaveBeenCalledTimes(2);
  });

  it("records a tick that couldn't run because Discogs isn't configured", () => {
    const { poller, fire } = build({ trigger: vi.fn(() => undefined) });
    poller.start();
    fire();
    expect(poller.status()).toMatchObject({
      lastJobId: null,
      lastError: "Discogs is not configured",
    });
  });

  it("reconfigure applies a new schedule without a restart", () => {
    const { poller, scheduled } = build({ enabled: false });
    poller.start();
    expect(scheduled).toHaveLength(0);

    poller.reconfigure({ enabled: true, intervalMs: 15 * 60_000 });

    expect(poller.enabled).toBe(true);
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]!.ms).toBe(15 * 60_000);
  });

  it("reconfigure clears the old timer, so an interval change can't leave two running", () => {
    const { poller, scheduled } = build({ intervalMs: 60 * 60_000 });
    poller.start();
    poller.reconfigure({ enabled: true, intervalMs: 20 * 60_000 });

    expect(scheduled[0]!.cleared).toBe(true);
    expect(scheduled[1]!.cleared).toBe(false);
    expect(scheduled).toHaveLength(2);
  });

  it("reconfigure to off stops polling", () => {
    const { poller, scheduled, trigger } = build();
    poller.start();
    poller.reconfigure({ enabled: false });

    expect(scheduled[0]!.cleared).toBe(true);
    expect(scheduled).toHaveLength(1);
    expect(poller.enabled).toBe(false);
    expect(trigger).not.toHaveBeenCalled();
  });
});
