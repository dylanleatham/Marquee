// The album-assets file shape (curator-spec §7). Step-3 subset — video/card/tag/verification
// sections arrive in later steps. TODO: promote to @marquee/contracts (album-asset.schema.json)
// once the shape settles, and validate on save.
import type { GeneratedPalettePayload } from "@marquee/palette-press";

export type RoadieState =
  | "fresh"
  | "awaiting_review"
  | "awaiting_video"
  | "awaiting_preview"
  | "awaiting_tag_write"
  | "awaiting_verify"
  | "verified"
  | "errored"
  | "needs_manual";

export interface AlbumMetadata {
  name: string;
  artist: string;
  year?: number;
  genres?: string[];
  source: "manual" | "spotify";
  spotifyUri?: string;
  spotifyArtUrl?: string;
}

export interface AlbumAsset {
  version: 1;
  curatorId: string;
  createdAt: string;
  metadata: AlbumMetadata;
  artwork: {
    resolvedPath: string;
    overrideActive: boolean;
    contentHash: string;
  };
  palette: {
    colors: Array<{
      hex: string;
      cie_xy?: [number, number];
      role: string;
      sourceSwatch?: string;
    }>;
    generatedAt: string;
    algorithm: string;
    handEdited: boolean;
    insufficient?: boolean;
    reason?: string;
  };
  pattern: {
    type: string;
    params: Record<string, unknown>;
    handEdited: boolean;
  };
  roadie: {
    state: RoadieState;
    subState: string | null;
    flags: {
      palette_insufficient: boolean;
      album_not_on_spotify: boolean;
      art_override_active: boolean;
    };
    history: Array<{ state: string; at: string }>;
    lastError: null | { message: string };
    retryCount: number;
    syncIssues: string[];
  };
  status: { highLevel: string; next: string | null; issues: string[] };
}

/** Build a fresh asset for a manually-added album whose palette has been generated. */
export function buildManualAsset(args: {
  curatorId: string;
  metadata: AlbumMetadata;
  artworkPosixPath: string;
  contentHash: string;
  palette: GeneratedPalettePayload;
  now?: () => string;
}): AlbumAsset {
  const now = args.now ?? (() => new Date().toISOString());
  const at = now();
  const insufficient = Boolean(args.palette.palette.insufficient);

  return {
    version: 1,
    curatorId: args.curatorId,
    createdAt: at,
    metadata: args.metadata,
    artwork: {
      resolvedPath: args.artworkPosixPath,
      overrideActive: false,
      contentHash: args.contentHash,
    },
    palette: {
      colors: args.palette.palette.colors,
      generatedAt: args.palette.meta?.generatedAt ?? at,
      algorithm: args.palette.meta?.generator ?? "palette-press",
      handEdited: false,
      ...(insufficient
        ? { insufficient: true, reason: args.palette.palette.reason }
        : {}),
    },
    pattern: {
      type: args.palette.pattern.type,
      params: args.palette.pattern.params,
      handEdited: false,
    },
    roadie: {
      state: "awaiting_review",
      subState: null,
      flags: {
        palette_insufficient: insufficient,
        album_not_on_spotify: false,
        art_override_active: false,
      },
      history: [{ state: "awaiting_review", at }],
      lastError: null,
      retryCount: 0,
      syncIssues: [],
    },
    status: {
      highLevel: "awaiting_review",
      next: "review palette",
      issues: [],
    },
  };
}
