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
            <span>
              {lights
                ? `${lights.source?.name ?? lights.roomId}${lights.pattern ? `, ${lights.pattern}` : ""}`
                : "nothing"}
            </span>
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
