import { useRef, useState } from "react";
import { api, videoUrl, type AlbumAsset, type PaletteColor } from "../api";
import { useGenerationJob, useMediaTransferJob } from "../hooks";
import { etaSeconds, formatBytes, humanEta } from "../transfer";
import { AsyncButton, pickFile } from "./common";
import type { Run } from "../run";

/**
 * The visualizer panel (ADR 0052).
 *
 * Changes from the old Video workstation:
 *
 * - **The clip plays here**, looping, washed in the record's own lights — which is the only way to
 *   judge whether it belongs to this record rather than merely exists.
 * - **The Backdrop transfer has all three of its states on this page**, including the failure and
 *   its retry. It used to fail silently here and only admit it on the System screen.
 * - **Every drafted prompt is shown and separately copyable.** The old bench showed one, behind a
 *   variant chooser — so the other drafts may as well not have been written.
 * - **No "paste a link".** A URL is not a file, and the one that mattered was always local.
 */

const mmss = (s: number): string =>
  `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

/** The room's wash, as the record page previews it — the same gradient the room itself uses. */
export const paletteWash = (colors: PaletteColor[]): string => {
  const dominant = colors[0]?.hex ?? "#241d16";
  const second = colors[1]?.hex ?? dominant;
  return `radial-gradient(130% 100% at 50% 18%, ${second} 0%, ${dominant} 55%, #0d0a10 100%)`;
};

/**
 * The Backdrop leg, in all three of its states.
 *
 * A visualizer that is attached in Curator but never reached Backdrop plays as a black screen in the
 * room, and the old panel said nothing at all once the transfer stopped — success and failure looked
 * identical, which is the case ADR 0038 exists to prevent.
 */
function BackdropStrip({
  curatorId,
  hasVisualizer,
  run,
}: {
  curatorId: string;
  hasVisualizer: boolean;
  run: Run;
}) {
  const { job, startedAt } = useMediaTransferJob(curatorId);
  if (!hasVisualizer) return null;

  if (job?.status === "running") {
    const { done, total } = job.progress;
    const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
    const eta = startedAt
      ? etaSeconds(done, total, Date.now() - startedAt)
      : null;
    return (
      <p className="bdstrip" role="status" aria-live="polite">
        <span className="pp-dot" aria-hidden="true" />
        {/* Never the bar alone (curator-ui-ux §3.4) — the percentage and the bytes carry it too.
            The ETA comes from how fast it has actually been going, and stays absent until there is
            enough to say: a guess made from two bytes is worse than none, because it is believed. */}
        <span className="bdstrip__text">
          Uploading to Backdrop — {pct}% ({formatBytes(done)} of{" "}
          {formatBytes(total)}){eta === null ? "" : ` · ${humanEta(eta)}`}
        </span>
        <span className="bdstrip__bar" aria-hidden="true">
          <span className="bdstrip__fill" style={{ width: `${pct}%` }} />
        </span>
        {/* An hour-long transfer over a poor link has to be stoppable — losing that with the old
            component would have been a quiet capability regression. */}
        <AsyncButton
          className="pp-action"
          onClick={() => run(() => api.cancelJob(job.id))}
          pendingLabel="STOPPING…"
        >
          STOP
        </AsyncButton>
      </p>
    );
  }

  if (job?.status === "failed")
    return (
      <p className="bdstrip bdstrip--failed" role="status">
        <span className="pp-dot" aria-hidden="true" />
        <span className="bdstrip__text">
          Upload failed — {job.error ?? "Backdrop refused the connection"}. The
          lights still work; the screen will stay idle.
        </span>
        <AsyncButton
          className="pp-action"
          onClick={() => run(() => api.pushAlbum(curatorId))}
          pendingLabel="RETRYING…"
        >
          RETRY
        </AsyncButton>
      </p>
    );

  // Quiet once it lands. A finished transfer is not news, but its absence would be.
  return (
    <p className="bdstrip bdstrip--done">
      <span className="pp-dot pp-dot--positive" aria-hidden="true" />
      <span className="bdstrip__text">on Backdrop</span>
    </p>
  );
}

