// Where each light lands in the room (ADR 0052).
//
// The old editor named a colour's slot after the data model — `primary` / `secondary` / `accent`
// picked from a dropdown. That tells you what the field is called, not what the colour *does*. Here
// the order is the meaning: the first colour washes the wall, the second lands in the far corner,
// the third glows behind the stand. Reordering is the edit; the labels follow.
//
// Pure, no React.
import type { PaletteColor, PaletteRole } from "./api";

export interface LightRow {
  hex: string;
  /** DOMINANT / SECOND / ACCENT — derived from position, never stored per row. */
  role: string;
  /** Plain English for where it lands. The reason to care about the order. */
  note: string;
  /** What the server stores for this slot. Positional, matching its own `roleForIndex`. */
  apiRole: PaletteRole;
}

const SLOTS: Array<{ role: string; note: string; apiRole: PaletteRole }> = [
  { role: "DOMINANT", note: "the wall wash", apiRole: "primary" },
  { role: "SECOND", note: "the far corner", apiRole: "secondary" },
  { role: "ACCENT", note: "the glow behind the stand", apiRole: "accent" },
];

/**
 * Past the third, a colour has no place of its own in the room — the runtime cycles it. Saying
 * "spare" is honest; inventing a fourth location would be a promise the lights don't keep.
 */
const SPARE = {
  role: "SPARE",
  note: "held in reserve",
  apiRole: "accent" as const,
};

export const describeLight = (index: number): Omit<LightRow, "hex"> =>
  SLOTS[index] ?? SPARE;

/** The palette as the panel lists it: order is authoritative, so the roles are read off position. */
export const lightRows = (colors: readonly { hex: string }[]): LightRow[] =>
  colors.map((c, i) => ({ hex: c.hex.toUpperCase(), ...describeLight(i) }));

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

/** A hex the server will accept, or null. Used to hold back an autosave mid-typing. */
export const validHex = (hex: string): string | null =>
  HEX_RE.test(hex) ? hex.toUpperCase() : null;

/** Up to eight. Beyond that the room is a slideshow, not a wash. */
export const MAX_LIGHTS = 8;

/** Stable identity for a palette, so "has this actually changed?" is a string compare. */
export const paletteSignature = (colors: readonly { hex: string }[]): string =>
  colors.map((c) => c.hex.toUpperCase()).join("|");

/** Read the stored colours into the shape the editor edits. */
export const toEditable = (
  colors: readonly PaletteColor[] | undefined,
): Array<{ hex: string }> =>
  (colors ?? []).map((c) => ({ hex: validHex(c.hex) ?? "#000000" }));
