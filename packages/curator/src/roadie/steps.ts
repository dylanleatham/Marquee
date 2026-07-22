// The Roadie-driven sub-steps (roadie-spec §6). Each step mutates the in-memory asset and returns
// the next state; the worker owns persistence, history, and retry classification. Every step is
// idempotent (roadie-spec §15) so a crash-restart can safely re-run it from where it left off.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { generatePalette } from "@marquee/palette-press";
import type { AssetStore } from "../store/asset-store.js";
import type { SpotifyClient } from "../spotify/client.js";
import { SpotifyError } from "../spotify/client.js";
import type { DiscogsClient } from "../discogs/client.js";
import { DiscogsError } from "../discogs/client.js";
import type { PaletteGenerator } from "../albums/add-manual.js";
import type {
  AlbumAsset,
  AlbumMetadata,
  RoadieState,
} from "../albums/asset.js";
import { parseAlbumId } from "../albums/add-spotify.js";
import { bestSpotifyMatch } from "../albums/spotify-match.js";
import { draftPrompts } from "./prompts.js";
import { draftPromptsWithGemini } from "../gemini/draft.js";
import type { GeminiClient } from "../gemini/client.js";
import { TransientError, PermanentError, ConfigError } from "./errors.js";

/**
 * Minimal logger the steps use for observability (a fallback isn't a failure, but it's worth a
 * line). Deliberately a narrow subset of the worker's `RoadieLogger` — not imported from worker.ts
 * because worker.ts imports the steps, and a step only needs info/warn. `RoadieLogger` satisfies it
 * structurally, so the worker passes its own logger straight through.
 */
export interface StepLogger {
  info(msg: string): void;
  warn(msg: string): void;
}

export interface StepDeps {
  store: AssetStore;
  spotify?: SpotifyClient;
  discogs?: DiscogsClient;
  /** Gemini client for LLM-authored prompts; absent → the drafter uses the deterministic templates. */
  gemini?: GeminiClient;
  generate: PaletteGenerator;
  now: () => string;
  logger?: StepLogger;
}

/** A step: advance the album one sub-step, mutating it in place; return the next state. */
export type Step = (asset: AlbumAsset, deps: StepDeps) => Promise<RoadieState>;

/** Translate a Spotify HTTP error into a Roadie failure class. */
function classifySpotify(err: SpotifyError, notFoundReason: string): never {
  if (err.status === 404) throw new PermanentError(err.message, notFoundReason);
  if (err.status === 401 || err.status === 403)
    throw new ConfigError(`Spotify auth problem: ${err.message}`, err);
  // 429 rate limit, 5xx, 504 timeout, or unknown → retry.
  throw new TransientError(err.message, err);
}

/** Translate a Discogs HTTP error into a Roadie failure class (parallel to `classifySpotify`). */
function classifyDiscogs(err: DiscogsError, notFoundReason: string): never {
  if (err.status === 404) throw new PermanentError(err.message, notFoundReason);
  if (err.status === 401 || err.status === 403)
    throw new ConfigError(`Discogs auth problem: ${err.message}`, err);
  // 429 rate limit, 5xx, 504 timeout, or unknown → retry.
  throw new TransientError(err.message, err);
}

/** Spotify metadata fetch: fills name/artist/year/genres/art URL from the album + artist endpoints. */
const fetchSpotifyMetadata: Step = async (asset, deps) => {
  if (!deps.spotify)
    throw new ConfigError(
      "Spotify not configured but album needs a metadata fetch",
    );
  const spotifyId = parseAlbumId({ spotifyUri: asset.metadata.spotifyUri });
  if (!spotifyId)
    throw new PermanentError(
      `Album has no valid Spotify URI (${asset.metadata.spotifyUri})`,
      "invalid_spotify_uri",
    );

  let meta;
  try {
    meta = await deps.spotify.getAlbum(spotifyId);
  } catch (err) {
    if (err instanceof SpotifyError)
      classifySpotify(err, "album_not_on_spotify");
    throw err;
  }

  const next: AlbumMetadata = {
    name: meta.name,
    artist: meta.artist,
    source: "spotify",
    spotifyUri: meta.spotifyUri,
    ...(meta.artUrl ? { spotifyArtUrl: meta.artUrl } : {}),
    ...(meta.year !== undefined ? { year: meta.year } : {}),
    ...(meta.genres.length ? { genres: meta.genres } : {}),
  };
  asset.metadata = next;
  return "downloading_art";
};

