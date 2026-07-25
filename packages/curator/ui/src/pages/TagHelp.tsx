// How to write an NFC tag (issue #103). Replaces the specced "tag placement guide" — a free-text
// Settings field you had to author yourself, which teaches nobody anything.
//
// In-app rather than a link out: Curator is a LAN-only desktop tool, and this is read while standing
// at the shelf with a sticker in hand. The two happy paths are covered end to end here; the
// exhaustive firmware caveats stay in the runbook (§A7) so there is one home for the deep detail
// rather than two copies that drift.
import { Link, useSearchParams } from "react-router-dom";

/** Deep-linkable so the Ship workstation can drop you at the path you asked about. */
type Path = "phone" | "flipper";

export function TagHelp() {
  const [params, setParams] = useSearchParams();
  const active: Path = params.get("path") === "flipper" ? "flipper" : "phone";
  const show = (p: Path) => setParams(p === "phone" ? {} : { path: p });

  return (
    <div className="page taghelp">
      <div className="page__head">
        <h1>Writing NFC tags</h1>
        <Link to="/" className="btn btn--ghost">
          ← Queue
        </Link>
      </div>

      <p className="muted">
        Each album needs its URI written to an NFC sticker. You only ever do
        this once per physical object, and Curator gives you everything you need
        on the album's <strong>Ship</strong> workstation.
      </p>

      {/* The single most consequential thing on this page: getting it wrong fails silently. */}
      <section className="taghelp__warn">
        <h2>Sleeve and card are different tags</h2>
        <p>
          A <strong>sleeve</strong> carries <code>curator:album:…</code> — the
          lights and the video come up, and you drop the needle on the vinyl
          yourself. A <strong>card</strong> carries <code>curator:card:…</code>{" "}
          — same lights and video, but Amp also streams the album over Sonos.
        </p>
        <p>
          They are <em>not</em> interchangeable, and writing the wrong one fails
          quietly: the tag writes perfectly and simply does the wrong thing when
          you scan it. Ship shows each object's URI and QR on its own row —
          check you're on the right one before you write.
        </p>
      </section>

      <h3 className="group-head">What you need</h3>
      <ul className="taghelp__list">
        <li>
          <strong>NTAG213 stickers</strong>, 25 mm round. White-face if you may
          want to write on them, clear to keep them invisible on the sleeve.
        </li>
        <li>
          One sticker per physical object — a sleeve tag per album, plus a card
          tag for any album you print a card for.
        </li>
        <li>
          Either an <strong>iPhone or Android phone</strong> with NFC Tools, or
          a <strong>Flipper Zero</strong>. Both paths are below; neither is
          better, they just suit different moments.
        </li>
      </ul>

      <div className="modes" role="tablist" aria-label="Tag writing method">
        <button
          role="tab"
          aria-selected={active === "phone"}
          className={`modes__tab ${active === "phone" ? "is-active" : ""}`}
          onClick={() => show("phone")}
        >
          Phone
          <em>One tag at a time, nothing to carry</em>
        </button>
        <button
          role="tab"
          aria-selected={active === "flipper"}
          className={`modes__tab ${active === "flipper" ? "is-active" : ""}`}
          onClick={() => show("flipper")}
        >
          Flipper Zero
          <em>Good for a batch, and for verifying</em>
        </button>
      </div>

      {active === "phone" ? (
        <section className="taghelp__steps">
          <h2>Writing with a phone</h2>
          <ol>
            <li>
              Install <strong>NFC Tools</strong> (free, iOS and Android). NXP
              TagWriter works the same way.
            </li>
            <li>
              Open the album's <strong>Ship</strong> workstation in Curator and{" "}
              <strong>scan the QR</strong> for the object you're writing. That
              puts the exact URI on your phone without typing it — which
              matters, because a mistyped id produces a tag that writes fine and
              never resolves.
            </li>
            <li>
              In NFC Tools: <strong>Write</strong> →{" "}
              <strong>Add a record</strong> → <strong>Custom URL / URI</strong>.
              Paste the URI. (A <em>Text</em> record works too — Marquee reads
              either.)
            </li>
            <li>
              Tap <strong>Write</strong>, then hold the sticker against the
              phone's NFC antenna until it confirms. On iPhone the antenna is at
              the <em>top edge</em> of the back; on most Androids it's the
              middle.
            </li>
          </ol>
          <p className="muted">
            This is the path of least friction when every tag is different,
            which is the normal case — each album has its own id.
          </p>
        </section>
      ) : (
        <section className="taghelp__steps">
          <h2>Writing with a Flipper Zero</h2>
          <ol>
            <li>
              On the album's <strong>Ship</strong> workstation, download the{" "}
              <strong>.nfc</strong> file for the object you're writing. Curator
              lays the NDEF record out exactly as the stand expects, so there is
              nothing to compose by hand.
            </li>
            <li>
              Copy the file onto the Flipper's SD card under{" "}
              <code>/ext/nfc/</code> — qFlipper does this over USB.
            </li>
            <li>
              On the Flipper: <strong>NFC</strong> → <strong>Saved</strong> →
              pick the file → <strong>Write</strong>.
            </li>
            <li>
              Hold a <strong>blank</strong> NTAG213 against the Flipper's back
              until it confirms. A previously-written tag can usually be
              overwritten; a locked one cannot.
            </li>
          </ol>
          <p className="muted">
            The Flipper is also the best way to <strong>check</strong> a tag:{" "}
            <strong>NFC → Read</strong> shows the UID and parses the NDEF, so
            you can confirm a sticker carries the URI you meant before it goes
            on a sleeve.
          </p>
        </section>
      )}

      <section className="taghelp__warn">
        <h2>Never set lock or password pages</h2>
        <p>
          NTAG213's <strong>lock bits</strong> and <strong>password</strong>{" "}
          pages are one-way. A write that sets them can permanently freeze the
          tag read-only or lock you out of it entirely. Write the NDEF data and
          nothing else — avoid any "lock", "set password", or "protect" option
          in either app.
        </p>
      </section>

      <h3 className="group-head">Where to stick it</h3>
      <p>
        Pick one spot and keep to it for every sleeve — the stand reads best
        when the tag lands in the same place each time. The back cover,
        upper-right, is a good default: clear of the spine, clear of where your
        hand grips, and consistent across single and gatefold sleeves. For
        cards, the back, centred.
      </p>

      <h3 className="group-head">Then check it works</h3>
      <ol className="taghelp__list">
        <li>
          Before you commit, run <strong>Preview → Room rehearsal</strong>. It
          fires the real scan event at the lights, display and Sonos, so you
          know the album itself is wired correctly.
        </li>
        <li>
          Stick the tag on, then place the sleeve on the stand. Lights and video
          should come up within a second; lifting it should fade both back.
        </li>
        <li>
          Mark it written on <strong>Ship</strong>, then{" "}
          <strong>Verify physical</strong> once you've seen it work.
        </li>
      </ol>

      <p className="muted taghelp__more">
        Deeper detail — firmware differences, cloning tags, emulating one for
        bench testing without a sticker — lives in the repo runbook, §A7.
      </p>
    </div>
  );
}
