import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { PATTERN_PARAM_SPECS } from "@marquee/contracts";
import {
  api,
  videoUrl,
  type AlbumAsset,
  type AlbumSummary,
  type DemoRoomInfo,
  type DemoStatus,
  type PatternType,
} from "../api";
import { usePoll } from "../hooks";
import { needFactsOfAsset, outstandingNeeds } from "../needs";
import { relativeTime } from "../format";
import { artworkSrc } from "../components/common";
import { errorMessage } from "../errors";
import { paletteWash } from "../components/VisualizerPanel";
import { setRoomArm, useRoomArm } from "../roomArm";
import { showReadyToast } from "../readyToast";

/**
 * The room (ADR 0052) — one screen where bench preview and the real thing used to be two.
 *
 * `PreviewWorkstation` (a bench inside the rail) and `DemoRoom` (a fullscreen overlay) did the same
 * job at different fidelities, and you chose between them before you knew which you wanted. Here the
 * **arm toggle** is the difference: bench only washes this window, in the room drives the lights,
 * the screen and the speakers. A plain toggle, no confirm dialog — the switch *is* the deliberate
 * act, and its state is on screen the whole time you are in here.
 *
 * **Sign-off lives here and nowhere else.** Approving a record's lights means having just watched
 * them, which is not a claim a form can make on your behalf.
 */

/** The three the dock offers. All CLIP patterns; the streaming three need hardware this can't check. */
const PATTERNS: Array<{ type: PatternType; label: string }> = [
  { type: "crossfade", label: "CROSSFADE" },
  { type: "pulse", label: "PULSE" },
  { type: "static", label: "HOLD STILL" },
];

/** Long enough that dragging a slider is one write, short enough to feel like it took. */
const SAVE_MS = 500;

/**
 * The value as a person reads it: seconds where the store keeps milliseconds, a percentage only
 * where the scale genuinely runs to 100.
 *
 * The *scale* decides, not the name alone: `pulse.minBrightness` runs 0–90 and `aurora.brightness`
 * runs 0–1, so a bare name match renders a fully-lit room as "1%". A brightness on a 0–1 scale is a
 * fraction and reads as one.
 */
const display = (spec: { key: string; max: number }, value: number): string =>
  spec.key.endsWith("Ms")
    ? `${Math.round(value / 100) / 10}s`
    : /brightness/i.test(spec.key) && spec.max > 1
      ? `${Math.round(value)}%`
      : String(Math.round(value * 100) / 100);

