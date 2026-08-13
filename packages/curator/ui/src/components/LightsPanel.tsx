import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  api,
  ApiError,
  type AlbumAsset,
  type PaletteColor,
  type PaletteSource,
} from "../api";
import {
  MAX_LIGHTS,
  lightRows,
  paletteSignature,
  toEditable,
  validHex,
} from "../lights";
import { relativeTime } from "../format";
import { usePending, useUpload } from "../hooks";
import { AsyncButton, pickFile } from "./common";
import { useConfirm } from "./Confirm";
import { UploadStrip } from "./UploadStrip";
import type { Run } from "../run";

/**
 * The Lights panel (ADR 0052) — the record's default tab.
 *
 * Three changes from the old Look workstation, each deliberate:
 *
 * 1. **Edits autosave.** There is no Save button and no ⌘⏎. The old bench made you commit an edit
 *    you had already made and could already see; the only thing the button added was a way to lose
 *    work by navigating away.
 * 2. **Both source palettes are permanent.** Switching never destroys either, and the feeling
 *    palette does not disappear once suggested — the server was made to honour that (ADR 0052).
 * 3. **Order is the meaning.** A colour's slot says where it lands in the room ("the wall wash"),
 *    not what the field is called. The role dropdown is gone; reordering is the edit.
 *
 * Dropped from the old bench and deliberately not reinstated: the source badge, the genre tags, and
 * the raw `{"transitionMs":…}` JSON.
 *
 * **Back, on purpose: the artwork override**
 * ([ADR 0084](../../../../../docs/adrs/0084-your-own-cover-is-a-palette-control.md)). It was dropped
 * with the rest of the old Look station, and that was the wrong cut: the other three are ways of
 * *displaying* a palette, but the cover is the palette's **input**, and a bad scan is a colour
 * problem with no other answer on this screen. It lives beside BACK TO ROADIE'S ORIGINAL rather
 * than on a tab of its own, because that is where you are standing when you find out.
 */

/** Long enough that a drag on the colour picker is one save, short enough to feel immediate. */
const AUTOSAVE_MS = 700;

type SaveState =
  | { kind: "clean" }
  | { kind: "saving" }
  | { kind: "saved"; at: string }
  /** Sentences, never codes — this line sits under the user's own edit. */
  | { kind: "failed"; why: string };

/**
 * Branches on the *status*, not on the message text: 409 is the server's "Roadie holds this record"
 * (ADR 0025), and matching prose would break the moment that sentence is reworded.
 */
const whyFailed = (e: unknown): string => {
  if (e instanceof ApiError && e.status === 409)
    return "Roadie is working on this record — your change will need another go in a moment.";
  const msg = (e as Error)?.message ?? "";
  return `That didn't save — ${msg || "try again"}.`;
};

