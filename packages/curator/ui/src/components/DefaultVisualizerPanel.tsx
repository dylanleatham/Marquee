import { useCallback, useEffect, useRef, useState } from "react";
import { api, type DefaultVisualizerStatus } from "../api";
import { errorMessage } from "../errors";
import { useUpload, usePoll, useOnScreen } from "../hooks";
import {
  useDefaultVisualizerPushJob,
  startDefaultVisualizerPush,
  attachRunningDefaultVisualizerPush,
  cancelDefaultVisualizerPush,
} from "../defaultVisualizerPushJob";
import type { LibraryJobState } from "../libraryJob";
import { AsyncButton, pickFile } from "./common";
import { UploadStrip } from "./UploadStrip";
import { formatBytes, etaSeconds, humanEta } from "../transfer";

/**
 * Choose the clip Backdrop plays for every record that has no visualizer of its own
 * ([ADR 0073](../../../../../docs/adrs/0073-a-record-with-no-visualizer-plays-the-default.md)).
 *
 * ADR 0073 shipped the runtime half and left the file to `scp` plus a hand-run `ffmpeg`, so the clip
 * that plays *most often* was the only one nobody encoded for the hardware. This panel routes it
 * through the same ingest as any visualizer — which is why there is no "is it H.264?" field here to
 * get wrong.
 *
 * It lives on Settings rather than on a record because it belongs to the **collection**: it is what
 * plays instead of a record's own clip, so hanging it off any one record would be a lie about
 * ownership. Nothing here changes what a record *owes* — a stand-in is not a visualizer, and the
 * collection still reads NEEDS VISUALIZER for all of them.
 */