/** Discogs metadata fetch: refreshes name/artist/year/genres + the primary cover-image URL. */
const fetchDiscogsMetadata: Step = async (asset, deps) => {
  if (!deps.discogs)
    throw new ConfigError(
      "Discogs not configured but album needs a metadata fetch",
    );
  const releaseId = asset.metadata.discogsReleaseId;
  if (!releaseId)
    throw new PermanentError(
      `Album has no Discogs release id (${asset.metadata.discogsUri})`,
      "invalid_discogs_release",
    );

  let meta;
  try {
    meta = await deps.discogs.getRelease(releaseId);
  } catch (err) {
    if (err instanceof DiscogsError)
      classifyDiscogs(err, "release_not_on_discogs");
    throw err;
  }

  const next: AlbumMetadata = {
    name: meta.title,
    artist: meta.artist,
    source: "discogs",
    discogsReleaseId: meta.releaseId,
    discogsUri: meta.discogsUri,
    ...(meta.artUrl ? { discogsArtUrl: meta.artUrl } : {}),
    ...(meta.year !== undefined ? { year: meta.year } : {}),
    ...(meta.genres.length ? { genres: meta.genres } : {}),
  };

  // Try to resolve richer cover art from Spotify (issue #58 / ADR 0017). Best-effort: a miss, an
  // unconfigured Spotify, or an API error just leaves the Discogs image in place — this never blocks
  // the Discogs add. On a confident match we stash the Spotify art URL; the art step prefers it.
  const spotifyArtUrl = await resolveSpotifyArtUrl(deps, {
    artist: meta.artist,
    title: meta.title,
    year: meta.year,
  });
  if (spotifyArtUrl) next.spotifyArtUrl = spotifyArtUrl;

  asset.metadata = next;
  return "downloading_art";
};

/**
 * Fuzzy-match a Discogs release to a Spotify album and return its cover-art URL, or `undefined`.
 * Best-effort: no Spotify client, no confident match, or an API error → `undefined` (keep the
 * Discogs image). Never throws — art resolution must not fail a Discogs add (issue #58).
 */
async function resolveSpotifyArtUrl(
  deps: StepDeps,
  q: { artist: string; title: string; year?: number },
): Promise<string | undefined> {
  if (!deps.spotify || !q.artist || !q.title) return undefined;
  try {
    const candidates = await deps.spotify.searchAlbums(
      `${q.artist} ${q.title}`.trim(),
      10,
    );
    return bestSpotifyMatch(q, candidates)?.artUrl;
  } catch (err) {
    deps.logger?.warn(
      `Discogs→Spotify art match skipped (using the Discogs image): ${
        (err as Error).message
      }`,
    );
    return undefined;
  }
}

/**
 * fetching_metadata → downloading_art. Dispatches on the source: Spotify albums fetch from the
 * Spotify Web API, Discogs albums from the Discogs API. (Manual albums never enter this step.)
 */
const fetchMetadata: Step = async (asset, deps) =>
  asset.metadata.source === "discogs"
    ? fetchDiscogsMetadata(asset, deps)
    : fetchSpotifyMetadata(asset, deps);

/** Persist downloaded cover art to disk + stamp the artwork section. Shared by both art paths. */
function saveArt(
  asset: AlbumAsset,
  deps: StepDeps,
  art: Buffer,
  source: "spotify" | "discogs",
): void {
  const abs = deps.store.paths.artworkFile(asset.curatorId);
  mkdirSync(deps.store.paths.artwork, { recursive: true });
  writeFileSync(abs, art);
  asset.artwork = {
    resolvedPath: deps.store.paths.relPosix(abs),
    overrideActive: false,
    contentHash: "sha256:" + createHash("sha256").update(art).digest("hex"),
    source,
  };
}

/** Spotify art download. */
const downloadSpotifyArt: Step = async (asset, deps) => {
  if (!deps.spotify)
    throw new ConfigError("Spotify not configured but album needs its art");
  const url = asset.metadata.spotifyArtUrl;
  if (!url)
    throw new PermanentError(
      "Album has no cover art on Spotify — provide art manually",
      "art_unavailable",
    );

  let art: Buffer;
  try {
    art = await deps.spotify.downloadArt(url);
  } catch (err) {
    if (err instanceof SpotifyError) classifySpotify(err, "art_unavailable");
    throw err;
  }
  saveArt(asset, deps, art, "spotify");
  return "generating_palette";
};

/**
 * Discogs art download (issue #58 / ADR 0017). Prefers a **Spotify-resolved** cover when the metadata
 * step found a confident match (`spotifyArtUrl` set) — richer + consistent, reusing the Spotify art
 * pipeline — and falls back to the Discogs release image otherwise (or if the Spotify download fails).
 * The Discogs image is always the safety net, so a Spotify hiccup never blocks a Discogs add.
 */
