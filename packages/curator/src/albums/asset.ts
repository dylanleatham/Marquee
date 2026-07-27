// The album-assets file shape (curator-spec §7). Roadie (step 5) drives an album from `fresh`
// through the processing sub-states to an `awaiting_*` handoff, so palette/pattern/promptDrafts are
// optional — they don't exist until Roadie generates them.
// TODO: promote to @marquee/contracts (album-asset.schema.json) once the shape settles.
import type { GeneratedPalettePayload } from "@marquee/palette-press";
import type { PromptDrafts } from "../roadie/prompts.js";

/** States Roadie advances through on its own (roadie-spec §5), before a human handoff. */
export type RoadieProcessingState =
  | "fresh"
  | "fetching_metadata"
  | "downloading_art"
  | "generating_palette"
  | "drafting_prompts";

/** States a human advances (or terminal states Roadie parks an album in). */
export type RoadieHumanState =
  | "awaiting_review"
  | "awaiting_video"
  | "awaiting_preview"
  | "awaiting_tag_write"
  | "awaiting_verify"
  | "verified"
  | "errored"
  | "needs_manual";

export type RoadieState = RoadieProcessingState | RoadieHumanState;

/** The states Roadie actively works — the worker processes an album while it's in one of these. */
export const PROCESSING_STATES: readonly RoadieProcessingState[] = [
  "fresh",
  "fetching_metadata",
  "downloading_art",
  "generating_palette",
  "drafting_prompts",
];

export const isProcessingState = (s: RoadieState): s is RoadieProcessingState =>
  (PROCESSING_STATES as readonly string[]).includes(s);

export interface AlbumMetadata {
  name: string;
  artist: string;
  year?: number;
  genres?: string[];
  source: "manual" | "spotify" | "discogs";
  spotifyUri?: string;
  spotifyArtUrl?: string;
  /** Stable Discogs release id + `discogs:release:<id>` URI (dedupe key, parallel to spotifyUri). */
  discogsReleaseId?: number;
  discogsUri?: string;
  discogsArtUrl?: string;
}

export interface PaletteSection {
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
  /**
   * Where these colours came from (ADR 0030). Absent on albums predating it, which reads as
   * `"cover"` — every palette was a cover extraction until this existed. Provenance only: the guard
   * against being overwritten is `handEdited`, which choosing a non-cover palette also sets.
   */
  source?: "cover" | "feeling" | "blend" | "hand";
  /** One line on why these colours, for a feeling/blend palette (ADR 0030). */
  rationale?: string;
}

/**
 * Proposals from the feeling pass, waiting to be chosen or ignored (ADR 0030). Stored on the asset
 * so you can weigh them against the sleeve, reload, and still be looking at them — the same shape as
 * `cardArtCandidates`: generate a set, choose one, discard the rest.
 */
export interface PaletteCandidates {
  generatedAt: string;
  rationale: string;
  /**
   * The cover extraction as it stood when the pass ran. Snapshotted because choosing a feeling
   * palette *replaces* the stored one — without this the UI could offer "From the cover" with no
   * swatches to show, and you'd be picking between an option you can see and one you can't.
   */
  cover: PaletteSection["colors"];
  feeling: PaletteSection["colors"];
  blend: PaletteSection["colors"];
}

export interface PatternSection {
  type: string;
  params: Record<string, unknown>;
  handEdited: boolean;
}

/** The runtime-facing visualizer video (curator-spec §7), present once a video is attached. */
export interface VisualizerSection {
  fileId: string;
  originalFilename: string;
  durationSec?: number;
  resolution?: string;
  loopStrategy: "loop";
  attachedAt: string;
  notes?: string;
}

/** The Curator-only printed card art (curator-spec §7), present once card art is attached. */
export interface CardArtSection {
  fileId: string;
  originalFilename: string;
  /** Stored file extension (png/jpg) — needed to resolve the file on disk. */
  ext: string;
  resolution?: string;
  orientation?: "landscape" | "portrait";
  attachedAt: string;
  notes?: string;
}

/**
 * One Gemini-generated card-art candidate (curator-spec §Card art). Roadie/actions generate a set
 * (one per card-art prompt variant); the human promotes the best one to the attached `cardArt`.
 * Stored on disk at card-art/{curatorId}-c{index}.{ext}.
 */
export interface CardArtCandidate {
  index: number;
  /** `${curatorId}-c${index}` — the disk key for this candidate's image. */
  fileId: string;
  ext: string;
  resolution?: string;
  orientation?: "landscape" | "portrait";
  /** The prompt variant's nudge label this image was generated from (for the gallery). */
  nudge?: string;
  /**
   * True when the first attempt was refused *with* the cover attached and the retry without it
   * succeeded (ADR 0032). Recorded because a `coverAnchored` option quietly ceasing to be anchored
   * changes what the image is — it no longer re-renders the sleeve — and that should be visible
   * rather than inferred from the picture looking wrong.
   */
  coverReferenceDropped?: boolean;
  generatedAt: string;
}

