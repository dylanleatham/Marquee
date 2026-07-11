// @marquee/contracts — the single source of truth for cross-service shapes.
//
// Schemas live in ../schemas/*.json. Run `pnpm --filter @marquee/contracts gen`
// to (re)generate TypeScript types into ./generated from those schemas, then
// re-export them here. Until codegen is wired, hand-written types can live here.
//
// See docs/specs/integration-contract.md for the authoritative contract doc.

export const CONTRACTS_VERSION = 1 as const;

// Hand-written types mirroring the JSON schemas in ../schemas/. Kept in sync by the
// contract tests (which validate real payloads against the schemas). When schema→TS
// codegen is wired (scripts/gen-schemas.mjs), these get replaced by generated exports.

export type PaletteRole = "primary" | "secondary" | "accent";

export interface PaletteColor {
  hex: string; // "#RRGGBB", uppercase
  cie_xy?: [number, number];
  role: PaletteRole;
  sourceSwatch?: string;
}

export type PatternParams =
  | Record<string, never> // static
  | { intervalMs: number; direction: "forward" | "reverse" } // rotate
  | { periodMs: number; minBrightness: number; maxBrightness: number } // pulse
  | { transitionMs: number; holdMs: number }; // crossfade

export interface PalettePayload {
  version: 1;
  source: {
    type: "album" | "manual" | "test";
    spotifyId?: string;
    name?: string;
    artist?: string;
    year?: number;
    artworkUrl?: string;
  };
  palette: { colors: PaletteColor[] };
  pattern: {
    type: "static" | "rotate" | "pulse" | "crossfade";
    params: PatternParams;
  };
  meta?: {
    generatedAt?: string;
    generator?: string;
    audioFeatures?: {
      energy?: number;
      valence?: number;
      tempo?: number;
      danceability?: number;
    };
  };
}

// TODO(build order step 0): also export ScanEvent, LibraryEntry, AlbumAsset (hand-written or
// generated) as those boundaries get built out.
