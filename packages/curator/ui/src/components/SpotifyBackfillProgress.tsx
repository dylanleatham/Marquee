// The Spotify-identity backfill's progress slide-over (ADR 0059). Mounted app-wide, in the same
// frame as the palette and Discogs sweeps (JobProgress.tsx): it is one Spotify search per unmatched
// album, so a real Discogs-swept collection runs for minutes and nobody will sit on Settings for it.
import {
  useSpotifyBackfillJob,
  cancelSpotifyBackfill,
  dismissSpotifyBackfill,
} from "../spotifyBackfillJob";
import type {
  ReportedSpotifyBackfillStatus,
  SpotifyBackfillReport,
} from "../api";
import { Link } from "react-router-dom";
import { JobProgress } from "./JobProgress";

type Item = SpotifyBackfillReport["items"][number];

/**
 * Typed against the status union rather than `string`, matching the sibling panels: a new outcome on
 * the server then fails to compile here instead of rendering its raw enum name at someone.
 */
const OUTCOME_LABEL: Record<ReportedSpotifyBackfillStatus, string> = {
  matched: "Can play",
  art_only: "Near match — won't play",
  no_match: "Not found",
  ambiguous: "Several albums share this title — pick it on the record",
  failed: "Failed",
};

/** Colour is never the only channel (curator-ui-ux §3.4) — each row carries its own word above. */
const OUTCOME_TONE: Record<ReportedSpotifyBackfillStatus, string> = {
  matched: "ok",
  art_only: "off",
  no_match: "off",
  // Not "bad": nothing went wrong. The sweep did its job and the answer needs a person — the label
  // above carries that, since colour is never the only channel (curator-ui-ux §3.4).
  ambiguous: "off",
  failed: "bad",
};

function Row({
  item,
}: {
  item: Item & { status: ReportedSpotifyBackfillStatus };
}) {
  return (
    <li className={`batch__row batch__row--${OUTCOME_TONE[item.status]}`}>
      {/* The one outcome with somewhere to go. A sweep over hundreds of records that reports "6
          need you to pick" and then makes you find those six by hand is the same dead end #289 was
          about — so the row *is* the way there, straight to the panel that holds the picker. */}
      {item.status === "ambiguous" ? (
        <Link className="batch__label" to={`/albums/${item.curatorId}/demo`}>
          {item.label}
        </Link>
      ) : (
        <span className="batch__label">{item.label}</span>
      )}
      <span className="batch__outcome">{OUTCOME_LABEL[item.status]}</span>
      {/* What it matched to, so a wrong guess is visible here rather than in the room. */}
      {item.matchedTo && <em className="batch__error">→ {item.matchedTo}</em>}
      {item.error && <em className="batch__error">{item.error}</em>}
    </li>
  );
}

export function SpotifyBackfillProgress() {
  const state = useSpotifyBackfillJob();
  const { job } = state;
  const report = job?.result?.spotifyBackfill;

  const summary =
    job?.status === "failed"
      ? (job.error ?? "The match run failed.")
      : report
        ? `${report.matched} can now play · ${report.artOnly} near matches (silent) · ${report.noMatch} not found` +
          // Only when there are any: on a library with no same-titled albums this would be a
          // permanent "0 need you", which reads as a chore rather than the nudge it is.
          (report.ambiguous > 0
            ? ` · ${report.ambiguous} need you to pick (re-running won't help)`
            : "") +
          (report.failed > 0 ? ` · ${report.failed} failed` : "") +
          (report.abandoned
            ? " — stopped early after repeated failures; check Spotify is reachable and run it again."
            : "")
        : job?.status === "cancelled"
          ? "Stopped. Records already matched keep their match."
          : "Finished.";

  // Only the rows worth reading. A real run is mostly skips (albums that already had a URI, or
  // aren't from Discogs), and a wall of those buries the two things you actually want to check:
  // what became playable, and what it guessed at but refused to play.
  const rows = (report?.items ?? []).filter(
    (i): i is Item & { status: ReportedSpotifyBackfillStatus } =>
      !i.status.startsWith("skipped"),
  );

  return (
    <JobProgress
      {...state}
      heading="Matching records to Spotify"
      unit="records"
      dismissLabel="Dismiss Spotify match progress"
      summary={summary}
      onCancel={cancelSpotifyBackfill}
      onDismiss={dismissSpotifyBackfill}
      rows={
        rows.length > 0 ? (
          <ul className="batch__rows">
            {rows.map((item) => (
              <Row key={item.curatorId} item={item} />
            ))}
          </ul>
        ) : undefined
      }
    />
  );
}
