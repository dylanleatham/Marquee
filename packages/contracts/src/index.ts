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
  | { transitionMs: number; holdMs: number } // crossfade
  | { speed?: number; scale?: number; brightness?: number } // aurora (streaming)
  | { speed?: number; intensity?: number } // shimmer (streaming)
  | { speed?: number; angleDeg?: number }; // wave (streaming)

/**
 * Streaming effects rendered over the Entertainment API (ADR 0023/0024) rather than CLIP. A Conductor
 * without a configured entertainment area falls back to a CLIP pattern, so these are safe to send.
 */
export type StreamPatternType = "aurora" | "shimmer" | "wave";

/**
 * Optional per-album audio descriptors (integration-contract §1 `meta.audioFeatures`). Present only
 * when a generator had access — Spotify's audio-features endpoint is deprecated, so today this is a
 * hand-authored / future-analyzer signal, not an automatic one. The producer uses it (when present)
 * to refine pattern params — tempo-locking motion, widening dynamics with energy (ADR 0022). All
 * fields optional; consumers ignore what they don't understand.
 */
export interface AudioFeatures {
  energy?: number; // 0..1
  valence?: number; // 0..1
  tempo?: number; // BPM
  danceability?: number; // 0..1
}

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
    type: "static" | "rotate" | "pulse" | "crossfade" | StreamPatternType;
    params: PatternParams;
  };
  meta?: {
    generatedAt?: string;
    generator?: string;
    audioFeatures?: AudioFeatures;
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
  /**
   * Raw NFC tag UID, e.g. "04:A1:B2:C3:D4:E5:F6". Informational downstream, but a real `start`
   * always carries one — required here to match scan-event.schema.json's `then.required`.
   */
  tagUid: string;
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
// The map *value* in Backdrop's URI → video-file map (backdrop-spec §9): the `uri` is the map key,
// so it is not repeated in the value here. On the wire (POST /api/library/sync) each element carries
// its own `uri` — that's the shape library-entry.schema.json describes (`{ uri } & LibraryEntry`).
// Curator pushes these; the video files themselves are synced out-of-band (rsync).

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

// --- Album → PalettePayload mapping (Curator Demo Room + Conductor /api/scan) -------------------
// The narrow slice of an album asset needed to build the light-show payload. Curator's full
// AlbumAsset satisfies this structurally, so both Curator (Demo Room) and Conductor (which reads the
// synced album-assets store at scan time, issue #45 / ADR 0019) map the same way via one function.

/** The minimum an album must carry to drive a light show. `AlbumAsset` is a structural superset. */
export interface AlbumPaletteInput {
  metadata: { name: string; artist: string; year?: number };
  palette?: {
    colors: Array<{ hex: string; role: string; cie_xy?: [number, number] }>;
  };
  pattern?: { type: string; params: unknown };
}

/** The album isn't far enough along to drive a light show (no palette/pattern yet). Callers → 409. */
export class PaletteNotReadyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PaletteNotReadyError";
  }
}

const PALETTE_ROLES: PaletteRole[] = ["primary", "secondary", "accent"];
const asRole = (role: string): PaletteRole =>
  (PALETTE_ROLES as string[]).includes(role) ? (role as PaletteRole) : "accent";

const PATTERN_TYPES: PalettePayload["pattern"]["type"][] = [
  "static",
  "rotate",
  "pulse",
  "crossfade",
  "aurora",
  "shimmer",
  "wave",
];

/**
 * Map a stored album into the palette+pattern payload Conductor plays. Throws PaletteNotReadyError if
 * the album has no palette/pattern yet (still in Roadie's pipeline). Roles/pattern-type outside the
 * contract's unions are coerced to safe defaults rather than rejected — the light show is best-effort.
 */
export function buildPalettePayload(asset: AlbumPaletteInput): PalettePayload {
  if (!asset.palette || asset.palette.colors.length === 0)
    throw new PaletteNotReadyError("album has no palette yet");
  if (!asset.pattern)
    throw new PaletteNotReadyError("album has no pattern yet");

  const type = (PATTERN_TYPES as string[]).includes(asset.pattern.type)
    ? (asset.pattern.type as PalettePayload["pattern"]["type"])
    : "static";

  return {
    version: 1,
    source: {
      type: "album",
      name: asset.metadata.name,
      artist: asset.metadata.artist,
      ...(asset.metadata.year ? { year: asset.metadata.year } : {}),
    },
    palette: {
      colors: asset.palette.colors.map((c) => ({
        hex: c.hex,
        role: asRole(c.role),
        ...(c.cie_xy ? { cie_xy: c.cie_xy } : {}),
      })),
    },
    pattern: {
      type,
      params: asset.pattern.params as PalettePayload["pattern"]["params"],
    },
  };
}
