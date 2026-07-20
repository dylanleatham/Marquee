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

// --- Runtime scan events (Stylus → Conductor + Backdrop) ---------------------------------------
// The fan-out signal: Stylus reads a tagged sleeve and POSTs one of these to each runtime service
// (integration-contract §scan, stylus-spec §"Outbound events"). `stop` deliberately carries no
// `uri` — downstream treats it as "return to idle" regardless of what was playing.

/** A sleeve was placed on the stand. */
export interface ScanStartEvent {
  event: "start";
  /** Curator album URI, `curator:album:<curatorId>`. */
  uri: string;
  /** Raw NFC tag UID, e.g. "04:A1:B2:C3:D4:E5:F6". Informational. */
  tagUid?: string;
  /** Which physical stand fired this; defaults to "primary". Downstream may ignore it. */
  readerId?: string;
  /** ISO-8601 timestamp the event was produced. */
  at: string;
}

/** The sleeve was removed. No `uri`: return to idle whatever was playing. */
export interface ScanStopEvent {
  event: "stop";
  readerId?: string;
  at: string;
}

export type ScanEvent = ScanStartEvent | ScanStopEvent;

// --- Backdrop library entries (Curator → Backdrop) ---------------------------------------------
// One row of Backdrop's URI → video-file map (backdrop-spec §9). Curator pushes these; the video
// files themselves are synced out-of-band (rsync). Keyed by album URI in the library map.

export interface LibraryEntry {
  /** Absolute path to the visualizer file on the Backdrop Pi. */
  filePath: string;
  /** Video duration in seconds. Informational today. */
  durationSec?: number;
  /** Content hash so Curator's sync knows when a video changed and needs re-pushing. */
  contentHash?: string;
}

// TODO(build order): also export AlbumAsset (hand-written or generated) once that boundary is
// promoted out of curator/src/albums/asset.ts.
