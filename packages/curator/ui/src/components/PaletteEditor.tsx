import { useEffect, useState } from "react";
import {
  api,
  type AlbumAsset,
  type PaletteColor,
  type PaletteEditColor,
  type PaletteRole,
} from "../api";
import type { Run } from "./workflow";
import { AsyncButton } from "./common";
import { useConfirm } from "./Confirm";
import { usePrimaryAction } from "../primaryAction";

const ROLES: PaletteRole[] = ["primary", "secondary", "accent"];
const MAX_COLORS = 8;
const HEX_RE = /^#[0-9a-fA-F]{6}$/;

/** Positional default role (0 = primary/dominant), matching the server's roleForIndex. */
const roleForIndex = (i: number): PaletteRole =>
  i === 0 ? "primary" : i === 1 ? "secondary" : "accent";

type DraftColor = { hex: string; role: PaletteRole };

const normHex = (hex: string): string =>
  HEX_RE.test(hex) ? hex.toUpperCase() : "#000000";

const toDraft = (colors: PaletteColor[]): DraftColor[] =>
  colors.map((c, i) => ({
    hex: normHex(c.hex),
    role: (ROLES as string[]).includes(c.role)
      ? (c.role as PaletteRole)
      : roleForIndex(i),
  }));

const sig = (colors: DraftColor[]): string =>
  colors.map((c) => `${c.hex}:${c.role}`).join("|");

/** Re-derive roles from position — used after any reorder/add/remove so order stays authoritative. */
const repositioned = (colors: DraftColor[]): DraftColor[] =>
  colors.map((c, i) => ({ ...c, role: roleForIndex(i) }));

/**
 * The palette editor (curator-spec §album-detail: "swatches + editor + role dropdowns + reset to
 * auto"). Order is authoritative — the top swatch is the dominant/primary, and reorder/add/remove
 * re-derive roles by position; the per-row dropdown then fine-tunes a single role. Edits are local
 * until Save (PUT /palette). "Reset to auto" re-extracts from the cover art. A live strip mirrors the
 * draft as you edit; the Demo Room is the full hardware rehearsal.
 */
