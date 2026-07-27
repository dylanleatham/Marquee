// Opt an album into an Entertainment streaming effect (ADR 0035), in the Look tab beside the
// derived pattern it overrides.
//
// This is a switch, not a pattern editor. ADR 0030 settled that motion stays derived from palette
// energy and that hand-tuning a params blob is not the answer to "the motion doesn't suit this
// record" — the answer is to change where the colours come from. What ADR 0030 did not decide, and
// what ADR 0024 assumed someone would build, is the opt-in the *producer* deliberately can't make:
// Palette Press never selects a streaming effect, because it cannot know whether a given runtime
// has an entertainment area. Only a human looking at their own room can answer that.
import { STREAM_PARAM_SPECS } from "@marquee/contracts";
import type { AlbumAsset, StreamingEffect } from "../api";
import { api } from "../api";
import type { Run } from "./workflow";

const EFFECTS: Array<{ id: StreamingEffect; label: string; blurb: string }> = [
  {
    id: "aurora",
    label: "Aurora",
    blurb:
      "A slow flow-field drift — colours bleed and morph, never quite repeating.",
  },
  {
    id: "shimmer",
    label: "Shimmer",
    blurb:
      "The palette held across the lights with a candlelight twinkle on each.",
  },
  {
    id: "wave",
    label: "Wave",
    blurb:
      "A band of colour sweeps across the lights' real positions in the room.",
  },
];

export function StreamingEffectPicker({
  curatorId,
  asset,
  run,
}: {
  curatorId: string;
  asset: AlbumAsset;
  run: Run;
}) {
  const current = asset.streamingEffect ?? null;
  const derived = asset.pattern?.type;
  const choose = (effect: StreamingEffect | null) =>
    run(() => api.setStreamingEffect(curatorId, effect));

  return (
    <div className="streaming">
      <div className="streaming__head">
        <b>Streaming effect</b>
        <em className="muted">Needs an entertainment area on the Hue bridge</em>
      </div>
      {/* Selection carries a check glyph as well as the chip colour — never colour alone
          (curator-ui-ux §3.4). aria-pressed covers the same ground for a screen reader. */}
      <div
        className="streaming__options"
        role="group"
        aria-label="Streaming effect"
      >
        {/* "Off" is a peer of the effects, not a separate clear button: the album always has
            exactly one answer here, and the default deserves to be visible as a choice. */}
        <button
          type="button"
          className={`chip ${current === null ? "chip--on" : ""}`}
          aria-pressed={current === null}
          onClick={() => choose(null)}
        >
          {current === null && <span aria-hidden="true">✓ </span>}Off
        </button>
        {EFFECTS.map((e) => (
          <button
            key={e.id}
            type="button"
            className={`chip ${current === e.id ? "chip--on" : ""}`}
            aria-pressed={current === e.id}
            title={e.blurb}
            onClick={() => choose(e.id)}
          >
            {current === e.id && <span aria-hidden="true">✓ </span>}
            {e.label}
          </button>
        ))}
      </div>
      {current !== null && (
        <StreamingParams
          curatorId={curatorId}
          effect={current}
          params={asset.streamingParams ?? {}}
          run={run}
        />
      )}
      {/* Say what happens without the hardware, rather than degrading silently. The fallback is
          this album's own derived pattern, so opting in never costs it its motion. */}
      <p className="muted streaming__note">
        {current === null ? (
          <>
            Off — this album plays its derived pattern
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
        )}
      </p>
    </div>
  );
}

/**
 * The chosen effect's own knobs (ADR 0036).
 *
 * Unlike the pattern beneath it, nothing here is derived — these are the renderers' defaults, so
 * there is no computed value to fight with and no staleness question when the palette changes. That
 * is why tuning these is a different decision from tuning a CLIP pattern, which ADR 0030 declined.
 *
 * Ranges and defaults come from STREAM_PARAM_SPECS in @marquee/contracts, the same source the server
 * validates against — a slider that offers a value the API rejects is worse than no slider.
 */
function StreamingParams({
  curatorId,
  effect,
  params,
  run,
}: {
  curatorId: string;
  effect: StreamingEffect;
  params: Record<string, number>;
  run: Run;
}) {
  const specs = STREAM_PARAM_SPECS[effect];
  const valueOf = (key: string, fallback: number) => params[key] ?? fallback;
  const tuned = specs.some((sp) => params[sp.key] !== undefined);

  // Commit on release, not on every drag frame: each change is a PUT plus an album re-poll, and a
  // slider fires continuously while held.
  const commit = (key: string, raw: string) => {
    const next = { ...params, [key]: Number(raw) };
    run(() => api.setStreamingEffect(curatorId, effect, next));
  };

  return (
    <div className="streaming__params">
      {specs.map((sp) => {
        const value = valueOf(sp.key, sp.default);
        return (
          <label key={sp.key} className="streaming__param" title={sp.hint}>
            <span className="streaming__param-label">
              {sp.label}
              {/* The number is shown because a slider alone can't be read back or reproduced. */}
              <output className="streaming__param-value">{value}</output>
            </span>
            <input
              type="range"
              min={sp.min}
              max={sp.max}
              step={sp.step}
              defaultValue={value}
              aria-label={`${sp.label} — ${sp.hint}`}
              key={`${effect}-${sp.key}-${value}`}
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
        onClick={() => run(() => api.setStreamingEffect(curatorId, effect, {}))}
      >
        Reset to defaults
      </button>
    </div>
  );
}