export function Room({ albums }: { albums: AlbumSummary[] | null }) {
  const { curatorId = "" } = useParams();
  const navigate = useNavigate();
  const arm = useRoomArm();
  const armed = arm === "live";

  const { data: asset, refresh } = usePoll<AlbumAsset>(
    () => api.album(curatorId),
    5000,
    curatorId,
  );
  const [status, setStatus] = useState<DemoStatus | null>(null);
  const [rooms, setRooms] = useState<DemoRoomInfo[]>([]);
  /**
   * Whether a sleeve is on the stand. True on arrival — you came here to watch it, and the bench is
   * the *whole* preview minus the hardware, so the clip and the wash run whether or not the room is
   * armed. Only LIFT THE SLEEVE takes it off; PLACE ANOTHER puts the next one on.
   */
  const [playing, setPlaying] = useState(true);
  const [problem, setProblem] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>();

  /** Conductor failing must never take the screen down — the wash and the clip still work. */
  const drive = useCallback(async (fn: () => Promise<unknown>) => {
    setProblem(null);
    try {
      await fn();
    } catch (err) {
      setProblem(errorMessage(err));
    }
  }, []);

  const refreshStatus = useCallback(
    () =>
      api
        .demoStatus()
        .then(setStatus)
        .catch(() =>
          setStatus({ reachable: false, paired: false, listeningRoomId: null }),
        ),
    [],
  );

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  useEffect(() => {
    if (status?.reachable && !status.listeningRoomId)
      api
        .demoRooms()
        .then((r) => setRooms(r.rooms))
        .catch(() => {});
  }, [status?.reachable, status?.listeningRoomId]);

  /**
   * One at a time, in order.
   *
   * Switching records while armed runs this effect's cleanup (stop the old one) and then its body
   * (play the new one). Both are async and neither awaits the other, so a slow stop can land *after*
   * the new play and leave the room dark — pressing PLACE ANOTHER and getting darkness is exactly
   * the failure the room exists to rule out. Chaining them makes the order the code reads.
   */
  const chain = useRef<Promise<unknown>>(Promise.resolve());
  const serial = useCallback((fn: () => Promise<unknown>) => {
    chain.current = chain.current.then(fn, fn);
    return chain.current;
  }, []);

  /**
   * Arming is what starts the room, and un-arming is what stops it — so the toggle is the only
   * control that needs pressing. Leaving the screen stops it too; nothing should keep driving a
   * room you have walked away from.
   */
  /**
   * The room is lights *and* screen (issue #277). A screen that did not start is reported as a note
   * rather than a problem: the lights are running, the room is usable, and the thing the operator
   * needs is the reason — a black screen says nothing about whether the record even has a
   * visualizer.
   */
  const playRoom = useCallback(
    async (id: string) => {
      const res = await api.demoPlay(id);
      setNote(
        res.video && !res.video.ok
          ? `The lights are running, but the screen isn't: ${res.video.reason ?? "no reason given"}`
          : null,
      );
    },
    [setNote],
  );

  useEffect(() => {
    if (!armed || !curatorId) return;
    void serial(() => drive(() => playRoom(curatorId)));
    return () => {
      // A stop that fails leaves the real lights and speakers running in a room nobody is watching,
      // and the screen is already gone — so it goes to the console rather than nowhere at all.
      void serial(() =>
        api
          .demoStop()
          .catch((err: unknown) =>
            console.error(
              "[curator-ui] the room may still be running:",
              curatorId,
              err,
            ),
          ),
      );
    };
  }, [armed, curatorId, drive, serial, playRoom]);

  // Clear the pending slider write on the way out, the way the Lights panel does — an adjustment
  // made and then navigated away from should not be lost.
  const pending = useRef<{
    type: PatternType;
    params: Record<string, number>;
  } | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
      const last = pending.current;
      if (last)
        void api
          .setPatternOverride(curatorId, last.type, last.params)
          // The screen is gone, so there is nowhere left to say this — but the values go to the
          // console with it, the way the Lights panel's flush does, so the loss is diagnosable.
          .catch((err: unknown) =>
            console.error(
              "[curator-ui] a room setting was lost on the way out:",
              curatorId,
              last,
              err,
            ),
          );
    },
    [curatorId],
  );

  if (!asset)
    return (
      <main className="room">
        <p className="room__loading">Opening the room…</p>
      </main>
    );

  const colors = asset.palette?.colors ?? [];
  const pattern = (asset.patternOverride ??
    asset.pattern?.type ??
    "crossfade") as PatternType;
  const specs = PATTERN_PARAM_SPECS[pattern] ?? [];
  /**
   * The three the design names, plus whatever this record is *actually* on when that isn't one of
   * them — a streaming pattern is a legitimate per-album opt-in (ADR 0035), and a dock where no
   * button is pressed reads as "no pattern" rather than "one you can't see from here".
   */
  const patternChoices = PATTERNS.some((p) => p.type === pattern)
    ? PATTERNS
    : [...PATTERNS, { type: pattern, label: pattern.toUpperCase() }];
  const stored = asset.patternOverrideParams ?? {};
  const valueOf = (key: string, fallback: number) =>
    typeof stored[key] === "number" ? stored[key] : fallback;

  const save = (type: PatternType, params: Record<string, number>) => {
    pending.current = { type, params };
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      pending.current = null;
      void drive(async () => {
        await api.setPatternOverride(curatorId, type, params);
        refresh();
      });
    }, SAVE_MS);
  };

  const setParam = (key: string, value: number) => {
    const next = { ...stored, [key]: value };
    // Optimistic: the slider must track the thumb, not the poll.
    (asset.patternOverrideParams ??= {})[key] = value;
    save(pattern, next);
  };

  const choosePattern = (type: PatternType) =>
    void drive(async () => {
      if (timer.current) clearTimeout(timer.current);
      pending.current = null;
      // `{}` resets tuning to this pattern's own defaults — the previous pattern's knobs mean
      // nothing here, and carrying them over would silently produce a payload for the wrong shape.
      await api.setPatternOverride(curatorId, type, {});
      refresh();
      // Lights only, deliberately: this fires on every pattern change, and restarting the video
      // each time a knob moves would make tuning unusable (issue #277).
      if (armed) await api.demoPlay(curatorId, { video: false });
    });

  const playAlbum = () =>
    void drive(async () => {
      // Bench keeps the sound at the desk; in the room it goes to the room. Same button, because
      // "play the album" is the same intent — the arm switch already said where.
      const r = armed
        ? await api.demoAudio(curatorId)
        : await api.deskAudioPlay(curatorId);
      const ok = "played" in r ? r.played : false;
      setNote(ok ? null : (r.reason ?? "Nothing to play it on."));
    });

  const lift = () => {
    setPlaying(false);
    // Through the queue, like the arm effect: an unsequenced stop can otherwise land after a play
    // that a record switch has already started, leaving the room dark for the wrong reason.
    if (armed) void serial(() => drive(() => api.demoStop()));
  };

  const placeAnother = () => {
    const list = albums ?? [];
    const i = list.findIndex((a) => a.curatorId === curatorId);
    const next = list[(i + 1) % (list.length || 1)];
    if (next && next.curatorId !== curatorId)
      navigate(`/room/${next.curatorId}`);
  };

  /**
   * Sign-off asks about the **record**, not about the machine (ADR 0063). The old gate was
   * `state === "awaiting_preview"`, whose only entrance is attaching a visualizer — so on a record
   * with no visualizer the button was permanently dead and the lights need could never be marked
   * done (#263). The two live reasons it can be off are both about this record: you have already
   * done it, or there are no lights to look at yet.
   */
  const approvedAt = asset.verification?.previewApprovedAt;
  const lit = (asset.palette?.colors.length ?? 0) > 0;
  const canApprove = !approvedAt && lit;
  const why = approvedAt
    ? `Signed off ${relativeTime(approvedAt)} — watch it as often as you like.`
    : "Roadie hasn't pulled the lights for this record yet.";

  /**
   * Signing off **confirms in place**. It used to return to the collection and fire the ready toast
   * unconditionally — so the only evidence you had signed anything off was a toast claiming all four
   * needs were done, on a record that usually still needed three of them (#263).
   *
   * The toast keeps its meaning by being fired only when it is true: this was the last outstanding
   * need. Then the collection is where you want to be, because this record is finished.
   *
   * The other three needs are read from the polled asset, which can be up to 5s stale — so a card
   * attached in another tab a moment ago means the toast is skipped, not that it fires wrongly. That
   * is the right way round: the collection tile says READY on its next tick either way, and a missed
   * celebration costs nothing where a false "all done" is the bug this replaced.
   */
  const approve = () =>
    void drive(async () => {
      const done = await api.approvePreview(curatorId);
      refresh();
      const left = outstandingNeeds({
        ...needFactsOfAsset(asset),
        state: done.state,
        previewApprovedAt: done.previewApprovedAt,
      });
      if (left.length === 0) {
        showReadyToast(curatorId);
        navigate("/");
      }
    });

  const roomName =
    rooms.find((r) => r.id === status?.listeningRoomId)?.name ??
    status?.listeningRoomId ??
    "";

  return (
    <main className="room">
      <div className="room__stage">
        {/* Inset -6% so the drift never reveals an edge. Respects prefers-reduced-motion globally. */}
        <div
          className="room__wash"
          style={{ background: paletteWash(colors) }}
          aria-hidden="true"
        />

        <div className="room__bar">
          <Link to={`/albums/${curatorId}`} className="room__back">
            ← THE RECORD
          </Link>
          <h1 className="room__title">{asset.metadata.name}</h1>
          <p className="room__byline">{asset.metadata.artist}</p>
          <button
            type="button"
            role="switch"
            aria-checked={armed}
            className={`room__arm${armed ? " room__arm--live" : ""}`}
            onClick={() => setRoomArm(armed ? "bench" : "live")}
            title={
              armed
                ? "The lights, the screen and the speakers are following this window. Click for bench only."
                : "Nothing here touches the room. Click to drive it for real."
            }
          >
            {armed ? "IN THE ROOM" : "BENCH ONLY"}
          </button>
        </div>

        <div className="room__scene">
          {asset.visualizer && playing ? (
            <video
              className="room__visualizer"
              src={`${videoUrl(curatorId)}?v=${encodeURIComponent(asset.visualizer.fileId)}`}
              autoPlay
              muted
              loop
              playsInline
            />
          ) : (
            <div className="room__visualizer room__visualizer--empty">
              <span>
                {!asset.visualizer
                  ? "NO VISUALIZER — THE LIGHTS STILL PLAY"
                  : "THE SLEEVE IS OFF THE STAND"}
              </span>
            </div>
          )}
          <div className="room__sleeve">
            {asset.artwork ? (
              <img
                className="room__sleeve-art"
                src={artworkSrc(curatorId, asset.artwork.contentHash)}
                alt=""
              />
            ) : (
              <span className="room__sleeve-art" aria-hidden="true" />
            )}
            <span className="room__sleeve-cap">THE SLEEVE, ON THE STAND</span>
          </div>
        </div>

        {(problem || note) && (
          <p className="room__problem" role="status">
            {problem ?? note}
          </p>
        )}
      </div>

      <div className="room__dock">
        <div className="dock__group dock__group--movers">
          <p className="dock__label">
            HOW THE LIGHTS MOVE <span>· THIS RECORD</span>
          </p>
          {specs.length === 0 ? (
            <p className="dock__none">
              Hold still has nothing to tune — the palette simply sits on the
              room.
            </p>
          ) : (
            <div className="dock__movers">
              {specs.map((spec) => {
                const value = valueOf(spec.key, spec.default);
                return (
                  <label className="mover" key={spec.key}>
                    <span className="mover__head">
                      <span>{spec.label}</span>
                      <span className="mover__value">
                        {display(spec, value)}
                      </span>
                    </span>
                    <input
                      type="range"
                      min={spec.min}
                      max={spec.max}
                      step={spec.step}
                      value={value}
                      title={spec.hint}
                      onChange={(e) =>
                        setParam(spec.key, Number(e.target.value))
                      }
                    />
                  </label>
                );
              })}
            </div>
          )}
        </div>

        <div className="dock__group">
          <p className="dock__label">LIGHT PATTERN</p>
          <div className="dock__stack">
            {patternChoices.map((p) => (
              <button
                key={p.type}
                type="button"
                className="dock__btn"
                aria-pressed={pattern === p.type}
                onClick={() => choosePattern(p.type)}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>

        <div className="dock__group">
          <p className="dock__label">WHILE YOU LOOK</p>
          <div className="dock__stack">
            <button type="button" className="dock__btn" onClick={playAlbum}>
              ♪ PLAY THE ALBUM
            </button>
            <button type="button" className="dock__btn" onClick={lift}>
              LIFT THE SLEEVE
            </button>
            <button
              type="button"
              className="dock__btn"
              onClick={placeAnother}
              disabled={(albums?.length ?? 0) < 2}
            >
              PLACE ANOTHER
            </button>
            {/* Only when it's actually in the way: armed, Conductor up, no room chosen. */}
            {armed && status?.reachable && !status.listeningRoomId && (
              <select
                className="dock__rooms"
                defaultValue=""
                onChange={(e) =>
                  e.target.value &&
                  void drive(async () => {
                    await api.demoSetRoom(e.target.value);
                    await refreshStatus();
                  })
                }
              >
                <option value="">which room are your lights in?</option>
                {rooms.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </select>
            )}
            {armed && roomName && (
              <p className="dock__room">the lights in {roomName}</p>
            )}
          </div>
        </div>

        <div className="dock__group dock__group--signoff">
          <p className="dock__label">SIGN IT OFF</p>
          <button
            type="button"
            className={`dock__approve${approvedAt ? " dock__approve--done" : ""}`}
            disabled={!canApprove}
            title={canApprove ? "Signs the lights off for this record" : why}
            onClick={approve}
          >
            {/* The glyph carries the state, never colour alone: ✓ is an offer, ●✓ is a receipt. */}
            {approvedAt ? "● SIGNED OFF ✓" : "Looks right ✓"}
          </button>
          <p className="dock__signoff-note">
            {canApprove ? "The lights are only signed off from in here." : why}
          </p>
        </div>
      </div>
    </main>
  );
}
