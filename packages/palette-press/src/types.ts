// Public types for Palette Press. The PalettePayload return shape comes from
// @marquee/contracts (the integration contract is the source of truth for that).

import type { AudioFeatures } from "@marquee/contracts";

export type { AudioFeatures };

export type RGB = [number, number, number]; // 0..255 each

export interface AlbumMetadata {
  curatorId: string;
  name?: string;
  artist?: string;
  year?: number;
  spotifyUri?: string;
  /**
   * Optional audio descriptors (energy/tempo/…). When present, they refine pattern selection —
   * tempo-locking motion and widening dynamics (ADR 0022). Absent for most albums today (Spotify's
   * audio-features endpoint is deprecated); pattern energy then comes from the palette itself.
   */
  audioFeatures?: AudioFeatures;
}

export interface ExtractOptions {
  maxColorCount?: number; // default 64
  quality?: number; // 1..5, default 3 (1 = best/slowest)
}

export interface PostProcessOptions {
  minSaturation?: number; // 0..1, default 0.15
  saturationBoost?: number; // 0..1, default 0.4 (target when below floor)
  minBrightness?: number; // 0..1, default 0.25
  minDeltaE?: number; // default 15
  maxColors?: number; // default 4
  maxGamutShift?: number; // default 0.1 — drop a swatch if projecting it into gamut moves it more than this
  monochromeChroma?: number; // default 0.12 — below this max chroma the art is treated as monochrome
  hueSpreadDeg?: number; // default 10 — if all colors fall within this hue arc, treat as monochrome
  orderColorFloor?: number; // default 0.2 — min chroma for a swatch to be ranked as "colorful" when ordering
}

/** Optional per-swatch pixel populations, used to order the palette dominant-color first. */
export type SwatchPopulations = Partial<Record<SwatchName, number>>;

export type GenerateOptions = ExtractOptions & PostProcessOptions;

/** Vibrant's six named swatches (any may be absent on restricted-palette art). */
export interface RawSwatches {
  vibrant?: RGB;
  lightVibrant?: RGB;
  darkVibrant?: RGB;
  muted?: RGB;
  lightMuted?: RGB;
  darkMuted?: RGB;
}

export type Role = "primary" | "secondary" | "accent";

export interface PaletteColor {
  hex: string; // "#RRGGBB", uppercase
  cie_xy: [number, number]; // precomputed for Conductor's benefit
  role: Role;
  sourceSwatch: string; // e.g. "DarkVibrant" — debug info
}

export interface Palette {
  colors: PaletteColor[]; // 2..maxColors
  insufficient: false;
}

export interface InsufficientPaletteResult {
  colors: PaletteColor[]; // 0..1 items; whatever survived
  insufficient: true;
  reason: "monochrome" | "all_clamped" | "unusable_art";
}

export type PaletteResult = Palette | InsufficientPaletteResult;

export type Pattern =
  | { type: "static"; params: Record<string, never> }
  | { type: "crossfade"; params: { transitionMs: number; holdMs: number } }
  | {
      type: "rotate";
      params: { intervalMs: number; direction: "forward" | "reverse" };
    }
  | {
      type: "pulse";
      params: {
        periodMs: number;
        minBrightness: number;
        maxBrightness: number;
      };
    };

// Preference order Vibrant swatches are considered in (best first). Drives role assignment.
export const SWATCH_ORDER = [
  "vibrant",
  "darkVibrant",
  "lightVibrant",
  "muted",
  "darkMuted",
  "lightMuted",
] as const;

export type SwatchName = (typeof SWATCH_ORDER)[number];

/** Human-facing swatch label for the `sourceSwatch` debug field. */
export const SWATCH_LABEL: Record<SwatchName, string> = {
  vibrant: "Vibrant",
  darkVibrant: "DarkVibrant",
  lightVibrant: "LightVibrant",
  muted: "Muted",
  darkMuted: "DarkMuted",
  lightMuted: "LightMuted",
};