/**
 * A card-art variant Gemini declined on both attempts (ADR 0032). Kept so a missing slot in the
 * gallery explains itself: before this, a refused variant simply wasn't there, with no log line and
 * nothing on the asset (issue #152).
 */
export interface CardArtRefusal {
  index: number;
  /** The prompt variant's nudge label, so the refusal names the option a human recognizes. */
  nudge?: string;
  /** Gemini's own words — `IMAGE_RECITATION`, `SAFETY; HARM_CATEGORY_…` — never normalized. */
  reason: string;
  /** True when the retry without the cover reference was also refused. */
  retriedWithoutCover: boolean;
  at: string;
}

/**
 * One Gemini-generated visualizer clip (roadie-spec §7 / ADR 0011). Roadie/actions generate a set
 * (one per video prompt variant), grounded on the album cover; the human downloads them and splices
 * them into the final looping visualizer externally (in-app splicing is deferred). Stored on disk at
 * visualizers/{curatorId}-v{index}.mp4 with a thumbnail at thumbnails/{curatorId}-v{index}.jpg.
 */
export interface VideoClip {
  index: number;
  /** `${curatorId}-v${index}` — the disk key for this clip's mp4 + thumbnail. */
  fileId: string;
  durationSec?: number;
  resolution?: string;
  /** The prompt variant's nudge label this clip was generated from (for the gallery). */
  nudge?: string;
  generatedAt: string;
}

export interface VerificationSection {
  previewApprovedAt?: string;
  physicallyVerifiedAt?: string;
}

/** Per-physical-object tag-write status (curator-spec §7). Sleeve and card are tracked separately
 * since one may be written without the other (sleeve today, card printed + tagged next week). */
export interface TagObjectSection {
  written: boolean;
  writtenAt?: string;
  /** The NTAG's UID, if the writer captured it (optional bookkeeping). */
  tagUid?: string;
}

export interface TagSection {
  /**
   * The **sleeve** URI, `curator:album:<id>`. Since ADR 0023 the two stickers carry different URIs —
   * a card is `curator:card:<id>` (derived from the same curatorId) so Amp can tell them apart. This
   * field is the sleeve/album URI; the card URI comes from the `?object=card` tag download.
   */
  payload: string;
  sleeve?: TagObjectSection;
  card?: TagObjectSection;
}

export interface RoadieSection {
  state: RoadieState;
  subState: string | null;
  flags: {
    palette_insufficient: boolean;
    album_not_on_spotify: boolean;
    art_override_active: boolean;
  };
  history: Array<{ state: string; at: string }>;
  lastError: null | { message: string; reason?: string };
  retryCount: number;
  syncIssues: string[];
}

export interface AlbumAsset {
  version: 1;
  curatorId: string;
  createdAt: string;
  metadata: AlbumMetadata;
  /** Present once art has been downloaded/uploaded (absent while `fresh`/`fetching_metadata`). */
  artwork?: {
    resolvedPath: string;
    overrideActive: boolean;
    contentHash: string;
    /** Where the auto-downloaded cover came from (issue #58). A Discogs album resolves to Spotify
     * art on a confident match, else the Discogs image; absent for a manual override. */
    source?: "spotify" | "discogs";
  };
  /** Present once Palette Press has run. */
  palette?: PaletteSection;
  /** Present once a feeling pass has run and before a choice is made (ADR 0030). */
  paletteCandidates?: PaletteCandidates;
  /** Present once Palette Press has run (pattern travels with the palette payload). */
  pattern?: PatternSection;
  /** Present once Roadie has drafted the video + card-art prompts. */
  promptDrafts?: PromptDrafts;
  /** Present once a video is attached (step 7). */
  visualizer?: VisualizerSection;
  /** Gemini-generated visualizer clips (ADR 0011); the human downloads + splices them externally. */
  videoClips?: VideoClip[];
  /** Present once card art is attached (step 7). */
  cardArt?: CardArtSection;
  /** Gemini-generated card-art candidates (curator-spec §Card art); the human picks one to attach. */
  cardArtCandidates?: CardArtCandidate[];
  /** Variants Gemini refused outright, so an absent candidate explains itself (ADR 0032). */
  cardArtRefusals?: CardArtRefusal[];
  /** Per-object tag-write status (step 11); `tag.payload` is the URI written to both stickers. */
  tag?: TagSection;
  /** Preview-approval and physical-verification timestamps (steps 7/11). */
  verification?: VerificationSection;
  roadie: RoadieSection;
  status: { highLevel: string; next: string | null; issues: string[] };
}

/** History is capped so a long-lived album's file doesn't grow without bound (roadie-spec §9). */
export const HISTORY_CAP = 30;

/** Human-facing "what's next" label for the derived status block (curator-spec §7 `status`). */
const NEXT_ACTION: Record<RoadieState, string | null> = {
  fresh: "queued",
  fetching_metadata: "fetching metadata",
  downloading_art: "downloading art",
  generating_palette: "generating palette",
  drafting_prompts: "drafting prompts",
  awaiting_review: "review palette",
  awaiting_video: "attach video",
  awaiting_preview: "preview and approve",
  awaiting_tag_write: "write tag",
  awaiting_verify: "physically verify",
  verified: null,
  errored: "retry",
  needs_manual: "resolve manually",
};

