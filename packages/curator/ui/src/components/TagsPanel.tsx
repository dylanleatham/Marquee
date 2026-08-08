import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, tagNfcUrl, type AlbumAsset, type TagObject } from "../api";
import { relativeTime } from "../format";
import { AsyncButton } from "./common";
import type { Run } from "../run";

/**
 * The tags panel (ADR 0052) — the stickers, and the one check that catches real bugs.
 *
 * Changes from the old Ship workstation:
 *
 * - **One button for both tags.** Marking the sleeve written and the card written were bookkeeping
 *   about a single act at the Flipper. What is left is the *check* — and it stays a distinct,
 *   visually separated step, because tapping each tag is where a mis-written sticker turns up.
 * - **Per record only.** The bulk "send the whole list to the Flipper" went with the queue; you
 *   write these one record at a time, standing at the shelf.
 * - **No explanatory intro.** The QR, the URI and the state say what this is.
 *
 * **A third, optional sticker (ADR 0058).** The demo tag is not part of "both tags": it is made for
 * a handful of records, so `TAGS VERIFIED` leaves it alone and it carries its own write record. It
 * also states what it will play, because a demo tag with no cut chosen behaves exactly like the
 * shelf card, and a screen that didn't say so would make that look like a bug.
 */

/**
 * The three stickers, and what each does in the room (ADR 0034, ADR 0058). The demo tag is
 * **optional** — most records never get one — which is why it is the only one `TAGS VERIFIED` does
 * not mark written, and why it says what it will play rather than only what it is.
 */
const OBJECTS: Array<{ which: TagObject; label: string }> = [
  { which: "sleeve", label: "THE SLEEVE" },
  { which: "card", label: "THE SHELF CARD" },
  { which: "demo", label: "THE DEMO TAG" },
];

/**
 * A tag's QR **and** its URI, both from the same server response.
 *
 * The payload is composed server-side so one source of truth backs the physical tag (curator-spec
 * §tag-payload) — and a sleeve that already had a payload recorded keeps it, so it need not equal the
 * derived `curator:album:<id>`. Deriving the on-screen text separately would let the words disagree
 * with what the QR actually encodes, on the one screen whose entire job is catching exactly that
 * kind of mismatch. The derived string is shown only while the fetch is in flight or has failed, and
 * it says so.
 */
function useTagPayload(curatorId: string, which: TagObject) {
  const derived = `curator:${which === "sleeve" ? "album" : which}:${curatorId}`;
  const [state, setState] = useState<{
    payload: string;
    qr: string | null;
    failed: boolean;
  }>({ payload: derived, qr: null, failed: false });

  useEffect(() => {
    let live = true;
    setState({ payload: derived, qr: null, failed: false });
    api
      .tagPayload(curatorId, which)
      .then(
        (p) =>
          live &&
          setState({
            payload: p.payload || derived,
            qr: p.qrDataUrl,
            failed: false,
          }),
      )
      .catch(
        () => live && setState({ payload: derived, qr: null, failed: true }),
      );
    return () => {
      live = false;
    };
  }, [curatorId, which, derived]);

  return state;
}

function TagCode({
  qr,
  failed,
  which,
}: {
  qr: string | null;
  failed: boolean;
  which: TagObject;
}) {
  if (failed)
    return (
      <span
        className="tagcode tagcode--empty"
        role="img"
        aria-label="QR unavailable"
      >
        ?
      </span>
    );
  // The QR's contrast is defined against white, so it keeps a white field rather than paper stock.
  return qr ? (
    <img className="tagcode" src={qr} alt={`QR code for the ${which} tag`} />
  ) : (
    <span className="tagcode tagcode--empty" aria-hidden="true" />
  );
}

