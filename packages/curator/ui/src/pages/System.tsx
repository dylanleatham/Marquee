import { useState } from "react";
import { Link } from "react-router-dom";
import { api, type ServiceHealth, type SystemStatus } from "../api";
import { usePoll } from "../hooks";
import { AsyncButton } from "../components/common";
import { errorMessage } from "../errors";
import {
  exceptions,
  JOB_LABEL,
  jobProgress,
  serviceLine,
  servicePort,
  serviceState,
} from "../system";

/**
 * System (ADR 0052) — the page you open when something is wrong.
 *
 * The album matrix is gone. It was the old page's centrepiece and answered "is everything fine?" by
 * making you read every album against every host and compare ticks; **this shows the exceptions**, so
 * the screen is as long as the number of things actually wrong, and empty when nothing is.
 *
 * This is also **the one place a raw error code belongs** — `connect ECONNREFUSED` is the actionable
 * text for a service that won't answer, and paraphrasing it would take away the thing you need to
 * paste into a search.
 *
 * The page was read-only apart from Sync everything until 2026-08-08. **Stop the lights** (ADR 0061)
 * is the second write, and it is here because this is the screen that tells you they are on.
 */

function Service({
  health,
  onRetry,
}: {
  health: ServiceHealth;
  onRetry: () => Promise<unknown>;
}) {
  const [copied, setCopied] = useState(false);
  const state = serviceState(health);
  const name = health.service[0]!.toUpperCase() + health.service.slice(1);

  return (
    <div className={`svc${state === "up" ? "" : ` svc--${state}`}`}>
      {/* The dot is the glance; the line under the name is what actually says which state it is. */}
      <span
        className={`pp-dot svc__dot${state === "up" ? " pp-dot--positive" : ""}`}
        aria-hidden="true"
      />
      <div className="svc__body">
        <p className="svc__name">{name}</p>
        <p className="svc__gloss">{serviceLine(health)}</p>
        {state === "down" && health.detail ? (
          <>
            <p className="svc__detail">{health.detail}</p>
            <span className="svc__actions">
              <AsyncButton className="svc__retry" onClick={onRetry}>
                RETRY
              </AsyncButton>
              <button
                type="button"
                className="svc__copy"
                onClick={() => {
                  void navigator.clipboard
                    ?.writeText(`${name} ${health.url ?? ""}: ${health.detail}`)
                    .then(() => setCopied(true))
                    // Nowhere on screen to report this — the button's whole job was to move text
                    // somewhere else — so it goes to the console with the text still visible above.
                    .catch((err: unknown) =>
                      console.error(
                        "[curator-ui] couldn't copy the error text:",
                        err,
                      ),
                    );
                }}
              >
                {copied ? "COPIED" : "COPY ERROR"}
              </button>
            </span>
          </>
        ) : (
          <p className="svc__port">{servicePort(health.url)}</p>
        )}
      </div>
    </div>
  );
}

