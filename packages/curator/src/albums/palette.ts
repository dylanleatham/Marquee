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

// --- palette provenance + blending (ADR 0030, issue #105) ---------------------------------------

/**
 * Where a palette's colours came from. Absent on albums created before ADR 0030, which is read as
 * `"cover"` — every palette was an extraction until this existed.
 *
 * This is provenance for display. The *protection* against being overwritten stays `handEdited`,
 * which choosing anything but the cover also sets: "a human decided this palette" is already exactly
 * what that flag means, and one guard is better than two that must agree.
 */
export type PaletteSource = "cover" | "feeling" | "blend" | "hand";

/** Human-facing label for each source, so the Look workstation never shows a bare enum. */
export const PALETTE_SOURCE_LABEL: Record<PaletteSource, string> = {
  cover: "From the cover",
  feeling: "From the feeling",
  blend: "Blend",
  hand: "Hand-edited",
};

/**
 * The blend: the cover's dominant colour, then the feeling's colours behind it.
 *
 * Keeping the cover's primary is the whole point — the room still reads as the object on the stand,
 * and the feeling only changes the colours around it. Taking the *first* cover swatch rather than
 * mixing channels keeps every colour one that something actually chose; averaging two palettes
 * produces muddy in-between hues that neither the sleeve nor the record justifies, and a Hue bulb
 * renders those worst of all.
 *
 * Deduped on hex so the blend never shows the same colour twice, and capped at MAX_PALETTE_COLORS.
 */
export function blendPalettes(
  cover: PaletteEditColor[],
  feeling: PaletteEditColor[],
): PaletteEditColor[] {
  const dominant = cover[0];
  const merged = dominant ? [dominant, ...feeling] : [...feeling];
  const seen = new Set<string>();
  const out: PaletteEditColor[] = [];
  for (const c of merged) {
    const key = normalizeHex(c.hex);
    if (seen.has(key)) continue;
    seen.add(key);
    // Roles are positional after the blend — the caller's sanitize assigns them — so drop any
    // inherited role rather than carrying two "primary"s into the same list.
    out.push({ hex: key });
    if (out.length === MAX_PALETTE_COLORS) break;
  }
  return out;
}
