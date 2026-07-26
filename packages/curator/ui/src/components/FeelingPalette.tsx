// Colours from the album's feeling, offered next to the cover's (ADR 0030 / issue #105).
//
// The cover is the default and stays the default. This is the escape hatch for the record whose
// sleeve doesn't look like it sounds — a muted cover on a ferocious album — and it only ever runs
// because you pressed the button (ADR 0027). Proposing changes nothing; choosing is the commitment.
import { useState } from "react";
import {
  api,
  type AlbumAsset,
  type PaletteCandidates,
  type PaletteSource,
} from "../api";
import { AsyncButton } from "./common";
import { useConfirm } from "./Confirm";

/** A read-only swatch strip, so a candidate reads the same way the editor's does. */
function Swatches({ colors }: { colors: { hex: string; role?: string }[] }) {
  return (
    <div className="feel__swatches">
      {colors.map((c, i) => (
        <span
          key={`${c.hex}-${i}`}
          className="feel__swatch"
          style={{ background: c.hex }}
          // The hex in the title, not only in the colour — a swatch strip is unreadable to anyone
          // who can't distinguish the hues (curator-ui-ux §3.4).
          title={`${c.hex}${c.role ? ` · ${c.role}` : ""}`}
        >
          <em>{c.hex}</em>
        </span>
      ))}
    </div>
  );
}

function Option({
  title,
  blurb,
  colors,
  current,
  onChoose,
}: {
  title: string;
  blurb: string;
  colors: { hex: string; role?: string }[];
  current: boolean;
  onChoose: () => Promise<unknown>;
}) {
  return (
    <div className={`feel__option ${current ? "is-current" : ""}`}>
      <div className="feel__option-head">
        <b>{title}</b>
        {current && <span className="tag">in use</span>}
      </div>
      <p className="muted">{blurb}</p>
      <Swatches colors={colors} />
      <AsyncButton
        className="btn"
        onClick={onChoose}
        disabled={current}
        pendingLabel="Applying…"
      >
        {current ? "In use" : `Use ${title.toLowerCase()}`}
      </AsyncButton>
    </div>
  );
}

export function FeelingPalette({
  curatorId,
  asset,
  run,
}: {
  curatorId: string;
  asset: AlbumAsset;
  run: (fn: () => Promise<unknown>) => Promise<unknown>;
}) {
  const [candidates, setCandidates] = useState<PaletteCandidates | null>(
    asset.paletteCandidates ?? null,
  );
  const confirm = useConfirm();
  const palette = asset.palette;
  if (!palette) return null;

  // Absent on albums predating ADR 0030 — every palette was a cover extraction until this existed.
  const source: PaletteSource = palette.source ?? "cover";

  const propose = async () => {
    const { candidates: next } = await api.feelingPalette(curatorId);
    setCandidates(next);
  };

  const choose = (next: PaletteSource) => () =>
    run(async () => {
      // Only going *back* to the cover is destructive: it re-extracts, so a hand-edit or a chosen
      // palette is discarded. Moving to a candidate is freely reversible from here.
      if (
        next === "cover" &&
        source !== "cover" &&
        !(await confirm({
          title: "Go back to the cover's colours?",
          body: "This re-extracts the palette from the cover art, discarding the one in use.",
          confirmLabel: "Use the cover",
          destructive: true,
        }))
      )
        return;
      await api.choosePalette(curatorId, next);
    });

  return (
    <section className="feel">
      <h3 className="group-head">Where the colours come from</h3>
      <p className="muted">
        The cover is the default. If a record doesn't <em>look</em> like it
        sounds, read colours from the music instead — one Gemini call, only when
        you ask.
      </p>

      {source !== "cover" && (
        <div className="banner banner--ok">
          Using{" "}
          <b>{source === "blend" ? "the blend" : `the ${source} palette`}</b>
          {palette.rationale ? ` — ${palette.rationale}` : ""}. A library-wide
          regeneration will leave it alone.
        </div>
      )}

      {!candidates ? (
        <div className="row-actions">
          <AsyncButton
            className="btn btn--spend"
            onClick={() => run(propose)}
            pendingLabel="Listening…"
          >
            Read colours from the album's feeling
          </AsyncButton>
          <span className="muted">1 Gemini call</span>
        </div>
      ) : (
        <>
          <p className="feel__rationale">{candidates.rationale}</p>
          <div className="feel__options">
            <Option
              title="From the cover"
              blurb="Extracted from the sleeve. Deterministic, free, and what a library-wide regeneration restores."
              colors={candidates.cover}
              current={source === "cover"}
              onChoose={choose("cover")}
            />
            <Option
              title="From the feeling"
              blurb="Colours drawn from how the record sounds, ignoring the sleeve entirely."
              colors={candidates.feeling}
              current={source === "feeling"}
              onChoose={choose("feeling")}
            />
            <Option
              title="Blend"
              blurb="The cover's dominant colour kept, the feeling's colours around it."
              colors={candidates.blend}
              current={source === "blend"}
              onChoose={choose("blend")}
            />
          </div>
          <div className="row-actions">
            <AsyncButton
              className="btn btn--ghost btn--spend"
              onClick={() => run(propose)}
              pendingLabel="Listening…"
            >
              Ask again
            </AsyncButton>
            <span className="muted">1 more Gemini call</span>
          </div>
        </>
      )}
    </section>
  );
}
