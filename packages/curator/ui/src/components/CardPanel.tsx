import { useState } from "react";
import { api, cardArtCandidateUrl, cardArtUrl, type AlbumAsset } from "../api";
import { AsyncButton, pickFile } from "./common";
import type { Run } from "../run";

/**
 * The card panel (ADR 0052) — the shelf card, chosen by looking.
 *
 * Changes from the old Card workstation:
 *
 * - **7:5 landscape, two up.** The old gallery was a 140px auto-fill grid; four thumbnails that
 *   small are impossible to actually judge, which is the only thing this screen is for.
 * - **"In use" / "use this one instead". "Keep" is gone** — it read as a commitment when the choice
 *   is free to change.
 * - **Download, not a print sheet.** You take the one you are using; the print render belonged to a
 *   workflow that no longer exists.
 */

/**
 * The attached card's URL, keyed on when it was attached.
 *
 * Without the token, REPLACE swaps the file behind a `src` string that never changes, so the browser
 * keeps serving the old image until a hard reload — the same issue #25 stale-art trap the collection
 * tiles and the record sidebar carry a token for.
 */
const attachedCardSrc = (curatorId: string, attachedAt: string): string =>
  `${cardArtUrl(curatorId)}?v=${encodeURIComponent(attachedAt)}`;

export function CardPanel({
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
  /** Card-art generation is opt-in (Settings). Cheap, but still someone's money. */
  canGenerate: boolean;
}) {
  const [broken, setBroken] = useState<Set<number>>(new Set());
  const candidates = asset.cardArtCandidates ?? [];
  const attached = asset.cardArt;

  const upload = (file: File) =>
    run(async () => {
      const form = new FormData();
      form.append("file", file);
      await api.uploadCardArt(curatorId, form);
      refresh();
    });

  /**
   * Which candidate is the attached one. `fileId` is the link — matching on index would break the
   * moment a regeneration renumbers them, and the wrong card would wear the IN USE mark.
   */
  const inUse = (index: number): boolean =>
    Boolean(attached) &&
    candidates.find((c) => c.index === index)?.fileId === attached?.fileId;

  if (!attached && candidates.length === 0)
    return (
      <div className="cards cards--empty">
        <p className="pp-prose">
          No card yet. Roadie can draw some, or bring your own.
        </p>
        <div className="cards__actions">
          <AsyncButton
            className="pp-btn pp-btn--outline"
            disabled={!canGenerate}
            onClick={() => run(() => api.generateCardArtSet(curatorId))}
            pendingLabel="DRAWING…"
            title={
              canGenerate
                ? "Cheap — about five images a go"
                : "Turn card art on in Settings first"
            }
          >
            ◈ ASK ROADIE TO DRAW SOME
          </AsyncButton>
          <button
            type="button"
            className="pp-action"
            onClick={() => pickFile("image/*", upload)}
          >
            UPLOAD MY OWN
          </button>
        </div>
      </div>
    );

  return (
    <div className="cards">
      {/* The attached card leads, whether or not it came from a candidate — an upload has no
          candidate row, and it is still the one in use. */}
      {attached && !candidates.some((c) => inUse(c.index)) && (
        <figure className="card card--inuse">
          <img
            className="card__img"
            src={attachedCardSrc(curatorId, attached.attachedAt)}
            alt=""
          />
          <figcaption className="card__foot">
            <span className="card__inuse">IN USE</span>
            <a
              className="card__download"
              href={attachedCardSrc(curatorId, attached.attachedAt)}
              download={`${curatorId}-card.${attached.ext}`}
            >
              DOWNLOAD
            </a>
          </figcaption>
        </figure>
      )}

      {candidates
        .filter((c) => !broken.has(c.index))
        .map((c) => (
          <figure
            className={`card${inUse(c.index) ? " card--inuse" : ""}`}
            key={c.index}
          >
            <img
              className="card__img"
              src={cardArtCandidateUrl(curatorId, c.index)}
              alt=""
              loading="lazy"
              onError={() => setBroken((s) => new Set(s).add(c.index))}
            />
            <figcaption className="card__foot">
              {inUse(c.index) ? (
                <>
                  <span className="card__inuse">IN USE</span>
                  <a
                    className="card__download"
                    href={attachedCardSrc(curatorId, attached!.attachedAt)}
                    download={`${curatorId}-card.${attached?.ext ?? "png"}`}
                  >
                    DOWNLOAD
                  </a>
                </>
              ) : (
                <AsyncButton
                  className="pp-action"
                  onClick={() =>
                    run(() => api.selectCardArt(curatorId, c.index))
                  }
                  pendingLabel="SWAPPING…"
                >
                  USE THIS ONE INSTEAD
                </AsyncButton>
              )}
            </figcaption>
          </figure>
        ))}

      <div className="cards__actions">
        <AsyncButton
          className="pp-action"
          disabled={!canGenerate}
          onClick={() => run(() => api.generateCardArtSet(curatorId))}
          pendingLabel="DRAWING…"
          title={
            canGenerate
              ? "Cheap — about five images a go"
              : "Turn card art on in Settings first"
          }
        >
          ◈ ASK FOR MORE
        </AsyncButton>
        <button
          type="button"
          className="pp-action"
          onClick={() => pickFile("image/*", upload)}
        >
          UPLOAD MY OWN
        </button>
      </div>
    </div>
  );
}