export function System() {
  const { data, error, refresh } = usePoll<SystemStatus>(
    api.systemStatus,
    5000,
  );
  const [syncProblem, setSyncProblem] = useState<string | null>(null);
  /**
   * What the last stop did, in a sentence. Both outcomes need words: a failure obviously, but a
   * success too — a stop pressed while the row already read "nothing" (the streaming case the
   * caveat warns about) changes nothing on screen, and a button that appears to do nothing is
   * indistinguishable from a broken one.
   */
  const [stopped, setStopped] = useState<{ ok: boolean; text: string } | null>(
    null,
  );

  if (error)
    return (
      <main className="screen">
        <p className="pp-error">Couldn&apos;t read the system: {error}</p>
      </main>
    );
  if (!data)
    return (
      <main className="screen">
        <p className="pp-loading">Reading the system…</p>
      </main>
    );

  const jobs = data.jobs.filter((j) => j.status === "running");
  const wrong = exceptions(data.albums);
  const lights = data.playing.lights?.[0];
  const audio = data.playing.audio;
  const standDown = !data.stylus;
  /**
   * The stop is offered whenever Conductor is answering — **not** only when `lights` is non-empty.
   * The caveat right below this section says the playback view misses streaming patterns, so gating
   * the button on it would hide the control in the one case where the room is lit and the page
   * cannot see it. Conductor down is the one case worth hiding it for: the stop can only 502, and
   * the service list above already says why.
   */
  const conductorUp = data.services.some(
    (s) => s.service === "conductor" && s.reachable,
  );

  const stopLights = async () => {
    setStopped(null);
    try {
      await api.demoStop();
      setStopped({
        ok: true,
        text: "The lights are off — the room is back to how it was.",
      });
      refresh();
    } catch (err) {
      setStopped({
        ok: false,
        text: `Couldn't stop the lights: ${errorMessage(err)}`,
      });
    }
  };

  return (
    <main className="screen">
      <header className="screen__head">
        <h1 className="pp-title screen__title">System</h1>
        <AsyncButton
          className="pp-btn"
          onClick={async () => {
            setSyncProblem(null);
            try {
              await api.runtimeSync();
            } catch (err) {
              setSyncProblem(errorMessage(err));
            }
          }}
          pendingLabel="SYNCING…"
        >
          SYNC EVERYTHING
        </AsyncButton>
      </header>

      {syncProblem && (
        <p className="pp-error">Couldn&apos;t sync: {syncProblem}</p>
      )}

      <section className="svcs" aria-label="Services">
        {data.services.map((s) => (
          <Service key={s.service} health={s} onRetry={async () => refresh()} />
        ))}
      </section>

      {jobs.length > 0 && (
        <section className="inflight">
          <p className="pp-label">IN FLIGHT · {jobs.length}</p>
          {jobs.map((j) => {
            const pct =
              j.progress.total > 0
                ? Math.min(
                    100,
                    Math.round((j.progress.done / j.progress.total) * 100),
                  )
                : 0;
            return (
              <p className="inflight__row" key={j.id}>
                <span className="inflight__what">
                  <b>{JOB_LABEL[j.kind] ?? j.kind}</b>{" "}
                  <span className="inflight__scope">
                    · {j.curatorId ? "one record" : "the whole collection"}
                  </span>
                </span>
                <span className="inflight__bar" aria-hidden="true">
                  <span
                    className={`inflight__fill${j.kind === "mediaTransfer" ? " inflight__fill--accent" : ""}`}
                    style={{ width: `${pct}%` }}
                  />
                </span>
                {/* Never the bar alone (curator-ui-ux §3.4) — the count carries it too. */}
                <span className="inflight__count">
                  {jobProgress(j.kind, j.progress.done, j.progress.total)}
                </span>
              </p>
            );
          })}
        </section>
      )}

      <div className="screen__body sysgrid">
        <section>
          <p className="pp-label sysgrid__head">PLAYING RIGHT NOW</p>
          <p className="nowrow">
            <span className="nowrow__what">SCREEN</span>
            <span>
              {data.playing.video?.uri
                ? (data.playing.video.filePath ?? data.playing.video.uri)
                : "nothing"}
            </span>
          </p>
          <p className="nowrow">
            <span className="nowrow__what">LIGHTS</span>
            {/*
             * The handoff sketches this as "living room, crossfade". Conductor reports a room *id*,
             * not a name, and the record it is lit for — and under "playing right now" the record is
             * the answer, especially for one with no visualizer, where SCREEN says "nothing" and this
             * is the only line that names it. So: the record when Conductor names it, the room id
             * when it doesn't.
             */}
            <span className="nowrow__now">
              {lights
                ? `${lights.source?.name ?? lights.roomId}${lights.pattern ? `, ${lights.pattern}` : ""}`
                : "nothing"}
            </span>
            {conductorUp && (
              <AsyncButton
                className="nowrow__stop"
                onClick={stopLights}
                pendingLabel="STOPPING…"
                title="Conductor stops playback and fades the room back to how it was"
              >
                STOP THE LIGHTS
              </AsyncButton>
            )}
          </p>
          <p className="nowrow">
            <span className="nowrow__what">SOUND</span>
            <span>
              {audio?.state
                ? `${audio.state}${audio.target ? ` → ${audio.target}` : ""}`
                : "nothing"}
            </span>
          </p>
          <p className={`nowrow${standDown ? " nowrow--down" : ""}`}>
            <span className="nowrow__what">STAND</span>
            <span>
              {standDown
                ? "can't tell — Stylus is down"
                : (data.stylus?.observed?.uri ?? "empty")}
            </span>
          </p>
          {/* What the stop did, in the prose slot this section already uses for what it can't show
              in a row — the four rows stay a four-row list. */}
          {stopped && (
            <p
              className={`sysgrid__stopped${stopped.ok ? "" : " sysgrid__stopped--failed"}`}
              role="status"
            >
              {stopped.text}
            </p>
          )}
          {/* The limits, stated rather than implied by a confident blank. */}
          {data.playing.caveats.map((c) => (
            <p className="sysgrid__caveat" key={c}>
              {c}
            </p>
          ))}
        </section>

        <section>
          <p className="pp-label sysgrid__head">
            RECORDS THAT AREN&apos;T EVERYWHERE THEY SHOULD BE
          </p>
          {wrong.length === 0 ? (
            <p className="pp-prose">Every record is everywhere it should be.</p>
          ) : (
            wrong.map(({ album, problem }) => (
              <p className="nowrow" key={album.curatorId}>
                <span className="nowrow__album">
                  <Link to={`/albums/${album.curatorId}`}>
                    <b>{album.name}</b>
                  </Link>{" "}
                  — {album.artist}
                </span>
                <span className="nowrow__problem">{problem}</span>
              </p>
            ))
          )}
        </section>
      </div>
    </main>
  );
}