export function DefaultVisualizerPanel() {
  const { data, refresh } = usePoll(api.defaultVisualizer, 15000);
  const { inFlight, send } = useUpload();
  const push = useDefaultVisualizerPushJob();
  const preview = useOnScreen();
  const [problem, setProblem] = useState<string | null>(null);
  /** Bumped on every accepted upload so the `<video>` reloads — the URL is otherwise constant. */
  const [version, setVersion] = useState(0);

  // Reattach to a send already going, so opening Settings mid-transfer shows it rather than nothing.
  useEffect(() => {
    void attachRunningDefaultVisualizerPush();
  }, []);

  /*
    Stop decoding when nobody is looking. `autoPlay` alone only decides what happens at load, so
    without this the clip goes on looping on a hidden tab for as long as Settings stays open — the
    idle cost ADR 0049 requires be kept measurable. `play()` rejects if the element is torn down
    mid-call, which is not a failure worth surfacing.
  */
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const attachPreview = useCallback(
    (node: HTMLVideoElement | null) => {
      videoRef.current = node;
      preview.ref(node);
    },
    [preview.ref],
  );
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (!preview.visible) {
      video.pause?.();
      return;
    }
    // Both guards are load-bearing rather than defensive noise: `play()` returns a promise that
    // rejects on an interrupted load, and jsdom implements neither method at all — so an unguarded
    // call throws inside an effect and takes the whole panel down with it.
    const started = video.play?.();
    if (started && typeof started.catch === "function") started.catch(() => {});
  }, [preview.visible, version, data?.present]);

  // The moment a send finishes, `onBackdrop` has a new answer — ask for it rather than waiting out
  // the 15s poll, which would leave "Not on Backdrop yet" on screen after it plainly landed.
  const pushStatus = push.job?.status;
  useEffect(() => {
    if (pushStatus && pushStatus !== "running") refresh();
  }, [pushStatus]);

  const run = async (fn: () => Promise<unknown>) => {
    setProblem(null);
    try {
      await fn();
      refresh();
    } catch (err) {
      setProblem(errorMessage(err));
    }
  };

  const choose = () =>
    pickFile(
      "video/mp4,video/*",
      (file) =>
        void run(async () => {
          const form = new FormData();
          form.set("file", file);
          await send(file, (opts) => api.uploadDefaultVisualizer(form, opts));
          setVersion((v) => v + 1);
          // The upload started the transfer server-side without going through `start()`, so attach
          // to it explicitly — otherwise the panel says nothing for the whole of the send it just
          // began, which is the silence the record page's strip exists to prevent.
          void attachRunningDefaultVisualizerPush();
        }),
    );

  return (
    <section>
      <p className="pp-label settings__head">THE DEFAULT VISUALIZER</p>
      <p className="settings__note">
        What the screen plays for a record that has no visualizer of its own
        yet. The lights and the audio are unaffected — this is the picture.
      </p>

      <UploadStrip upload={inFlight} />
      {problem && (
        <p className="settings__problem" role="alert">
          {problem}
        </p>
      )}

      {data && !data.present && !inFlight && (
        <p className="settings__note">
          Nothing set, so those records currently show nothing at all. Any MP4
          works — it gets re-encoded to what the Pi can decode.
        </p>
      )}

      {data?.present && (
        <>
          <video
            /* Paused while the tab is hidden or this is scrolled away. An autoplaying loop decodes
               frames forever otherwise, and idle cost is a product requirement here, measured
               rather than assumed (ADR 0049, issues #135/#136). The poster keeps the frame on
               screen while it is paused, so gating costs nothing visually. */
            ref={attachPreview}
            className="viz__video"
            /* Keyed on the upload count: the URL never changes, so without this the browser keeps
               playing the clip it cached and REPLACE looks like it missed (issue #25's trap). */
            src={`/api/settings/default-visualizer/video?v=${version}`}
            poster={`/api/settings/default-visualizer/thumbnail?v=${version}`}
            autoPlay={preview.visible}
            muted
            loop
            playsInline
          />
          <p className="setrow setrow--ro">
            <span className="pp-label">Clip</span>
            <span className="setrow__value">
              {data.meta?.originalFilename ?? "placed by hand"}
              {data.meta ? ` · ${data.meta.resolution}` : ""}
              {data.bytes === null ? "" : ` · ${formatBytes(data.bytes)}`}
            </span>
          </p>
          {data.meta?.normalized && (
            <p className="settings__note">
              Re-encoded on the way in so the Pi can decode it — it plays H.264
              in software, and an over-budget clip stutters on every record that
              uses it.
            </p>
          )}
        </>
      )}

      <BackdropLine
        status={data}
        push={push}
        onPush={() => run(startDefaultVisualizerPush)}
      />

      <p className="settings__actions">
        <AsyncButton
          className="pp-action"
          onClick={async () => choose()}
          pendingLabel="CHOOSING…"
        >
          {data?.present ? "REPLACE" : "CHOOSE A CLIP"}
        </AsyncButton>
        {data?.present && (
          <AsyncButton
            className="pp-action"
            onClick={() => run(api.removeDefaultVisualizer)}
            pendingLabel="REMOVING…"
          >
            REMOVE
          </AsyncButton>
        )}
      </p>
    </section>
  );
}

/**
 * Whether the **Pi** has the clip — three answers, never two
 * ([ADR 0072](../../../../../docs/adrs/0072-backdrop-presence-is-checked-not-assumed.md)). "Can't
 * tell" must not draw the positive dot, and every state says its meaning in words: the dot is
 * decoration, so the line reads the same without colour vision.
 */
