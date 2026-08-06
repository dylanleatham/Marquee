import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, tagNfcUrl, type AlbumAsset } from "../api";
import { relativeTime } from "../format";
import { AsyncButton } from "./common";
import type { Run } from "../run";

/**
 * The tags panel (ADR 0052) — the two stickers, and the one check that catches real bugs.
 *
 * Changes from the old Ship workstation:
 *
 * - **One button for both tags.** Marking the sleeve written and the card written were bookkeeping
 *   about a single act at the Flipper. What is left is the *check* — and it stays a distinct,
 *   visually separated step, because tapping each tag is where a mis-written sticker turns up.
 * - **Per record only.** The bulk "send the whole list to the Flipper" went with the queue; you
 *   write these one record at a time, standing at the shelf.
 * - **No explanatory intro.** The QR, the URI and the state say what this is.
 */

type Which = "sleeve" | "card";

const OBJECTS: Array<{ which: Which; label: string }> = [
  { which: "sleeve", label: "THE SLEEVE" },
  { which: "card", label: "THE SHELF CARD" },
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
function useTagPayload(curatorId: string, which: Which) {
  const derived = `curator:${which === "sleeve" ? "album" : "card"}:${curatorId}`;
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
  which: Which;
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

/** One object's panel — its code, its URI, and whether the sticker is burned. */
function TagObject({
  curatorId,
  which,
  label,
  written,
}: {
  curatorId: string;
  which: Which;
  label: string;
  written: boolean;
}) {
  const { payload, qr, failed } = useTagPayload(curatorId, which);
  return (
    <div className={`tagobj${written ? " tagobj--written" : ""}`}>
      <TagCode qr={qr} failed={failed} which={which} />
      <div className="tagobj__body">
        <p className="pp-label">{label}</p>
        <p className="tagobj__uri">{payload}</p>
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

  return (
    <div className="tags">
      <div className="tags__objects">
        {OBJECTS.map(({ which, label }) => (
          <TagObject
            key={which}
            curatorId={curatorId}
            which={which}
            label={label}
            written={tag?.[which]?.written ?? false}
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
