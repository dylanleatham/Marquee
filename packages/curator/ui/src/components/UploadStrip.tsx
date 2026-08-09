import type { UploadInFlight } from "../hooks";
import { etaSeconds, formatBytes, humanEta } from "../transfer";

/**
 * A file on its way from the browser to Curator (issue #284).
 *
 * The record page already reports the *second* leg of this journey — Curator to Backdrop — in
 * percent, bytes and an ETA, because a transfer that says nothing makes success and failure look
 * identical ([ADR 0038](../../../../../docs/adrs/0038-curator-pushes-media-over-http.md)). The first leg
 * said nothing at all: pick a 240 MB loop and the panel kept reading "No visualizer yet" until the
 * server answered, which reads as a press that missed. Same transfer, same silence, so it gets the
 * same strip and the same `.bdstrip` chrome rather than a second idiom for one screen.
 *
 * Never the bar alone (curator-ui-ux §3.4) — the words and the numbers carry it, and the bar is
 * `aria-hidden` decoration on top.
 */
export function UploadStrip({
  upload,
  className,
}: {
  upload: UploadInFlight | null;
  /** For a caller whose layout needs it — the card grid places this across all its columns. */
  className?: string;
}) {
  if (!upload) return null;
  const { name, sent, total, startedAt } = upload;

  const pct = total > 0 ? Math.min(100, Math.round((sent / total) * 100)) : 0;
  /**
   * Every byte is out and the server has not answered yet: it is probing the file and copying it
   * into place. Against a local Curator that is most of the wait, and a bar parked at 100% for it
   * reads as a stall — so the strip says who is working instead of repeating a number.
   */
  const landed = total > 0 && sent >= total;
  const eta = landed ? null : etaSeconds(sent, total, Date.now() - startedAt);

  return (
    <p
      className={`bdstrip${className ? ` ${className}` : ""}`}
      role="status"
      aria-live="polite"
    >
      <span className="pp-dot pp-dot--pulse" aria-hidden="true" />
      <span className="bdstrip__text">
        {landed
          ? `Adding ${name} to the record…`
          : total > 0
            ? `Sending ${name} — ${pct}% (${formatBytes(sent)} of ${formatBytes(total)})${
                eta === null ? "" : ` · ${humanEta(eta)}`
              }`
            : /* No length to report — a percentage against nothing would be invented. */
              `Sending ${name}…`}
      </span>
      {total > 0 && (
        <span className="bdstrip__bar" aria-hidden="true">
          <span className="bdstrip__fill" style={{ width: `${pct}%` }} />
        </span>
      )}
    </p>
  );
}
