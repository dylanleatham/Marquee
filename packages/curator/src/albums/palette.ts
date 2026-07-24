// Hand-edited palette validation (curator-spec §Palettes). Turns a user-supplied set of swatches
// into the same PaletteColor[] shape Palette Press produces: hex validated + normalized, cie_xy
// recomputed and gamut-clamped (mirroring postProcessPalette) so a hand-edited color is as Hue-safe
// as a generated one, and roles assigned. Pure — no I/O. The three palette *actions* live in
// actions.ts; this module owns only the validation so it's testable in isolation.
import {
  rgbToCieXy,
  clampToGamutC,
  type RGB,
  type Role,
} from "@marquee/palette-press";
import type { PaletteSection } from "./asset.js";
import { ValidationError } from "./add-manual.js";

/** A single swatch as it arrives from the editor: a required hex, an optional explicit role. */
export interface PaletteEditColor {
  hex: string;
  role?: Role;
}

/** Contract bounds — the shared PalettePayload allows 1..8 colors (integration-contract §palette). */
export const MIN_PALETTE_COLORS = 1;
export const MAX_PALETTE_COLORS = 8;

const HEX_RE = /^#?[0-9a-fA-F]{6}$/;
const ROLES: readonly Role[] = ["primary", "secondary", "accent"];

/** Normalize to "#RRGGBB" (uppercase, leading "#"). Throws ValidationError on a malformed value. */
export function normalizeHex(hex: unknown): string {
  if (typeof hex !== "string" || !HEX_RE.test(hex.trim()))
    throw new ValidationError(
      `invalid hex color ${JSON.stringify(hex)} — expected #RRGGBB`,
    );
  return "#" + hex.trim().replace(/^#/, "").toUpperCase();
}

function hexToRgb(hex: string): RGB {
  const h = hex.replace(/^#/, "");
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

/** Default role by final position (0 = primary/dominant), mirroring Palette Press's roleForIndex. */
const roleForIndex = (i: number): Role =>
  i === 0 ? "primary" : i === 1 ? "secondary" : "accent";

/**
 * Validate + normalize an editor palette into stored PaletteColor[]. Order is authoritative: the
 * first swatch is the dominant/primary. An explicit role overrides the positional default (the UI's
 * role dropdowns); omit it to take the position-derived role. cie_xy is recomputed and gamut-clamped
 * exactly as postProcessPalette does, so the runtime payload stays well-formed. Throws
 * ValidationError (→ 400) on any malformed input.
 */
export function sanitizePaletteEdit(input: unknown): PaletteSection["colors"] {
  if (!Array.isArray(input))
    throw new ValidationError("palette must be an array of { hex, role? }");
  if (input.length < MIN_PALETTE_COLORS || input.length > MAX_PALETTE_COLORS)
    throw new ValidationError(
      `palette must have ${MIN_PALETTE_COLORS}..${MAX_PALETTE_COLORS} colors (got ${input.length})`,
    );

  return input.map((raw, i) => {
    if (typeof raw !== "object" || raw === null)
      throw new ValidationError(`palette[${i}] must be an object`);
    const { hex, role } = raw as { hex?: unknown; role?: unknown };
    const normHex = normalizeHex(hex);
    if (role !== undefined && !ROLES.includes(role as Role))
      throw new ValidationError(
        `palette[${i}] has invalid role ${JSON.stringify(role)} — expected primary|secondary|accent`,
      );
    const { xy } = clampToGamutC(rgbToCieXy(hexToRgb(normHex)));
    return {
      hex: normHex,
      cie_xy: xy,
      role: (role as Role) ?? roleForIndex(i),
      sourceSwatch: "HandEdited",
    };
  });
}