const downloadDiscogsArt: Step = async (asset, deps) => {
  const spotifyArtUrl = asset.metadata.spotifyArtUrl;
  if (spotifyArtUrl && deps.spotify) {
    try {
      const art = await deps.spotify.downloadArt(spotifyArtUrl);
      saveArt(asset, deps, art, "spotify");
      return "generating_palette";
    } catch (err) {
      deps.logger?.warn(
        `Spotify art download failed for ${asset.curatorId}; falling back to the Discogs image: ${
          (err as Error).message
        }`,
      );
      // fall through to the Discogs image
    }
  }

  if (!deps.discogs)
    throw new ConfigError("Discogs not configured but album needs its art");
  const url = asset.metadata.discogsArtUrl;
  if (!url)
    throw new PermanentError(
      "Discogs release has no cover image — provide art manually",
      "art_unavailable",
    );

  let art: Buffer;
  try {
    art = await deps.discogs.downloadArt(url);
  } catch (err) {
    if (err instanceof DiscogsError) classifyDiscogs(err, "art_unavailable");
    throw err;
  }
  saveArt(asset, deps, art, "discogs");
  return "generating_palette";
};

/**
 * downloading_art → generating_palette. Dispatches on source; manual albums arrive with art already
 * saved and never enter this step.
 */
const downloadArt: Step = async (asset, deps) =>
  asset.metadata.source === "discogs"
    ? downloadDiscogsArt(asset, deps)
    : downloadSpotifyArt(asset, deps);

/**
 * generating_palette → drafting_prompts (or awaiting_review if the art is monochrome). Reads the
 * saved cover, runs Palette Press. Insufficient palettes are not a failure — a real album can be
 * monochrome; we save what we found, flag it, and let the human decide (roadie-spec §6/§8).
 */
const generatePaletteStep: Step = async (asset, deps) => {
  const abs = deps.store.paths.artworkFile(asset.curatorId);
  let bytes: Buffer;
  try {
    bytes = readFileSync(abs);
  } catch (err) {
    throw new ConfigError(`Cover art missing on disk at ${abs}`, err);
  }

  const payload = await deps.generate(bytes, {
    curatorId: asset.curatorId,
    name: asset.metadata.name,
    artist: asset.metadata.artist,
    year: asset.metadata.year,
  });

  const insufficient = Boolean(payload.palette.insufficient);
  asset.palette = {
    colors: payload.palette.colors,
    generatedAt: payload.meta?.generatedAt ?? deps.now(),
    algorithm: payload.meta?.generator ?? "palette-press",
    handEdited: false,
    ...(insufficient
      ? { insufficient: true, reason: payload.palette.reason }
      : {}),
  };
  asset.pattern = {
    type: payload.pattern.type,
    params: payload.pattern.params,
    handEdited: false,
  };

  if (insufficient) {
    asset.roadie.flags.palette_insufficient = true;
    return "awaiting_review";
  }
  return "drafting_prompts";
};

/**
 * drafting_prompts → awaiting_review. Drafts the video + card-art prompts. Prefers grounded,
 * LLM-authored variant sets (Gemini); falls back to the deterministic templates when no Gemini key
 * is configured or the LLM call fails. The fallback is why this step still "cannot fail" (roadie-spec
 * §6): the album always reaches review with prompts, LLM-authored or templated.
 */
const draftPromptsStep: Step = async (asset, deps) => {
  const colors = (asset.palette?.colors ?? []).map((c) => ({
    hex: c.hex,
    role: c.role,
  }));

  if (deps.gemini) {
    try {
      asset.promptDrafts = await draftPromptsWithGemini(
        deps.gemini,
        asset.metadata,
        colors,
        { now: deps.now },
      );
      return "awaiting_review";
    } catch (err) {
      deps.logger?.warn(
        `Roadie ${asset.curatorId}: Gemini prompt drafting failed, using templates (${(err as Error).message})`,
      );
    }
  }

  asset.promptDrafts = draftPrompts(asset.metadata, colors, { now: deps.now });
  return "awaiting_review";
};

/** The step for each Roadie-driven state. `fresh` routes to the source's first real step. */
export const STEPS: Record<string, Step> = {
  fresh: async (asset) =>
    asset.metadata.source === "manual"
      ? "generating_palette"
      : "fetching_metadata",
  fetching_metadata: fetchMetadata,
  downloading_art: downloadArt,
  generating_palette: generatePaletteStep,
  drafting_prompts: draftPromptsStep,
};

/** Real Palette Press generator; the worker default when the caller doesn't inject a fake. */
export const defaultGenerate: PaletteGenerator = generatePalette;
