// The visualizer transfer to Backdrop, while it happens (issue #177).
//
// Attaching a video used to hold the request open for the whole transfer — ~90 minutes on the link
// this was built against — with nothing on screen. ADR 0038 says a slow network must not read as a
// broken feature; that only holds if the slowness is visible, so this is the honest part of it.
//
// It reattaches by polling the album's jobs rather than being handed an id, so a reload (or arriving
// on the page while a transfer from an earlier session is still running) still shows it.
import { useEffect, useRef, useState } from "react";
import { api, type GenerationJob } from "../api";
import { AsyncButton } from "./common";

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

const humanEta = (s: number): string =>
  s < 60
    ? `about ${s}s left`
    : s < 3600
      ? `about ${Math.round(s / 60)} min left`
      : `about ${(s / 3600).toFixed(1)} h left`;

/**
 * Watch the album's media-transfer job, reattaching by polling rather than being handed an id — so a
 * reload, or arriving while a transfer from an earlier session runs, still finds it.
 *
 * Kept as a hook so the component stays presentational, matching `useGenerationJob` and
 * `useBatchJob`. Polling continues after a terminal status (slowly): the component never remounts,
 * so stopping would mean a second video attached on the same page showed no progress at all.
 */
export function useMediaTransferJob(curatorId: string): {
  job: GenerationJob | null;
  startedAt: number | null;
} {
  const [job, setJob] = useState<GenerationJob | null>(null);
  const startedAt = useRef<number | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    let live = true;
    const tick = async () => {
      try {
        const { jobs } = await api.albumJobs(curatorId, "mediaTransfer");
        const latest = jobs[0] ?? null;
        if (!live) return;
        setJob(latest);
        if (latest?.status === "running") {
          startedAt.current ??= Date.now();
          timer.current = setTimeout(tick, 1000);
        } else {
          startedAt.current = null;
          timer.current = setTimeout(tick, 5000);
        }
      } catch {
        // A transfer panel must never be the thing that breaks the page; try again next tick.
        if (live) timer.current = setTimeout(tick, 3000);
      }
    };
    void tick();
    return () => {
      live = false;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [curatorId]);

  return { job, startedAt: startedAt.current };
}

export function MediaTransfer({ curatorId }: { curatorId: string }) {
  const { job, startedAt } = useMediaTransferJob(curatorId);

  // Nothing to say unless a transfer is running or the last one failed — a quiet success needs no UI.
  if (!job) return null;
  if (job.status === "done" || job.status === "cancelled") return null;

  if (job.status === "failed") {
    return (
      <p className="transfer transfer--failed" role="status">
        <strong>Video didn’t reach Backdrop.</strong> {job.error}
        <em> The album’s lights still work; the screen will stay idle.</em>
      </p>
    );
  }

  const { done, total } = job.progress;
  const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
  const eta = startedAt
    ? etaSeconds(done, total, Date.now() - startedAt)
    : null;

  return (
    <div className="transfer" role="status" aria-live="polite">
      <div className="transfer__head">
        {/* Never percentage-bar alone (curator-ui-ux §3.4): the numbers carry it too. */}
        <span className="transfer__label">
          Sending video to Backdrop — {pct}% ({formatBytes(done)} of{" "}
          {formatBytes(total)})
        </span>
        <AsyncButton
          className="transfer__cancel"
          onClick={() => api.cancelJob(job.id)}
        >
          Stop
        </AsyncButton>
      </div>
      <div className="transfer__bar" aria-hidden="true">
        <span className="transfer__fill" style={{ width: `${pct}%` }} />
      </div>
      <em className="transfer__note">
        {eta === null ? "Working out how long this will take…" : humanEta(eta)}{" "}
        You can keep working — this runs in the background.
      </em>
    </div>
  );
}
