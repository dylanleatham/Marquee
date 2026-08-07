// A Backdrop transfer, in numbers a person reads (issue #177).
//
// Pure — no React, no DOM. Lifted out of `components/MediaTransfer.tsx` on 2026-08-05 when the
// record's visualizer panel absorbed that component (ADR 0052); the arithmetic outlived the
// component that used to own it.

/** Bytes as something a person reads, since the numbers here run to hundreds of millions. */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const mb = n / (1024 * 1024);
  if (mb < 1) return `${(n / 1024).toFixed(0)} KB`;
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  return `${(mb / 1024).toFixed(2)} GB`;
}

/**
 * A transfer's remaining time, from how fast it has actually been going. Null until there is enough
 * to say — a guess made from two bytes is worse than no guess, because the user will believe it.
 */
export function etaSeconds(
  sentBytes: number,
  totalBytes: number,
  elapsedMs: number,
): number | null {
  if (elapsedMs < 3000 || sentBytes <= 0 || sentBytes >= totalBytes)
    return null;
  const bytesPerMs = sentBytes / elapsedMs;
  if (bytesPerMs <= 0) return null;
  return Math.round((totalBytes - sentBytes) / bytesPerMs / 1000);
}

export const humanEta = (s: number): string =>
  s < 60
    ? `about ${s}s left`
    : s < 3600
      ? `about ${Math.round(s / 60)} min left`
      : `about ${(s / 3600).toFixed(1)} h left`;
