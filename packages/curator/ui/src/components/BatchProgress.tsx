// The palette sweep's progress slide-over (curator-spec §10, issue #104): what's running, how far
// it's got, and a way to stop it. Mounted app-wide rather than inside Settings, so a sweep survives
// navigating away — see batchJob.ts. Fed by polling `/api/jobs/:id`, not an event stream (ADR 0029).
// The frame is shared with the Discogs collection sync — see JobProgress.tsx.
import { useBatchJob, cancelBatch, dismissBatch } from "../batchJob";
import type { BatchPaletteOutcome, BatchPaletteStatus } from "../api";
import { JobProgress } from "./JobProgress";

/** Every skip reason gets its own words: "skipped" alone tells you nothing about whether to worry. */
const OUTCOME_LABEL: Record<BatchPaletteStatus, string> = {
  regenerated: "Regenerated",
  skipped_hand_edited: "Skipped — hand-edited",
  skipped_processing: "Skipped — still processing",
  skipped_no_art: "Skipped — no cover art",
  failed: "Failed",
};

/** Colour is never the only channel (curator-ui-ux §3.4) — each row carries its own word above. */
const OUTCOME_TONE: Record<BatchPaletteStatus, string> = {
  regenerated: "ok",
  skipped_hand_edited: "off",
  skipped_processing: "off",
  skipped_no_art: "off",
  failed: "bad",
};

function Row({ item }: { item: BatchPaletteOutcome }) {
  return (
    <li className={`batch__row batch__row--${OUTCOME_TONE[item.status]}`}>
      <span className="batch__label">{item.label}</span>
      <span className="batch__outcome">{OUTCOME_LABEL[item.status]}</span>
      {item.error && <em className="batch__error">{item.error}</em>}
    </li>
  );
}

export function BatchProgress() {
  const state = useBatchJob();
  const { job } = state;
  const { done, total } = job?.progress ?? { done: 0, total: 0 };
  const report = job?.result?.paletteBatch;

  const summary =
    job?.status === "cancelled"
      ? `Cancelled after ${done} of ${total} — the palettes already regenerated are saved.`
      : job?.status === "failed"
        ? (job.error ?? "The run failed.")
        : report
          ? `${report.regenerated} regenerated · ${report.skipped} skipped · ${report.failed} failed`
          : "Finished.";

  return (
    <JobProgress
      {...state}
      heading="Regenerating palettes"
      unit="albums"
      dismissLabel="Dismiss batch progress"
      summary={summary}
      onCancel={cancelBatch}
      onDismiss={dismissBatch}
      rows={
        report && report.items.length > 0 ? (
          <ul className="batch__rows">
            {report.items.map((item) => (
              <Row key={item.curatorId} item={item} />
            ))}
          </ul>
        ) : undefined
      }
    />
  );
}