export function VisualizerPanel({
  curatorId,
  asset,
  refresh,
  run,
  canGenerate,
}: {
  curatorId: string;
  asset: AlbumAsset;
  refresh: () => void;
  run: Run;
  /** Video generation is opt-in and metered (Settings) — off hides the spend, not the drafts. */
  canGenerate: boolean;
}) {
  const [at, setAt] = useState(0);
  const [length, setLength] = useState(0);
  const [copied, setCopied] = useState<number | null>(null);
  const [splicing, setSplicing] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);

  const visualizer = asset.visualizer;
  const drafts = asset.promptDrafts?.video?.variants ?? [];
  const clips = asset.videoClips ?? [];
  const wash = paletteWash(asset.palette?.colors ?? []);

  const upload = (file: File) =>
    run(async () => {
      const form = new FormData();
      form.append("file", file);
      await api.uploadVideo(curatorId, form);
      refresh();
    });

  /**
   * Join every generated clip, in index order, into the one looping visualizer (issue #29).
   *
   * Generation returns *clips*; the record page shows a *visualizer*. Something has to close that
   * gap, and the design has no gallery and no splice step — so "let Roadie make it" means exactly
   * that, end to end.
   */
  const splice = () =>
    run(async () => {
      // Both entry points — the automatic one and the button — go through here, and the button's
      // strip becomes visible the instant the job reports `done`, which is *before* the automatic
      // splice resolves. One flag covers both, so a press in that window can't start a second
      // ffmpeg join over the same clips.
      if (splicing) return;
      setSplicing(true);
      try {
        await api.spliceVisualizer(curatorId);
        refresh();
      } finally {
        setSplicing(false);
      }
    });

  /**
   * Generate a clip per draft, then splice — the button's whole job, not half of it.
   *
   * `onDone` fires when the job reaches `done`, which is the case that matters: a set of clips with
   * nothing attached is invisible on this page, so leaving them unspliced would make the button look
   * like it did nothing. Two cases it deliberately cannot cover — the app was closed while the job
   * ran, or the splice itself failed — are why the strip below exists.
   */
  const gen = useGenerationJob(
    curatorId,
    "video",
    () => api.generateVideoSet(curatorId),
    () => void splice(),
    // Always re-attach, even with generation switched off: a job started before it was turned off
    // must still finish and splice, or its clips are stranded.
    true,
  );

  const copy = (text: string, i: number) =>
    run(async () => {
      await navigator.clipboard.writeText(text);
      setCopied(i);
      // The machine still advances on a copy (ADR 0027); the panel never says so, because "you
      // copied a prompt" is not a thing the user needs telling. A *failure* is, though — so this
      // rejects into `run` like every other action rather than being swallowed here.
      await api.markPromptCopied(curatorId, "video");
    });

  return (
    <div className="viz">
      <div className="viz__main">
        {visualizer ? (
          <div className="viz__stage" style={{ background: wash }}>
            <video
              ref={videoRef}
              className="viz__video"
              /* Keyed on the attached file, so REPLACE actually shows the new clip. Without the
                 token the `src` string never changes and the browser keeps playing the cached one —
                 issue #25's trap, and the reason the card and the covers carry tokens too. */
              src={`${videoUrl(curatorId)}?v=${encodeURIComponent(visualizer.fileId)}`}
              autoPlay
              muted
              loop
              playsInline
              onTimeUpdate={(e) => setAt(e.currentTarget.currentTime)}
              onLoadedMetadata={(e) => setLength(e.currentTarget.duration)}
            />
            <span className="viz__caption">playing · loops seamlessly</span>
            <span className="viz__time">
              {mmss(at)} / {mmss(length || (visualizer.durationSec ?? 0))}
            </span>
            <span className="viz__res">{visualizer.resolution ?? ""}</span>
          </div>
        ) : (
          <button
            type="button"
            className="viz__empty"
            onClick={() => pickFile("video/*", upload)}
          >
            <span className="viz__empty-title">No visualizer yet</span>
            <span>
              Drop a clip in, or copy a draft into your own tool and bring the
              result back.
            </span>
          </button>
        )}

        {/* The two cases auto-splice can't reach: the app was closed while the job ran (the hook
            adopts a finished job without re-firing `onDone`), or the splice failed. Both leave clips
            on disk and nothing attached — invisible on this page without something to say so. */}
        {!visualizer &&
          clips.length > 0 &&
          gen.status !== "running" &&
          !splicing && (
            <p className="bdstrip" role="status">
              <span className="pp-dot" aria-hidden="true" />
              <span className="bdstrip__text">
                Roadie made {clips.length} clip{clips.length === 1 ? "" : "s"}{" "}
                but they aren&apos;t joined up yet.
              </span>
              <AsyncButton
                className="pp-action"
                onClick={splice}
                pendingLabel="JOINING…"
              >
                MAKE THE LOOP
              </AsyncButton>
            </p>
          )}

        {splicing && (
          <p className="bdstrip" role="status" aria-live="polite">
            <span className="pp-dot pp-dot--pulse" aria-hidden="true" />
            <span className="bdstrip__text">
              Joining the clips into a loop…
            </span>
          </p>
        )}

        <BackdropStrip
          curatorId={curatorId}
          hasVisualizer={Boolean(visualizer)}
          run={run}
        />

        <div className="viz__actions">
          {visualizer && (
            <>
              <button
                type="button"
                className="pp-action"
                onClick={() => pickFile("video/*", upload)}
              >
                REPLACE
              </button>
              <AsyncButton
                className="pp-action"
                onClick={() => run(() => api.detachVideo(curatorId))}
                pendingLabel="REMOVING…"
              >
                REMOVE
              </AsyncButton>
            </>
          )}
          <button
            type="button"
            className="pp-action"
            onClick={() => pickFile("video/*", upload)}
          >
            PICK A FILE
          </button>
        </div>
      </div>

      <aside className="drafts">
        <div className="drafts__head">
          <p className="pp-label pp-label--accent">
            ROADIE&apos;S DRAFTS{drafts.length ? ` · ${drafts.length}` : ""}
          </p>
          <p className="drafts__sub">copy one into your own tool</p>
        </div>

        {drafts.length === 0 ? (
          <div className="drafts__empty">
            <p>Roadie hasn&apos;t written any yet.</p>
            <AsyncButton
              className="pp-btn pp-btn--wide"
              onClick={() => run(() => api.draftPrompt(curatorId, "video"))}
              pendingLabel="WRITING…"
            >
              DRAFT THEM
            </AsyncButton>
          </div>
        ) : (
          <ol className="drafts__list">
            {drafts.map((v, i) => (
              <li className="drafts__item" key={i}>
                <span className="drafts__n">
                  {String(i + 1).padStart(2, "0")}
                </span>
                <span className="drafts__text">{v.text}</span>
                <button
                  type="button"
                  className="drafts__copy"
                  onClick={() => copy(v.text, i)}
                >
                  {copied === i ? "COPIED" : "COPY"}
                </button>
              </li>
            ))}
          </ol>
        )}

        <div className="drafts__foot">
          {gen.status === "running" ? (
            <>
              {/* A clip is a multi-minute call and there is one per draft, so this runs for a long
                  while. Progress in items, plus a way out — never a spinner and a hope. */}
              {/* Same signal as the Backdrop strip — a dot plus the words — so the two long-running
                  jobs on this page read as one system. The layout differs because this one lives in
                  a 280px column, not a full-width row. */}
              <p className="drafts__progress" role="status" aria-live="polite">
                <span className="pp-dot pp-dot--pulse" aria-hidden="true" />
                Roadie is making them
                {gen.progress && gen.progress.total > 0
                  ? ` — ${gen.progress.done} of ${gen.progress.total}`
                  : "…"}
              </p>
              <button
                type="button"
                className="pp-btn pp-btn--wide pp-btn--outline"
                onClick={gen.cancel}
              >
                STOP
              </button>
            </>
          ) : (
            <button
              type="button"
              className="pp-btn pp-btn--wide pp-btn--outline"
              disabled={!canGenerate || drafts.length === 0}
              onClick={gen.start}
              title={
                canGenerate
                  ? "Makes a clip from each draft, then joins them into the loop"
                  : "Turn video generation on in Settings first"
              }
            >
              ◈ LET ROADIE MAKE IT
            </button>
          )}
          {gen.status === "failed" && (
            <p className="drafts__failed" role="status">
              <span className="pp-dot" aria-hidden="true" />
              That didn&apos;t finish — {gen.error}
            </p>
          )}
          <p className="drafts__cost">
            {canGenerate
              ? "costs Veo credits · one clip per draft, joined into a loop"
              : "costs Veo credits — off unless you turn it on in settings"}
          </p>
        </div>
      </aside>
    </div>
  );
}
