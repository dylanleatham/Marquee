// The shared chrome for a library sweep's progress slide-over (curator-spec §10).
//
// Every long sweep needs the same frame — a heading that explains itself, a bar, a one-line summary,
// a stop button while it runs, a dismiss once it's done, and an honest "lost contact" banner. What
// differs between sweeps is only the words and the rows, so those are props. Extracted when the
// Discogs collection sync (issue #234) needed a second one of these.
import type { ReactNode } from "react";
import type { LibraryJobState } from "../libraryJob";
import { AsyncButton } from "./common";

export interface JobProgressProps extends LibraryJobState {
  /**
   * What this run is called. Worth saying plainly: the panel can outlive the screen that started it,
   * so it can't rely on surrounding context to explain itself.
   */
  heading: string;
  /** The line under the bar once the job is no longer running and produced a report. */
  summary?: ReactNode;
  /** What "3 of 40" counts — "albums", "records". */
  unit: string;
  /**
   * Accessible name for the ✕. Explicit rather than derived from `heading`, because two of these can
   * be on screen at once and "Dismiss syncing your discogs collection progress" is not a thing to
   * make a screen reader say.
   */
  dismissLabel: string;
  /** Per-item rows, rendered under the summary. */
  rows?: ReactNode;
  onCancel: () => void | Promise<void>;
  onDismiss: () => void;
}

export function JobProgress({
  job,
  error,
  unreachable,
  heading,
  summary,
  unit,
  dismissLabel,
  rows,
  onCancel,
  onDismiss,
}: JobProgressProps) {
  if (!job && !error) return null;

  const running = job?.status === "running";
  const { done, total } = job?.progress ?? { done: 0, total: 0 };
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;

  return (
    <aside
      className="batch"
      role="status"
      aria-live="polite"
      aria-label={heading}
    >
      <div className="batch__head">
        <h2>{heading}</h2>
        {!running && (
          <button
            className="btn btn--ghost btn--small"
            onClick={onDismiss}
            aria-label={dismissLabel}
          >
            ✕
          </button>
        )}
      </div>

      {error && <div className="banner banner--error">{error}</div>}

      {/* Degraded, not fatal (curator-ui-ux §10). The sweep is still running on the server; what's
          lost is our view of it. Saying so beats a bar that silently stops moving, which reads as a
          stalled sweep rather than a stalled connection. */}
      {unreachable && (
        <div className="banner banner--warn">
          Lost contact with Curator — the sweep is probably still running. Still
          retrying, less often.
        </div>
      )}

      {job && (
        <>
          <div
            className="batch__bar"
            role="progressbar"
            aria-valuenow={done}
            aria-valuemin={0}
            aria-valuemax={total}
          >
            <div className="batch__fill" style={{ width: `${pct}%` }} />
          </div>
          <p className="batch__count">
            {running ? `${done} of ${total} ${unit}` : summary}
          </p>
        </>
      )}

      {running && (
        <AsyncButton
          className="btn btn--ghost"
          onClick={onCancel}
          pendingLabel="Stopping…"
        >
          Stop
        </AsyncButton>
      )}

      {rows}
    </aside>
  );
}