export function PaletteEditor({
  curatorId,
  asset,
  run,
}: {
  curatorId: string;
  asset: AlbumAsset;
  run: Run;
}) {
  const confirm = useConfirm();
  const palette = asset.palette;
  const serverColors = palette?.colors ?? [];

  const [draft, setDraft] = useState<DraftColor[]>(() => toDraft(serverColors));
  // The server signature the draft was last synced from; drives dirty + reconciliation.
  const [syncedSig, setSyncedSig] = useState<string>(() =>
    sig(toDraft(serverColors)),
  );

  const serverSig = sig(toDraft(serverColors));
  const dirty = sig(draft) !== syncedSig;

  // Adopt server-side palette changes (re-extract / reset / another tab) — but never clobber
  // in-progress local edits. When dirty, the user resolves via Save or Discard.
  useEffect(() => {
    if (!dirty && serverSig !== syncedSig) {
      setDraft(toDraft(serverColors));
      setSyncedSig(serverSig);
    }
    // serverSig is the meaningful trigger; the rest is read inside.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverSig]);

  const setHex = (i: number, hex: string) =>
    setDraft((d) =>
      d.map((c, j) => (j === i ? { ...c, hex: normHex(hex) } : c)),
    );
  const setRole = (i: number, role: PaletteRole) =>
    setDraft((d) => d.map((c, j) => (j === i ? { ...c, role } : c)));
  const move = (i: number, delta: number) =>
    setDraft((d) => {
      const j = i + delta;
      if (j < 0 || j >= d.length) return d;
      const next = [...d];
      [next[i], next[j]] = [next[j]!, next[i]!];
      return repositioned(next);
    });
  const remove = (i: number) =>
    setDraft((d) =>
      d.length <= 1 ? d : repositioned(d.filter((_, j) => j !== i)),
    );
  const add = () =>
    setDraft((d) =>
      d.length >= MAX_COLORS
        ? d
        : repositioned([...d, { hex: "#888888", role: "accent" }]),
    );

  const discard = () => {
    setDraft(toDraft(serverColors));
    setSyncedSig(serverSig);
  };

  const save = () =>
    run(async () => {
      const colors: PaletteEditColor[] = draft.map((c) => ({
        hex: c.hex,
        role: c.role,
      }));
      await api.editPalette(curatorId, colors);
      // Adopt what we just sent as the new baseline so the row clears "unsaved" immediately.
      setSyncedSig(sig(draft));
    });

  const reExtract = () =>
    run(async () => {
      const force = palette?.handEdited === true;
      if (
        force &&
        !(await confirm({
          title: "Re-extract from the cover art?",
          body: "This discards the hand-edited palette and replaces it with a fresh Palette Press extraction.",
          confirmLabel: "Re-extract",
          destructive: true,
        }))
      )
        return;
      await api.regeneratePalette(curatorId, force);
    });

  // Look's primary action (⌘⏎, curator-ui-ux §9.1). Saving is the one thing this bench exists to
  // commit — re-extract and reset both throw work away, which is not what a bare accelerator should
  // reach. Declared unconditionally, above the `!palette` return, because hooks may not sit behind
  // a branch; the null hands the slot back so the header says "no primary action" instead.
  usePrimaryAction(
    palette
      ? {
          label: "Save palette",
          run: save,
          ...(dirty
            ? {}
            : { disabledReason: "no unsaved changes to the palette" }),
        }
      : null,
  );

  if (!palette) return null;

  return (
    <div className="palette-editor">
      <PalettePreview colors={draft} pattern={asset.pattern?.type} />

      <ul className="palette-editor__rows">
        {draft.map((c, i) => (
          <li className="palette-editor__row" key={i}>
            <span
              className="palette-editor__chip"
              style={{ background: c.hex }}
              aria-hidden="true"
            />
            <input
              type="color"
              className="palette-editor__picker"
              aria-label={`Color ${i + 1} picker`}
              value={c.hex}
              onChange={(e) => setHex(i, e.target.value)}
            />
            <input
              type="text"
              className="palette-editor__hex"
              aria-label={`Color ${i + 1} hex`}
              value={c.hex}
              spellCheck={false}
              onChange={(e) => setHex(i, e.target.value)}
            />
            <select
              className="palette-editor__role"
              aria-label={`Color ${i + 1} role`}
              value={c.role}
              onChange={(e) => setRole(i, e.target.value as PaletteRole)}
            >
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
            <span className="palette-editor__pos">
              {i === 0 ? "dominant" : `#${i + 1}`}
            </span>
            <span className="palette-editor__moves">
              <button
                className="btn btn--sm btn--ghost"
                aria-label={`Move color ${i + 1} up`}
                title="Move up (more dominant)"
                disabled={i === 0}
                onClick={() => move(i, -1)}
              >
                ↑
              </button>
              <button
                className="btn btn--sm btn--ghost"
                aria-label={`Move color ${i + 1} down`}
                title="Move down"
                disabled={i === draft.length - 1}
                onClick={() => move(i, 1)}
              >
                ↓
              </button>
              <button
                className="btn btn--sm btn--ghost"
                aria-label={`Remove color ${i + 1}`}
                title="Remove"
                disabled={draft.length <= 1}
                onClick={() => remove(i)}
              >
                ✕
              </button>
            </span>
          </li>
        ))}
      </ul>

      <div className="palette-editor__actions">
        <button
          className="btn btn--sm"
          onClick={add}
          disabled={draft.length >= MAX_COLORS}
          title={draft.length >= MAX_COLORS ? "Up to 8 colors" : "Add a color"}
        >
          + Color
        </button>
        <AsyncButton
          className="btn btn--sm btn--primary"
          onClick={save}
          disabled={!dirty}
          pendingLabel="Saving…"
        >
          Save palette
        </AsyncButton>
        <button
          className="btn btn--sm btn--ghost"
          onClick={discard}
          disabled={!dirty}
        >
          Discard
        </button>
        <AsyncButton
          className="btn btn--sm btn--ghost"
          onClick={reExtract}
          disabled={dirty}
          title={
            dirty
              ? "Save or discard your edits first"
              : "Re-run Palette Press from the cover art"
          }
        >
          Reset to auto
        </AsyncButton>
      </div>
      {dirty && (
        <p className="palette-editor__hint muted">
          Unsaved changes — Save to keep them, or Discard to revert.
        </p>
      )}
    </div>
  );
}

/** A live strip of the current draft: a gradient plus labeled chips. Reflects edits instantly. */
function PalettePreview({
  colors,
  pattern,
}: {
  colors: DraftColor[];
  pattern?: string;
}) {
  const stops = colors.map((c) => c.hex);
  const gradient =
    stops.length === 1
      ? stops[0]
      : `linear-gradient(90deg, ${stops.join(", ")})`;
  return (
    <div className="palette-editor__preview" data-testid="palette-preview">
      <div
        className="palette-editor__preview-bar"
        style={{ background: gradient }}
        aria-hidden="true"
      />
      <div className="palette-editor__preview-label muted">
        Live preview{pattern ? ` · ${pattern}` : ""}
      </div>
    </div>
  );
}
