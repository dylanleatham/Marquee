// The arithmetic behind a Backdrop transfer's progress line (issue #177).
//
// The `MediaTransfer` component's own cases went with it on 2026-08-05 — the record's visualizer
// panel absorbed it (ADR 0052) and has its own tests. These two outlived it because they are about
// the numbers, not the markup.
import { describe, it, expect } from "vitest";
import { formatBytes, etaSeconds } from "./transfer";

describe("formatBytes", () => {
  it("scales so the number stays readable", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(64 * 1024)).toBe("64 KB");
    expect(formatBytes(239_449_861)).toBe("228.4 MB");
    expect(formatBytes(3 * 1024 * 1024 * 1024)).toBe("3.00 GB");
  });
});

describe("etaSeconds", () => {
  /**
   * An estimate from almost no data is worse than none: the user believes it, and a wrong "2 minutes
   * left" on a 90-minute transfer is how a feature loses trust.
   */
  it("says nothing until there is enough to go on", () => {
    expect(etaSeconds(1000, 1_000_000, 500)).toBeNull(); // too early
    expect(etaSeconds(0, 1_000_000, 10_000)).toBeNull(); // nothing sent yet
    expect(etaSeconds(1_000_000, 1_000_000, 10_000)).toBeNull(); // already done
  });

  it("extrapolates from the rate actually achieved", () => {
    // 1 MB in 10s → 9 MB left at 0.1 MB/s → 90s.
    expect(etaSeconds(1_000_000, 10_000_000, 10_000)).toBe(90);
  });
});