/** One object's panel — its code, its URI, what it plays, and whether the sticker is burned. */
function TagSticker({
  curatorId,
  which,
  label,
  written,
  plays,
  onWritten,
}: {
  curatorId: string;
  which: TagObject;
  label: string;
  written: boolean;
  /** What this sticker will do in the room, when that isn't already obvious from its name. */
  plays?: string;
  /** Present only for a sticker no other control records — today, the demo tag. */
  onWritten?: () => unknown;
}) {
  const { payload, qr, failed } = useTagPayload(curatorId, which);
  return (
    <div className={`tagobj${written ? " tagobj--written" : ""}`}>
      <TagCode qr={qr} failed={failed} which={which} />
      <div className="tagobj__body">
        <p className="pp-label">{label}</p>
        <p className="tagobj__uri">{payload}</p>
        {/* The one thing this screen must never get wrong is what a sticker does once it exists. */}
        {plays && <p className="tagobj__plays">{plays}</p>}
        {failed && (
          <p className="tagobj__warn">
            couldn&apos;t reach the server — this is what it should say, not
            what was read
          </p>
        )}
        {/* State in words, with the tick as a second channel rather than the only one. */}
        <p
          className={`tagobj__state${written ? " tagobj__state--written" : ""}`}
        >
          {written ? "✓ written" : "not written yet"}
        </p>
        {onWritten && !written && (
          <AsyncButton
            className="pp-action tagobj__mark"
            pendingLabel="RECORDING…"
            onClick={onWritten}
          >
            I&apos;VE WRITTEN THIS ONE
          </AsyncButton>
        )}
      </div>
    </div>
  );
}

export function TagsPanel({
  curatorId,
  asset,
  run,
}: {
  curatorId: string;
  asset: AlbumAsset;
  run: Run;
}) {
  const [sent, setSent] = useState<string | null>(null);
  const tag = asset.tag;
  const state = asset.roadie.state;
  const verifiedAt = asset.verification?.physicallyVerifiedAt;

  /**
   * The human path through the state machine is still linear (`HUMAN_TRANSITIONS`), even though the
   * record page lets the four needs be done in any order. So the button is disabled with its reason
   * rather than offering a press that 409s — curator-ui-ux §4: the gate is shown, not hidden.
   */
  const canVerify =
    state === "awaiting_tag_write" || state === "awaiting_verify";
  const why = verifiedAt
    ? `checked ${relativeTime(verifiedAt)}`
    : "The lights, a visualizer and a card come first — this is the last step.";

  /**
   * What the demo tag will actually do — the one fact this screen could silently get wrong.
   *
   * With no chosen cut the tag plays the whole record, exactly like the shelf card, and saying so
   * here is the difference between "the tag is broken" and "I never picked a song". The choosing
   * itself lives on its own tab (ADR 0058); this is a statement, not a control.
   */
  const demoPlays = asset.demoTrack
    ? `plays “${asset.demoTrack.name}”`
    : "no cut chosen — plays the whole record";

  return (
    <div className="tags">
      <div className="tags__objects">
        {OBJECTS.map(({ which, label }) => (
          <TagSticker
            key={which}
            curatorId={curatorId}
            which={which}
            label={label}
            written={tag?.[which]?.written ?? false}
            {...(which === "demo"
              ? {
                  plays: demoPlays,
                  // The demo tag is the one sticker TAGS VERIFIED does not cover, so it needs its
                  // own record — otherwise it reads "not written yet" forever after you wrote it.
                  onWritten: () =>
                    run(() => api.markTagWritten(curatorId, "demo")),
                }
              : {})}
          />
        ))}
      </div>

      <div className="tags__actions">
        <AsyncButton
          className="pp-action"
          pendingLabel="SENDING…"
          onClick={() =>
            run(async () => {
              const r = await api.pushAlbumToFlipper(curatorId);
              setSent(`on the Flipper — ${r.total} on the card, at ${r.port}`);
            })
          }
        >
          SEND THIS RECORD TO THE FLIPPER
        </AsyncButton>
        <a className="pp-action" href={tagNfcUrl(curatorId, "sleeve")} download>
          DOWNLOAD .NFC
        </a>
        <a className="pp-action" href={tagNfcUrl(curatorId, "demo")} download>
          DOWNLOAD DEMO .NFC
        </a>
        <Link className="pp-action" to="/help/tags">
          HOW DO I WRITE THESE?
        </Link>
        {sent && <span className="tags__sent">{sent}</span>}
      </div>

      <div className="tags__check">
        <p className="pp-label tags__check-head">THEN CHECK THEM</p>
        <div className="tags__check-row">
          <p className="tags__check-copy">
            Tap each tag on your phone and confirm it opens the right record.{" "}
            <span className="tags__warn">This is where the bugs turn up.</span>
          </p>
          <AsyncButton
            className="pp-btn tags__verify"
            disabled={!canVerify}
            title={canVerify ? "Records both tags written, and checked" : why}
            pendingLabel="RECORDING…"
            onClick={() => run(() => api.verifyTags(curatorId))}
          >
            {verifiedAt ? "TAGS VERIFIED ✓" : "TAGS VERIFIED"}
          </AsyncButton>
        </div>
        {!canVerify && <p className="tags__why">{why}</p>}
      </div>
    </div>
  );
}