function BackdropLine({
  status,
  push,
  onPush,
}: {
  status: DefaultVisualizerStatus | null;
  push: LibraryJobState;
  onPush: () => void;
}) {
  /*
    Checked **before** the running branch, not after. `unreachable` means the poll has stopped
    answering, so the job snapshot behind the bar is stale — and a bar frozen at whatever it last
    saw is indistinguishable from a transfer that stalled, which is the exact failure
    curator-ui-ux §10 requires be reported rather than drawn.
  */
  if (push.unreachable)
    return (
      <p className="bdstrip" role="status">
        <span className="pp-dot" aria-hidden="true" />
        <span className="bdstrip__text">
          Lost contact with Curator while sending — the transfer may still be
          going.
        </span>
      </p>
    );

  /*
    A transfer in flight is the whole answer while it lasts, and it outranks anything `onBackdrop`
    says: mid-send the Pi genuinely doesn't have the file, and "Not on Backdrop yet — SEND IT" over
    a send already going reads as a press that missed. The link to a Pi has been measured at
    ~44 KB/s (ADR 0038), so this is minutes, not a flicker.
  */
  if (push.job?.status === "running") {
    const t = push.job.transfer;
    const pct = t && t.total > 0 ? Math.round((t.sent / t.total) * 100) : 0;
    const eta = t
      ? etaSeconds(t.sent, t.total, Date.now() - Date.parse(t.startedAt))
      : null;
    return (
      <p className="bdstrip" role="status" aria-live="polite">
        <span className="pp-dot pp-dot--pulse" aria-hidden="true" />
        {/* Never the bar alone (curator-ui-ux §3.4) — the percentage and the bytes carry it, and
            the ETA stays absent until there is enough to say rather than guessing from two bytes. */}
        <span className="bdstrip__text">
          {t
            ? `Sending to Backdrop — ${pct}% (${formatBytes(t.sent)} of ${formatBytes(t.total)})${
                eta === null ? "" : ` · ${humanEta(eta)}`
              }`
            : "Sending to Backdrop…"}
        </span>
        {t && (
          <span className="bdstrip__bar" aria-hidden="true">
            <span className="bdstrip__fill" style={{ width: `${pct}%` }} />
          </span>
        )}
        {/* Tens of minutes over a poor link has to be stoppable. */}
        <AsyncButton
          className="pp-action"
          onClick={() => cancelDefaultVisualizerPush()}
          pendingLabel="STOPPING…"
        >
          STOP
        </AsyncButton>
      </p>
    );
  }

  if (push.job?.status === "failed")
    return (
      <p className="bdstrip bdstrip--failed" role="status">
        <span className="pp-dot" aria-hidden="true" />
        <span className="bdstrip__text">
          Sending failed — {push.job.error ?? "Backdrop refused the connection"}
          .
        </span>
        <AsyncButton
          className="pp-action"
          onClick={async () => onPush()}
          pendingLabel="RETRYING…"
        >
          RETRY
        </AsyncButton>
      </p>
    );

  // Before the first answer, and when there is nothing to have sent — say nothing rather than
  // flash a verdict we are about to replace.
  if (!status || !status.present) return null;

  if (status.mediaTransfer === "none")
    return (
      <p className="bdstrip" role="status">
        <span className="pp-dot" aria-hidden="true" />
        <span className="bdstrip__text">
          Curator is not set up to move video files, so copy this to the Pi
          yourself — it goes in Backdrop's media folder as{" "}
          <code>default.mp4</code>.
        </span>
      </p>
    );

  if (status.onBackdrop === "absent")
    return (
      <p className="bdstrip bdstrip--absent" role="status">
        <span className="pp-dot" aria-hidden="true" />
        <span className="bdstrip__text">
          Not on Backdrop yet — every record without its own visualizer will
          show nothing until it lands.
        </span>
        <AsyncButton
          className="pp-action"
          onClick={async () => onPush()}
          pendingLabel="SENDING…"
        >
          SEND IT
        </AsyncButton>
      </p>
    );

  /*
    `unknown` offers a send here, where the record page's identical strip deliberately does not
    (VisualizerPanel's `BackdropStrip`). The divergence is intentional, because the two states have
    different causes. There, `unknown` means one thing — Backdrop isn't answering — and a button that
    cannot work is worse than none. Here it also covers "no record is using the default yet", which
    is the *normal* state five seconds after you first choose a clip, and in that case sending is
    exactly the right move and will succeed. Withholding the only action on this panel until some
    record happens to need the file would be a worse trade than a press that occasionally reports an
    unreachable Pi — which it does, through `problem`.
  */
  if (status.onBackdrop === "unknown")
    return (
      <p className="bdstrip" role="status">
        <span className="pp-dot" aria-hidden="true" />
        <span className="bdstrip__text">
          Can't tell whether Backdrop has this — either it isn't answering, or
          no record is using the default yet.
        </span>
        <AsyncButton
          className="pp-action"
          onClick={async () => onPush()}
          pendingLabel="SENDING…"
        >
          SEND IT ANYWAY
        </AsyncButton>
      </p>
    );

  return (
    <p className="bdstrip bdstrip--done">
      <span className="pp-dot pp-dot--positive" aria-hidden="true" />
      <span className="bdstrip__text">on Backdrop</span>
    </p>
  );
}
