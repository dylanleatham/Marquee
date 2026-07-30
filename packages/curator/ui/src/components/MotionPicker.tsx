// How this album moves the lights (ADR 0039), in the Look tab beside the palette that feeds it.
//
// One list, eight answers: Auto plus the seven pattern types. The CLIP four play on any bridge; the
// streaming three need an entertainment area and say so. Choosing here never overwrites the derived
// pattern — it's stored beside it (ADR 0035's rule, now covering both halves), so Auto is a delete
// rather than a restore and a palette regeneration re-derives underneath whatever you picked.
//
// What stays derived is the *default*: Palette Press picks a pattern from palette energy (ADR 0033)
// and that is what every album plays until a human deliberately says otherwise. ADR 0030's case
// against a pattern editor was about not overriding a computed value in place; this doesn't.
import {
  CLIP_PATTERN_TYPES,
  PATTERN_PARAM_SPECS,
  STREAM_PATTERN_TYPES,
  isStreamPatternType,
} from "@marquee/contracts";
import type { AlbumAsset, PatternType } from "../api";
import { api } from "../api";
import type { Run } from "./workflow";

const BLURBS: Record<PatternType, string> = {
  static: "The palette held across the lights, no motion.",
  rotate: "The colours step around the room, one light to the next.",
  pulse: "The dominant colour breathes — dimming and rising.",
  crossfade: "The room melts from one colour to the next and holds.",
  aurora:
    "A slow flow-field drift — colours bleed and morph, never quite repeating.",
  shimmer:
    "The palette held across the lights with a candlelight twinkle on each.",
  wave: "A band of colour sweeps across the lights' real positions in the room.",
};

const label = (type: PatternType) =>
  type.charAt(0).toUpperCase() + type.slice(1);

export function MotionPicker({
  curatorId,
  asset,
  run,
}: {
  curatorId: string;
  asset: AlbumAsset;
  run: Run;
}) {
  const current = asset.patternOverride ?? null;
  const derived = asset.pattern?.type;
  const choose = (type: PatternType | null) =>
    run(() => api.setPatternOverride(curatorId, type));

  const option = (type: PatternType) => (
    <button
      key={type}
      type="button"
      className={`chip ${current === type ? "chip--on" : ""}`}
      aria-pressed={current === type}
      title={BLURBS[type]}
      onClick={() => choose(type)}
    >
      {current === type && <span aria-hidden="true">✓ </span>}
      {label(type)}
    </button>
  );

  return (
    <div className="motion">
      <div className="motion__head">
        <b>Motion</b>
        <em className="muted">How this record moves the lights</em>
      </div>
      {/* Selection carries a check glyph as well as the chip colour — never colour alone
          (curator-ui-ux §3.4). aria-pressed covers the same ground for a screen reader. */}
      <div className="motion__options" role="group" aria-label="Motion">
        {/* "Auto" is a peer of the patterns, not a separate clear button: the album always has
            exactly one answer here, and the default deserves to be visible as a choice. */}
        <button
          type="button"
          className={`chip ${current === null ? "chip--on" : ""}`}
          aria-pressed={current === null}
          title="Whatever Palette Press derived from this album's palette."
          onClick={() => choose(null)}
        >
          {current === null && <span aria-hidden="true">✓ </span>}Auto
        </button>
        {CLIP_PATTERN_TYPES.map(option)}
      </div>
      {/* The streaming three are separated because they're the ones that need hardware, not because
          they're a different kind of answer — same field, same picker, one group per requirement. */}
      <div
        className="motion__options motion__options--streaming"
        role="group"
        aria-label="Streaming effects (need an entertainment area)"
      >
        <span className="muted motion__group-label">
          Streaming — needs an entertainment area on the Hue bridge
        </span>
        {STREAM_PATTERN_TYPES.map(option)}
      </div>
      {current !== null && (
        <MotionParams
          curatorId={curatorId}
          type={current}
          params={asset.patternOverrideParams ?? {}}
          run={run}
        />
      )}
      {/* Say what happens without the hardware, rather than degrading silently. A streaming pick
          falls back to this album's own derived pattern, so choosing one never costs it its motion. */}
      <p className="muted motion__note">
        {current === null ? (
          <>
            Auto — this album plays its derived pattern
            {derived ? (
              <>
                {" "}
                (<span className="tag">{derived}</span>)
              </>
            ) : null}
            .
          </>
        ) : isStreamPatternType(current) ? (
          <>
            Plays <b>{current}</b> when an entertainment area is configured;
            otherwise it falls back to this album&rsquo;s derived pattern
            {derived ? (
              <>
                {" "}
                (<span className="tag">{derived}</span>)
              </>
            ) : null}
            .
          </>
        ) : (
          <>
            Plays <b>{current}</b> on any bridge, instead of the pattern derived
            from this album&rsquo;s palette
            {derived ? (
              <>
                {" "}
                (<span className="tag">{derived}</span>)
              </>
            ) : null}
            . The derived pattern is kept — pick Auto to go back to it.
          </>
        )}
      </p>
    </div>
  );
}

/**
 * The chosen pattern's own knobs (ADR 0036, widened to CLIP by ADR 0039).
 *
 * These tune the *override*, not the derived pattern, so there is still no computed value being
 * edited in place and no staleness question when the palette changes — which is the distinction
 * ADR 0030 was actually drawing, and the reason this is a different decision from a pattern editor.
 *
 * Ranges and defaults come from PATTERN_PARAM_SPECS in @marquee/contracts, the same source the server
 * validates against — a slider that offers a value the API rejects is worse than no slider.
 */
function MotionParams({
  curatorId,
  type,
  params,
  run,
}: {
  curatorId: string;
  type: PatternType;
  params: Record<string, number>;
  run: Run;
}) {
  const specs = PATTERN_PARAM_SPECS[type];
  const valueOf = (key: string, fallback: number) => params[key] ?? fallback;
  const tuned = specs.some((sp) => params[sp.key] !== undefined);

  // Commit on release, not on every drag frame: each change is a PUT plus an album re-poll, and a
  // slider fires continuously while held.
  const commit = (key: string, raw: string) => {
    const next = { ...params, [key]: Number(raw) };
    run(() => api.setPatternOverride(curatorId, type, next));
  };

  // `static` has nothing to tune — an empty knob rack with a dead reset button reads as broken.
  if (specs.length === 0) return null;

  return (
    <div className="motion__params">
      {specs.map((sp) => {
        const value = valueOf(sp.key, sp.default);
        return (
          <label key={sp.key} className="motion__param" title={sp.hint}>
            <span className="motion__param-label">
              {sp.label}
              {/* The number is shown because a slider alone can't be read back or reproduced. */}
              <output className="motion__param-value">{value}</output>
            </span>
            <input
              type="range"
              min={sp.min}
              max={sp.max}
              step={sp.step}
              defaultValue={value}
              aria-label={`${sp.label} — ${sp.hint}`}
              key={`${type}-${sp.key}-${value}`}
              onMouseUp={(e) => commit(sp.key, e.currentTarget.value)}
              onKeyUp={(e) => commit(sp.key, e.currentTarget.value)}
              onTouchEnd={(e) => commit(sp.key, e.currentTarget.value)}
            />
          </label>
        );
      })}
      <button
        type="button"
        className="btn btn--sm btn--ghost"
        disabled={!tuned}
        onClick={() => run(() => api.setPatternOverride(curatorId, type, {}))}
      >
        Reset to defaults
      </button>
    </div>
  );
}