/** Recompute the derived `status` block from Roadie state + issues (curator-spec §7: not stored). */
export function deriveStatus(roadie: RoadieSection): AlbumAsset["status"] {
  const issues = [...roadie.syncIssues];
  if (roadie.lastError) issues.push(roadie.lastError.message);
  return {
    highLevel: roadie.state,
    next: NEXT_ACTION[roadie.state] ?? null,
    issues,
  };
}

/**
 * Legal human-driven transitions (roadie-spec §5). Roadie only ever forward-transitions its own
 * processing states; the human steps are advanced from the UI. `awaiting_preview` can also step
 * *back* to review/video — the preview's "Something's off" escape hatch (curator-spec §10).
 */
const HUMAN_TRANSITIONS: Record<string, RoadieHumanState[]> = {
  // review → preview skips awaiting_video: attaching a video you already have (ADR 0005).
  awaiting_review: ["awaiting_video", "awaiting_preview"],
  awaiting_video: ["awaiting_preview"],
  awaiting_preview: ["awaiting_tag_write", "awaiting_review", "awaiting_video"],
  awaiting_tag_write: ["awaiting_verify"],
  awaiting_verify: ["verified"],
};

export const canTransition = (
  from: RoadieState,
  to: RoadieHumanState,
): boolean => HUMAN_TRANSITIONS[from]?.includes(to) ?? false;

export class TransitionError extends Error {
  constructor(
    readonly from: RoadieState,
    readonly to: RoadieHumanState,
  ) {
    super(`Cannot move album from ${from} to ${to}`);
    this.name = "TransitionError";
  }
}

/** Append a history entry, capped at HISTORY_CAP (shared with the worker's advance path). */
export function pushHistory(
  roadie: RoadieSection,
  state: RoadieState,
  at: string,
): void {
  roadie.history.push({ state, at });
  if (roadie.history.length > HISTORY_CAP)
    roadie.history.splice(0, roadie.history.length - HISTORY_CAP);
}

/**
 * Apply a human-driven state transition, or throw TransitionError if it isn't legal from the
 * album's current state. Clears any stale error and recomputes the derived status. Callers persist.
 */
export function transitionTo(
  asset: AlbumAsset,
  to: RoadieHumanState,
  now: () => string,
): void {
  if (!canTransition(asset.roadie.state, to))
    throw new TransitionError(asset.roadie.state, to);
  asset.roadie.state = to;
  asset.roadie.subState = null;
  asset.roadie.lastError = null;
  pushHistory(asset.roadie, to, now());
  asset.status = deriveStatus(asset.roadie);
}

function freshRoadie(state: RoadieState, at: string): RoadieSection {
  return {
    state,
    subState: isProcessingState(state) ? state : null,
    flags: {
      palette_insufficient: false,
      album_not_on_spotify: false,
      art_override_active: false,
    },
    // Record the state the album is actually entering; the worker appends each subsequent one.
    history: [{ state, at }],
    lastError: null,
    retryCount: 0,
    syncIssues: [],
  };
}

/**
 * Build a newly-added album ready for Roadie to process. Spotify/Discogs albums start at
 * `fetching_metadata` (name/artist arrive with the fetch); manual albums already carry metadata +
 * art, so they start at `generating_palette`. Enqueue the returned asset's curatorId after saving.
 */
export function buildFreshAsset(args: {
  curatorId: string;
  metadata: AlbumMetadata;
  /** Set for manual adds (art uploaded up front); omitted for Spotify (downloaded by Roadie). */
  artwork?: { resolvedPath: string; contentHash: string };
  now?: () => string;
}): AlbumAsset {
  const at = (args.now ?? (() => new Date().toISOString()))();
  // Manual albums arrive with metadata + art already saved, so they jump straight to palette
  // generation. Spotify and Discogs both fetch metadata + art off the request path first.
  const startState: RoadieState =
    args.metadata.source === "manual"
      ? "generating_palette"
      : "fetching_metadata";
  const roadie = freshRoadie(startState, at);
  return {
    version: 1,
    curatorId: args.curatorId,
    createdAt: at,
    metadata: args.metadata,
    ...(args.artwork
      ? {
          artwork: {
            resolvedPath: args.artwork.resolvedPath,
            overrideActive: false,
            contentHash: args.artwork.contentHash,
          },
        }
      : {}),
    roadie,
    status: deriveStatus(roadie),
  };
}

/**
 * Build a fully-processed asset already at `awaiting_review` (palette generated). Used by tests and
 * the legacy synchronous path; Roadie assembles the equivalent incrementally via its sub-steps.
 */
export function buildAlbumAsset(args: {
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
  const roadie: RoadieSection = {
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
  };

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
    roadie,
    status: deriveStatus(roadie),
  };
}