export function LightsPanel({
  curatorId,
  asset,
  refresh,
  run,
}: {
  curatorId: string;
  asset: AlbumAsset;
  refresh: () => void;
  run: Run;
}) {
  const serverColors = asset.palette?.colors;
  const serverSig = paletteSignature(serverColors ?? []);

  const [draft, setDraft] = useState(() => toEditable(serverColors));
  const [save, setSave] = useState<SaveState>({ kind: "clean" });
  const cover = useUpload();
  const confirm = useConfirm();
  /**
   * Whether a cover change is anywhere in its run — **not** just while bytes are moving.
   *
   * `cover.inFlight` only covers the transfer, and a cover change starts well before that: it
   * flushes the autosave first, which is a real round-trip with no dialog on screen yet to catch a
   * second click. Gating the button on `inFlight` left exactly that gap open. Once the §12 dialog
   * mounts, its scrim (`position:fixed; inset:0`) takes the clicks instead, so the flush is the only
   * unguarded window — but it is a network call, which is long enough to double-click through.
   */
  const [changing, whileChanging] = usePending();
  // The signature this component last sent or adopted. Anything else arriving from the poll is a
  // change from elsewhere (a palette swap, a sweep, Roadie) and is adopted.
  const syncedSig = useRef(serverSig);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  // Read by the unmount flush, which must not close over a stale draft.
  const pending = useRef<string[] | null>(null);

  const commit = useCallback(
    async (hexes: string[]) => {
      pending.current = null;
      syncedSig.current = hexes.join("|");
      setSave({ kind: "saving" });
      try {
        await api.editPalette(
          curatorId,
          hexes.map((hex) => ({ hex })),
        );
        setSave({ kind: "saved", at: new Date().toISOString() });
        refresh();
      } catch (e) {
        setSave({ kind: "failed", why: whyFailed(e) });
      }
    },
    [curatorId, refresh],
  );

  /**
   * Flush on unmount. Without this, autosave would be *worse* than the old Save button: an edit made
   * inside the debounce window and then navigated away from would be silently lost, which is exactly
   * the failure the button at least made visible.
   */
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
      const last = pending.current;
      if (!last) return;
      void api
        .editPalette(
          curatorId,
          last.map((hex) => ({ hex })),
        )
        // The component is gone, so there is no longer anywhere on screen to say this. Swallowing
        // it entirely would defeat the flush, though — a 409 or a dropped connection here loses the
        // edit as silently as having no flush at all — so it goes to the console, where the colours
        // are printed alongside it and the loss is at least diagnosable.
        .catch((e: unknown) =>
          console.error(
            "[curator-ui] a palette edit was lost on the way out:",
            curatorId,
            last,
            e,
          ),
        );
    },
    [curatorId],
  );

  /** Adopt a palette that changed under us — but never on top of an edit in flight. */
  useEffect(() => {
    if (pending.current || serverSig === syncedSig.current) return;
    syncedSig.current = serverSig;
    setDraft(toEditable(serverColors));
    setSave({ kind: "clean" });
    // `serverSig` is the meaningful trigger; the colours are read through it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverSig]);

  const edit = (next: Array<{ hex: string }>) => {
    setDraft(next);
    // A half-typed hex is not a palette. Hold the save rather than writing "#12" and 400ing.
    const hexes = next.map((c) => validHex(c.hex));
    if (hexes.some((h) => h === null)) return;
    pending.current = hexes as string[];
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(
      () => void commit(hexes as string[]),
      AUTOSAVE_MS,
    );
  };

  const setHex = (i: number, hex: string) =>
    edit(draft.map((c, j) => (j === i ? { hex } : c)));
  const move = (i: number, delta: number) => {
    const j = i + delta;
    if (j < 0 || j >= draft.length) return;
    const next = [...draft];
    [next[i], next[j]] = [next[j]!, next[i]!];
    edit(next);
  };
  const remove = (i: number) =>
    draft.length > 1 && edit(draft.filter((_, j) => j !== i));
  const add = () =>
    draft.length < MAX_LIGHTS && edit([...draft, { hex: "#888888" }]);

  const choose = (source: PaletteSource) =>
    run(async () => {
      pending.current = null;
      if (timer.current) clearTimeout(timer.current);
      await api.choosePalette(curatorId, source);
      setSave({ kind: "clean" });
    });

  /**
   * Settle the autosave, then ask curator-spec §12's question — the dialog it has specified since
   * the override was first built ("You have a hand-edited palette. Regenerate with new art?").
   *
   * Three things happen here and **the order is the point**, because a cover change is the one
   * action on this panel that can overlap an autosave still in flight:
   *
   * 1. **Disarm the debounce first, synchronously.** The dialog waits on a human, so it is open for
   *    an unbounded time — far longer than the 700ms window. A timer left armed across it fires
   *    mid-dialog, and its `PUT` can land *after* the server has re-extracted, putting the old
   *    colours straight back on top of the new cover. Clearing after the `await` does not prevent
   *    that; it only tidies up once the damage is possible. `choose` clears synchronously and this
   *    has to match it.
   * 2. **Flush what was queued rather than dropping it.** Those are the user's most recent
   *    keystrokes. The unmount flush exists because losing them is worse than having no autosave at
   *    all, and uploading a cover is not a licence to lose them — least of all when the answer below
   *    is "keep my colours". `commit` never rejects, so a failed flush surfaces on the saved line
   *    instead of taking the upload down with it.
   * 3. **Count a queued edit as a hand-edit.** `asset.palette.handEdited` is the *server's* view and
   *    it is one poll behind — an edit made three seconds ago has not reached it. Asking on that
   *    flag alone would skip the dialog for exactly the person who is mid-edit, which is the one
   *    person with something to lose.
   *
   * Both answers go through with the cover change; the question is only what happens to the colours.
   * So the dismissals — Escape, clicking the scrim — land on `false`, the side that loses nothing. A
   * palette nobody has touched skips the dialog entirely: there is no edit to protect, and
   * re-deriving is the whole reason you uploaded a cover.
   */
  const settleThenAsk = async (coverEither: string): Promise<boolean> => {
    if (timer.current) clearTimeout(timer.current);
    const queued = pending.current;
    if (queued) await commit(queued);
    if (!queued && asset.palette?.handEdited !== true) return true;
    return confirm({
      title: "Pull new colours from it?",
      body: `You have edited these lights by hand. ${coverEither} either way — this is only about the colours.`,
      confirmLabel: "PULL NEW COLOURS",
      cancelLabel: "KEEP MY COLOURS",
    });
  };

  /** Your own cover, when the one Roadie found is a bad scan. Roadie extracts from this instead. */
  const uploadCover = (file: File) =>
    whileChanging(() =>
      run(async () => {
        const regenerate = await settleThenAsk("The new cover goes on");
        await cover.send(file, (opts) =>
          api.uploadArtworkOverride(curatorId, file, regenerate, opts),
        );
        setSave({ kind: "clean" });
      }),
    );

  const dropCover = () =>
    whileChanging(() =>
      run(async () => {
        const regenerate = await settleThenAsk("Roadie's cover comes back");
        await api.removeArtworkOverride(curatorId, regenerate);
        setSave({ kind: "clean" });
      }),
    );

  if (!asset.palette)
    return (
      <p className="pp-prose">
        Roadie hasn&apos;t pulled the lights for this record yet.
      </p>
    );

  const candidates = asset.paletteCandidates;
  const source = asset.palette.source ?? "cover";
  const onFeeling = source === "feeling" || source === "blend";
  // Your own cover is in force, so every sentence on this panel that says "the sleeve" now means it.
  const ownCover = asset.artwork?.overrideActive === true;
  const rows = lightRows(draft);
  // Roadie only writes a note when it has proposed colours from how the record sounds; a plain
  // cover extraction has nothing to say, and inventing a sentence would be worse than the gap.
  const note = asset.palette.rationale ?? candidates?.rationale;

  return (
    <div className="lights">
      <SavedLine state={save} />
      <SignOffLine
        curatorId={curatorId}
        at={asset.verification?.previewApprovedAt}
      />

      {note && <p className="lights__note pp-prose">{note}</p>}

      <div className="lights__sources">
        <SourceCard
          /* Not "FROM THE SLEEVE" while an upload is in force — the card would be naming a cover
             the record is not using, which is the one thing this control makes possible. */
          label={ownCover ? "FROM YOUR COVER" : "FROM THE SLEEVE"}
          colors={candidates?.cover ?? (onFeeling ? [] : asset.palette.colors)}
          inUse={!onFeeling}
          onUse={() => choose("cover")}
        />
        <SourceCard
          label="FROM THE FEELING"
          colors={candidates?.feeling ?? []}
          inUse={onFeeling}
          onUse={() => choose("feeling")}
          {...(candidates
            ? {}
            : {
                /* Not yet suggested. Asking spends a Gemini call, so the control says so. */
                propose: () => run(() => api.feelingPalette(curatorId)),
              })}
        />
      </div>

      <div>
        <p className="pp-label lights__heading">THE LIGHTS, IN ORDER</p>
        <ul className="lights__rows">
          {rows.map((r, i) => (
            <li className="lights__row" key={i}>
              <span
                className="lights__swatch"
                style={{ background: r.hex }}
                aria-hidden="true"
              />
              <input
                type="color"
                className="lights__picker"
                aria-label={`Light ${i + 1} colour`}
                value={validHex(draft[i]!.hex) ?? "#000000"}
                onChange={(e) => setHex(i, e.target.value)}
              />
              <input
                type="text"
                className="lights__hex"
                aria-label={`Light ${i + 1} hex`}
                spellCheck={false}
                value={draft[i]!.hex}
                onChange={(e) => setHex(i, e.target.value)}
              />
              <span className="lights__role">{r.role}</span>
              <span className="lights__where">{r.note}</span>
              <span className="lights__moves">
                <button
                  type="button"
                  aria-label={`Move light ${i + 1} earlier`}
                  title="Earlier — more of the room"
                  disabled={i === 0}
                  onClick={() => move(i, -1)}
                >
                  ↑
                </button>
                <button
                  type="button"
                  aria-label={`Move light ${i + 1} later`}
                  title="Later"
                  disabled={i === rows.length - 1}
                  onClick={() => move(i, 1)}
                >
                  ↓
                </button>
                <button
                  type="button"
                  aria-label={`Remove light ${i + 1}`}
                  title="Remove"
                  disabled={rows.length <= 1}
                  onClick={() => remove(i)}
                >
                  ✕
                </button>
              </span>
            </li>
          ))}
        </ul>

        <div className="lights__actions">
          <button
            type="button"
            className="pp-action"
            onClick={add}
            disabled={draft.length >= MAX_LIGHTS}
            title={
              draft.length >= MAX_LIGHTS
                ? "Eight is the most a room can wash with"
                : "Add a light"
            }
          >
            + ADD A LIGHT
          </button>
          <AsyncButton
            className="pp-action"
            onClick={() => choose("cover")}
            pendingLabel="PULLING THEM AGAIN…"
          >
            BACK TO ROADIE&apos;S ORIGINAL
          </AsyncButton>
          {/* The palette's *input*, next to the two controls that re-derive from it.
              Deliberately not an `AsyncButton`, though its neighbour is: this click's own promise
              settles the moment the OS file chooser opens, so a spinner bound to it would flash and
              vanish before any work started, and the label would lie. `changing` is what the two
              share instead — it spans the whole run, including the autosave flush that happens
              before the dialog is up to intercept anything. */}
          <button
            type="button"
            className="pp-action"
            disabled={changing}
            onClick={() => pickFile("image/png,image/jpeg", uploadCover)}
            title="Roadie pulls the colours from this instead of the sleeve it found"
          >
            UPLOAD A DIFFERENT COVER
          </button>
          {ownCover && (
            <AsyncButton
              className="pp-action"
              disabled={changing}
              onClick={dropCover}
              pendingLabel="PUTTING IT BACK…"
              title="Drop your cover and go back to the one Roadie found"
            >
              USE THE COVER ROADIE FOUND
            </AsyncButton>
          )}
        </div>
        <UploadStrip upload={cover.inFlight} />
        <p className="lights__reassure">
          Roadie&apos;s original extraction and the feeling palette are always
          here — nothing you do to this list destroys either.
        </p>
        {/* Said in words, because with a cover of your own in force BACK TO ROADIE'S ORIGINAL
            re-extracts from *that* — the label is otherwise the only thing on screen still
            promising the sleeve Roadie found. */}
        {ownCover && (
          <p className="lights__reassure">
            Your own cover is the one in force, so both the sleeve colours and
            BACK TO ROADIE&apos;S ORIGINAL come from it rather than from the
            cover Roadie found. That cover was never deleted — USE THE COVER
            ROADIE FOUND brings it back.
          </p>
        )}
      </div>
    </div>
  );
}

/** The autosave line. Says the rule as well as the state, so the missing Save button is explained. */
/**
 * Whether the lights have been signed off, said on the tab that owns them (ADR 0063).
 *
 * The tab's `●`/`○` already carries this, but a glyph is not an explanation: the user's report that
 * opened #263 was "the circle is always open and I can't mark it as verified" — the state was on
 * screen and the way to change it was not. Signing off still happens only in the room, so this is a
 * sentence and a way there, never a second approve button.
 */
function SignOffLine({
  curatorId,
  at,
}: {
  curatorId: string;
  at: string | undefined;
}) {
  return (
    <p className="lights__signoff">
      <span
        className={`pp-dot${at ? " pp-dot--positive" : ""}`}
        aria-hidden="true"
      />
      {at ? (
        `signed off ${relativeTime(at)}`
      ) : (
        <>
          not signed off yet —{" "}
          <Link to={`/room/${curatorId}`}>see it in the room</Link>
        </>
      )}
    </p>
  );
}

function SavedLine({ state }: { state: SaveState }) {
  if (state.kind === "failed")
    return <p className="lights__saved lights__saved--failed">{state.why}</p>;
  const words =
    state.kind === "saving"
      ? "saving…"
      : state.kind === "saved"
        ? `saved ${relativeTime(state.at)}`
        : "edits save as you make them";
  return (
    <p className="lights__saved">
      <span className="pp-dot pp-dot--positive" aria-hidden="true" />
      {state.kind === "clean"
        ? words
        : `${words} — edits save as you make them`}
    </p>
  );
}

function SourceCard({
  label,
  colors,
  inUse,
  onUse,
  propose,
}: {
  label: string;
  colors: PaletteColor[];
  inUse: boolean;
  onUse: () => void;
  /** Present only when this palette has not been suggested yet. Spends a Gemini call. */
  propose?: () => void;
}) {
  return (
    <div className={`lights__source${inUse ? " lights__source--inuse" : ""}`}>
      <p className="lights__source-head">
        <span>{label}</span>
        {inUse && <span className="lights__inuse">· IN USE</span>}
      </p>
      {colors.length > 0 ? (
        <div className="lights__source-bar" aria-hidden="true">
          {colors.map((c, i) => (
            <span key={`${c.hex}-${i}`} style={{ background: c.hex }} />
          ))}
        </div>
      ) : (
        <div
          className="lights__source-bar lights__source-bar--empty"
          aria-hidden="true"
        />
      )}
      {propose ? (
        <AsyncButton
          className="pp-action"
          onClick={propose}
          pendingLabel="ASKING ROADIE…"
          title="Costs one Gemini call"
        >
          ◈ ASK FOR THESE
        </AsyncButton>
      ) : (
        <button
          type="button"
          className="pp-action"
          onClick={onUse}
          disabled={inUse || colors.length === 0}
        >
          {inUse ? "IN USE" : "USE THIS INSTEAD →"}
        </button>
      )}
    </div>
  );
}
