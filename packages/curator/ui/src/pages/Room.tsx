import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  CLIP_PATTERN_TYPES,
  PATTERN_PARAM_SPECS,
  STREAM_PATTERN_TYPES,
} from "@marquee/contracts";
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
import { relativeTime } from "../format";
import { artworkSrc } from "../components/common";
import { errorMessage } from "../errors";
import { paletteWash } from "../components/VisualizerPanel";
import { setRoomArm, useRoomArm } from "../roomArm";

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

/**
 * How each motion is named on a chip.
 *
 * `Record<PatternType, string>` deliberately: an eighth pattern arriving in contracts fails to
 * compile here rather than quietly going missing from the dock. It went missing once — this list was
 * a hardcoded three, and `rotate` plus the streaming three could not be chosen at all
 * ([issue #287](https://github.com/dylanleatham/Marquee/issues/287)).
 */
export const PATTERN_LABELS: Record<PatternType, string> = {
  static: "HOLD STILL",
  rotate: "ROTATE",
  pulse: "PULSE",
  crossfade: "CROSSFADE",
  aurora: "AURORA",
  shimmer: "SHIMMER",
  wave: "WAVE",
};

/**
 * The two halves of the picker, in the order they're offered (ADR 0039). The streaming three need an
 * entertainment area on the bridge; this screen can't check for one, so they're grouped and *named*
 * as needing it rather than hidden — hiding the hardware-gated half was the original defect the ADR
 * was written to fix, and hiding it here cost `rotate` too.
 */
const PATTERN_GROUPS: Array<{
  id: string;
  note: string;
  /** Whether the note should name what plays instead where the hardware isn't there. */
  gated?: boolean;
  types: readonly PatternType[];
}> = [
  { id: "clip", note: "PLAYS ON ANY BRIDGE", types: CLIP_PATTERN_TYPES },
  {
    id: "stream",
    note: "NEEDS AN ENTERTAINMENT AREA",
    gated: true,
    types: STREAM_PATTERN_TYPES,
  },
];

/**
 * One motion chip. The tick is what makes the choice readable without leaning on the fill alone
 * (§3.4): hidden from the accessible name, where `aria-pressed` already says it, and always rendered
 * so pressing one doesn't shift the labels beside it.
 */
function PatternChip({
  label,
  pressed,
  onChoose,
}: {
  label: string;
  pressed: boolean;
  onChoose: () => void;
}) {
  return (
    <button
      type="button"
      className="dock__btn"
      aria-pressed={pressed}
      onClick={onChoose}
    >
      <span className="dock__tick" aria-hidden="true">
        {pressed ? "✓" : ""}
      </span>
      {label}
    </button>
  );
}

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
  /**
   * The two are kept apart on purpose (ADR 0039). `override` is what a human chose and the only
   * thing this dock ever writes; `derived` is Palette Press's own answer, shown because it is what
   * plays under AUTO, but never pressed and never tuned — a slider on a computed value would be
   * editing derivation in place, which is the half of ADR 0030 that still holds.
   */
  const override = (asset.patternOverride ?? null) as PatternType | null;
  const derived = (asset.pattern?.type ?? null) as PatternType | null;
  const specs = override ? (PATTERN_PARAM_SPECS[override] ?? []) : [];
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
    // Structurally unreachable: under AUTO `specs` is empty, so there is no slider to move.
    if (!override) return;
    const next = { ...stored, [key]: value };
    // Optimistic: the slider must track the thumb, not the poll.
    (asset.patternOverrideParams ??= {})[key] = value;
    save(override, next);
  };

  /** `null` is AUTO — it deletes the override and hands the record back to its derived pattern. */
  const choosePattern = (type: PatternType | null) =>
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
   * with no visualizer the button was permanently dead (#263). The two live reasons it can be off
   * are both about this record: you have already done it, or there are no lights to look at yet.
   *
   * Since ADR 0069 this records that you watched the lights and liked them; it no longer clears a
   * need, because the lights stopped being one.
   */
  const approvedAt = asset.verification?.previewApprovedAt;
  const lit = (asset.palette?.colors.length ?? 0) > 0;
  const canApprove = !approvedAt && lit;
  const why = approvedAt
    ? `Signed off ${relativeTime(approvedAt)} — watch it as often as you like.`
    : "Roadie hasn't pulled the lights for this record yet.";

  /**
   * Signing off **confirms in place** — it does not navigate, and it does not celebrate.
   *
   * It used to return to the collection and fire the ready toast when sign-off cleared the last
   * outstanding need (#263). Since ADR 0069 the lights are not a need, so approving one can never be
   * what finishes a record: the check could only ever have passed on a record that was already
   * complete, which would have thrown a "ready!" toast at a no-op and then walked you off the screen.
   * The toast now fires from the record page, where the needs that remain are actually cleared.
   */
  const approve = () =>
    void drive(async () => {
      await api.approvePreview(curatorId);
      refresh();
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
          {!override ? (
            <p className="dock__none">
              Roadie&rsquo;s own choice plays here. Pick a pattern below to tune
              it yourself.
            </p>
          ) : specs.length === 0 ? (
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

        <div className="dock__group dock__group--pattern">
          <p className="dock__label">
            LIGHT PATTERN
            {derived && <span> · ROADIE CHOSE {PATTERN_LABELS[derived]}</span>}
          </p>
          <div className="dock__stack">
            <div className="dock__stack dock__stack--half">
              <p className="dock__gate">LEAVE IT TO ROADIE</p>
              <PatternChip
                label="AUTO"
                pressed={override === null}
                onChoose={() => choosePattern(null)}
              />
            </div>
            {PATTERN_GROUPS.map((group) => (
              <div className="dock__stack dock__stack--half" key={group.id}>
                {/* Named, never disabled: this screen can't see whether the bridge has an
                    entertainment area, and Conductor falls back on its own where it doesn't. */}
                <p className="dock__gate">
                  {group.note}
                  {group.gated &&
                    derived &&
                    ` · ${PATTERN_LABELS[derived]} WITHOUT ONE`}
                </p>
                {group.types.map((type) => (
                  <PatternChip
                    key={type}
                    label={PATTERN_LABELS[type]}
                    pressed={override === type}
                    onChoose={() => choosePattern(type)}
                  />
                ))}
              </div>
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
