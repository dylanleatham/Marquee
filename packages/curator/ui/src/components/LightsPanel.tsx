import { useCallback, useEffect, useRef, useState } from "react";
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
import { AsyncButton } from "./common";
import type { Run } from "./workflow";

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
 * Dropped from the old bench and deliberately not reinstated: the artwork override, the source
 * badge, the genre tags, and the raw `{"transitionMs":…}` JSON.
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

  if (!asset.palette)
    return (
      <p className="pp-prose">
        Roadie hasn&apos;t pulled the lights for this record yet.
      </p>
    );

  const candidates = asset.paletteCandidates;
  const source = asset.palette.source ?? "cover";
  const onFeeling = source === "feeling" || source === "blend";
  const rows = lightRows(draft);
  // Roadie only writes a note when it has proposed colours from how the record sounds; a plain
  // cover extraction has nothing to say, and inventing a sentence would be worse than the gap.
  const note = asset.palette.rationale ?? candidates?.rationale;

  return (
    <div className="lights">
      <SavedLine state={save} />

      {note && <p className="lights__note pp-prose">{note}</p>}

      <div className="lights__sources">
        <SourceCard
          label="FROM THE SLEEVE"
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
        </div>
        <p className="lights__reassure">
          Roadie&apos;s original extraction and the feeling palette are always
          here — nothing you do to this list destroys either.
        </p>
      </div>
    </div>
  );
}

/** The autosave line. Says the rule as well as the state, so the missing Save button is explained. */
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
