// The Discogs collection sweep's progress slide-over (issue #234). Mounted app-wide, like the
// palette sweep it shares its frame with (JobProgress.tsx): a first sync of a real collection runs
// for minutes and hands hours of work to Roadie, and nobody is going to sit on the Add album screen
// watching it.
import {
  useDiscogsSyncJob,
  cancelDiscogsSync,
  dismissDiscogsSync,
} from "../discogsSyncJob";
import type { DiscogsSyncOutcome, DiscogsSyncReport } from "../api";
import { JobProgress } from "./JobProgress";

const OUTCOME_LABEL: Record<DiscogsSyncOutcome["status"], string> = {
  added: "Added",
  duplicate: "Already here",
  collision: "Already owned",
  failed: "Failed",
};

/** Colour is never the only channel (curator-ui-ux §3.4) — each row carries its own word above. */
const OUTCOME_TONE: Record<DiscogsSyncOutcome["status"], string> = {
  added: "ok",
  duplicate: "off",
  // Not "bad" — nothing failed, and nothing was lost. It is a record you own twice, waiting on a
  // decision only you can make, so it reads as something to look at rather than something broken.
  collision: "warn",
  failed: "bad",
};

/** Why a sweep stopped early, in words. `truncated` alone doesn't tell you whether to worry. */
const TRUNCATED_NOTE: Record<
  NonNullable<DiscogsSyncReport["truncatedReason"]>,
  string
> = {
  cancelled: "Stopped early — run it again to pick up the rest.",
  page_cap: "Stopped at the page limit — run it again to pick up the rest.",
  fetch_failed:
    "Discogs stopped answering partway through — run it again to pick up the rest.",
};

function Row({ item }: { item: DiscogsSyncOutcome }) {
  return (
    <li className={`batch__row batch__row--${OUTCOME_TONE[item.status]}`}>
      <span className="batch__label">{item.label}</span>
      <span className="batch__outcome">{OUTCOME_LABEL[item.status]}</span>
      {item.error && <em className="batch__error">{item.error}</em>}
    </li>
  );
}

export function DiscogsSyncProgress() {
  const state = useDiscogsSyncJob();
  const { job } = state;
  const report = job?.result?.discogsSync;

  const summary =
    job?.status === "failed"
      ? (job.error ?? "The sync failed.")
      : report
        ? `${report.added} added · ${report.duplicate} already here` +
          // Surfaced in the summary, not only in the rows: the whole reason 15 duplicates went
          // unnoticed for a day is that the sweep reported them as ordinary adds (#279).
          (report.collision > 0
            ? ` · ${report.collision} already owned from elsewhere`
            : "") +
          (report.failed > 0 ? ` · ${report.failed} failed` : "") +
          (report.truncated && report.truncatedReason
            ? ` — ${TRUNCATED_NOTE[report.truncatedReason]}`
            : "")
        : job?.status === "cancelled"
          ? "Stopped. Records already added are queued with Roadie."
          : "Finished.";

  // Only the interesting rows. A first sync of a real collection is hundreds of "Added" lines, and a
  // refresh is hundreds of "Already here" — neither is worth scrolling. What you want to see is what
  // is new, and what went wrong.
  const rows = report?.items.filter((i) => i.status !== "duplicate") ?? [];

  return (
    <JobProgress
      {...state}
      heading="Syncing your Discogs collection"
      unit="records"
      dismissLabel="Dismiss collection sync progress"
      summary={summary}
      onCancel={cancelDiscogsSync}
      onDismiss={dismissDiscogsSync}
      rows={
        rows.length > 0 ? (
          <ul className="batch__rows">
            {rows.map((item) => (
              <Row key={item.releaseId} item={item} />
            ))}
          </ul>
        ) : undefined
      }
    />
  );
}
