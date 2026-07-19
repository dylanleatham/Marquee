// The human-driven onboarding actions (step 7): mark a prompt copied, redraft a prompt, attach /
// detach a video or card art, approve or reject a preview. Each validates the album's state and
// throws a typed error the server maps to a status code. Kept out of server.ts to keep routes thin.
import {
  mkdirSync,
  existsSync,
  rmSync,
  renameSync,
  readFileSync,
} from "node:fs";
import { writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type { AssetStore } from "../store/asset-store.js";
import {
  transitionTo,
  deriveStatus,
  TransitionError,
  type AlbumAsset,
  type RoadieState,
  type CardArtCandidate,
  type VideoClip,
} from "./asset.js";
import { ValidationError } from "./add-manual.js";
import {
  draftPrompts,
  type PromptType,
  type DraftOptions,
} from "../roadie/prompts.js";
import { draftOnePromptWithGemini } from "../gemini/draft.js";
import type { GeminiClient } from "../gemini/client.js";
import { ingestVideo, VideoError, type VideoProber } from "../media/video.js";
import {
  ingestCardArt,
  ingestCardArtCandidate,
  ImageError,
} from "../media/images.js";

export class NotFoundError extends Error {
  constructor(message = "not found") {
    super(message);
    this.name = "NotFoundError";
  }
}

export interface ActionDeps {
  store: AssetStore;
  prober: VideoProber;
  /** Gemini client for on-demand AI actions (prompt regenerate, card-art/video generate); absent → 400. */
  gemini?: GeminiClient;
  /** Opt-in artifact generation (default off). Prompt drafting/regeneration is never gated by these. */
  generateCardArt?: boolean;
  generateVideo?: boolean;
  now?: () => string;
}

const clock = (deps: ActionDeps) =>
  deps.now ?? (() => new Date().toISOString());

/** Load an album or throw NotFoundError. */
function load(store: AssetStore, curatorId: string): AlbumAsset {
  const asset = store.read(curatorId);
  if (!asset) throw new NotFoundError(`album ${curatorId} not found`);
  return asset;
}

// --- prompts -----------------------------------------------------------------------------------

const PROMPT_TYPES: PromptType[] = ["video", "cardArt"];

/** Regenerate one prompt from the current palette + a chosen template (curator-spec §Prompts). */
export function redraftPrompt(
  deps: ActionDeps,
  curatorId: string,
  type: PromptType,
  template: string | undefined,
): AlbumAsset {
  if (!PROMPT_TYPES.includes(type))
    throw new ValidationError(`unknown prompt type ${type}`);
  const asset = load(deps.store, curatorId);
  if (!asset.palette)
    throw new ValidationError(
      "palette isn't generated yet — nothing to draft from",
    );

  const colors = asset.palette.colors.map((c) => ({
    hex: c.hex,
    role: c.role,
  }));
  const opts: DraftOptions = { now: clock(deps) };
  if (type === "video") opts.videoTemplate = template;
  else opts.cardArtTemplate = template;

  const drafted = draftPrompts(asset.metadata, colors, opts);
  asset.promptDrafts = { ...asset.promptDrafts, [type]: drafted[type] };
  deps.store.save(asset);
  return asset;
}

/** Choose which variant of a drafted prompt is active (the one Copy hands off / generation uses). */
export function selectPromptVariant(
  deps: ActionDeps,
  curatorId: string,
  type: PromptType,
  index: number,
): AlbumAsset {
  if (!PROMPT_TYPES.includes(type))
    throw new ValidationError(`unknown prompt type ${type}`);
  const asset = load(deps.store, curatorId);
  const prompt = asset.promptDrafts?.[type];
  if (!prompt) throw new ValidationError(`no ${type} prompt drafted yet`);
  if (!Number.isInteger(index) || index < 0 || index >= prompt.variants.length)
    throw new ValidationError(
      `variant index ${index} out of range (0..${prompt.variants.length - 1})`,
    );
  prompt.selectedIndex = index;
  deps.store.save(asset);
  return asset;
}

/**
 * Regenerate one prompt as a fresh grounded LLM variant set (on-demand "Regenerate with AI").
 * Requires a configured Gemini client — unlike the pipeline step there's no silent template
 * fallback: on failure the existing draft is left untouched and the error surfaces to the user.
 */
export async function regeneratePromptWithAI(
  deps: ActionDeps,
  curatorId: string,
  type: PromptType,
): Promise<AlbumAsset> {
  if (!PROMPT_TYPES.includes(type))
    throw new ValidationError(`unknown prompt type ${type}`);
  if (!deps.gemini)
    throw new ValidationError(
      "Gemini is not configured — set an API key in Settings",
    );
  const asset = load(deps.store, curatorId);
  if (!asset.palette)
    throw new ValidationError(
      "palette isn't generated yet — nothing to draft from",
    );
  const colors = asset.palette.colors.map((c) => ({
    hex: c.hex,
    role: c.role,
  }));
  const drafted = await draftOnePromptWithGemini(
    deps.gemini,
    type,
    asset.metadata,
    colors,
    { now: clock(deps) },
  );
  asset.promptDrafts = { ...asset.promptDrafts, [type]: drafted };
  deps.store.save(asset);
  return asset;
}

/**
 * Mark a prompt copied. Copying the *video* prompt is the signal that review is done and the album
 * moves to `awaiting_video` (curator-spec §Prompts); the card-art prompt copy is just bookkeeping.
 */
export function markPromptCopied(
  deps: ActionDeps,
  curatorId: string,
  type: PromptType,
): AlbumAsset {
  if (!PROMPT_TYPES.includes(type))
    throw new ValidationError(`unknown prompt type ${type}`);
  const asset = load(deps.store, curatorId);
  const prompt = asset.promptDrafts?.[type];
  if (!prompt) throw new ValidationError(`no ${type} prompt drafted yet`);

  prompt.copiedAt = clock(deps)();
  if (type === "video" && asset.roadie.state === "awaiting_review")
    transitionTo(asset, "awaiting_video", clock(deps));
  else asset.status = deriveStatus(asset.roadie);
  deps.store.save(asset);
  return asset;
}

// --- video -------------------------------------------------------------------------------------

// A video can be attached from review onward (issue #11 / ADR 0005): having the file in hand is
// reason enough — copying the prompt was never a precondition, only the usual way you got a video.
const VIDEO_ATTACHABLE: RoadieState[] = [
  "awaiting_review",
  "awaiting_video",
  "awaiting_preview",
];

/** Set/replace the visualizer and advance to awaiting_preview (replacing at preview keeps state). */
function finishVideoAttach(
  deps: ActionDeps,
  asset: AlbumAsset,
  vis: AlbumAsset["visualizer"],
): void {
  asset.visualizer = vis;
  if (asset.roadie.state !== "awaiting_preview")
    transitionTo(asset, "awaiting_preview", clock(deps));
  else asset.status = deriveStatus(asset.roadie);
  deps.store.save(asset);
}

/**
 * Attach a freshly-uploaded video by its on-disk path. Ingests into visualizers/{curatorId}.mp4.
 * The upload is already streamed to `srcPath` by the route (issue #16), which also owns removing it —
 * so ingest copies rather than moves, and this never buffers the file.
 */
export async function attachVideoUpload(
  deps: ActionDeps,
  curatorId: string,
  srcPath: string,
  originalFilename: string,
): Promise<AlbumAsset> {
  const asset = load(deps.store, curatorId);
  if (!VIDEO_ATTACHABLE.includes(asset.roadie.state))
    throw new TransitionError(asset.roadie.state, "awaiting_preview");

  const vis = await ingestVideo(
    { prober: deps.prober, paths: deps.store.paths, now: deps.now },
    { srcPath, fileId: curatorId, originalFilename },
  );
  finishVideoAttach(deps, asset, vis);
  return asset;
}

/** Claim a file already sitting in /incoming/ and attach it (curator-spec §9 bulk-drop flow). */
export async function attachVideoIncoming(
  deps: ActionDeps,
  curatorId: string,
  incomingName: string,
): Promise<AlbumAsset> {
  const asset = load(deps.store, curatorId);
  if (!VIDEO_ATTACHABLE.includes(asset.roadie.state))
    throw new TransitionError(asset.roadie.state, "awaiting_preview");
  const src = safeIncomingPath(deps.store, incomingName);
  if (!existsSync(src))
    throw new NotFoundError(`no incoming file "${incomingName}"`);

  const vis = await ingestVideo(
    { prober: deps.prober, paths: deps.store.paths, now: deps.now },
    {
      srcPath: src,
      fileId: curatorId,
      originalFilename: incomingName,
      removeSrc: true,
    },
  );
  finishVideoAttach(deps, asset, vis);
  return asset;
}

/** Remove the visualizer reference (and, with `deleteFile`, the file). Steps back to awaiting_video. */
export function detachVideo(
  deps: ActionDeps,
  curatorId: string,
  deleteFile: boolean,
): AlbumAsset {
  const asset = load(deps.store, curatorId);
  if (!asset.visualizer) throw new ValidationError("no video attached");
  if (deleteFile)
    rmSync(deps.store.paths.visualizerFile(asset.visualizer.fileId), {
      force: true,
    });
  delete asset.visualizer;
  if (asset.roadie.state === "awaiting_preview")
    transitionTo(asset, "awaiting_video", clock(deps));
  else asset.status = deriveStatus(asset.roadie);
  deps.store.save(asset);
  return asset;
}

/**
 * Generate a set of visualizer clips from the drafted video prompt variants (Veo/"Omni",
 * image-to-video off the album cover). Stored as `videoClips` for the human to download and splice
 * externally (ADR 0011 — no in-app splicing yet); the single attached `visualizer` is still set by
 * the manual upload. Requires a Gemini client and the album's cover art. Clips generate in parallel;
 * a partial failure keeps the successes — only an all-fail throws (as a 5xx, an upstream fault).
 */
export async function generateVideoSet(
  deps: ActionDeps,
  curatorId: string,
): Promise<AlbumAsset> {
  if (!deps.gemini)
    throw new ValidationError(
      "Gemini is not configured — set an API key in Settings",
    );
  if (!deps.generateVideo)
    throw new ValidationError(
      "Video generation is off — enable it in Settings, or copy the prompt into your own tool (e.g. Google Flow)",
    );
  const asset = load(deps.store, curatorId);
  const draft = asset.promptDrafts?.video;
  if (!draft || draft.variants.length === 0)
    throw new ValidationError(
      "no video prompt drafted yet — nothing to generate from",
    );
  const coverPath = deps.store.paths.artworkFile(curatorId);
  if (!asset.artwork || !existsSync(coverPath))
    throw new ValidationError(
      "album has no cover art to animate — add art first",
    );
  const cover = readFileSync(coverPath);
  const gemini = deps.gemini;
  const now = clock(deps);

  // Generate + ingest each clip inside allSettled so one failure (generation or validation) is
  // isolated and the set keeps the rest (mirrors generateCardArtSet).
  mkdirSync(deps.store.paths.incoming, { recursive: true });
  const results = await Promise.allSettled(
    draft.variants.map(async (v, i): Promise<VideoClip> => {
      const bytes = await gemini.generateVideo(v.text, cover);
      const tmp = deps.store.paths.incomingFile(
        `.vidgen-${curatorId}-${i}-${randomUUID()}.mp4`,
      );
      await writeFile(tmp, bytes);
      // ingestVideo removes the temp on success (removeSrc), but throws *before* that on a
      // validation failure — clean it up ourselves so failed clips don't leak files in /incoming/.
      let vis;
      try {
        vis = await ingestVideo(
          { prober: deps.prober, paths: deps.store.paths, now: deps.now },
          {
            srcPath: tmp,
            fileId: `${curatorId}-v${i}`,
            originalFilename: `clip-${v.nudge ?? i}.mp4`,
            removeSrc: true,
          },
        );
      } catch (err) {
        rmSync(tmp, { force: true });
        throw err;
      }
      return {
        index: i,
        fileId: vis.fileId,
        nudge: v.nudge,
        generatedAt: now(),
        ...(vis.durationSec !== undefined
          ? { durationSec: vis.durationSec }
          : {}),
        ...(vis.resolution ? { resolution: vis.resolution } : {}),
      };
    }),
  );

  const clips: VideoClip[] = results.flatMap((r) =>
    r.status === "fulfilled" ? [r.value] : [],
  );
  if (clips.length === 0) {
    const reason = (
      results.find((r) => r.status === "rejected") as
        PromiseRejectedResult | undefined
    )?.reason;
    // Whole-batch failure is an upstream fault → 5xx. A per-clip VideoError would otherwise map to
    // 422 ("your upload is bad"), wrong here — nobody uploaded. Wrap it; GeminiError already → 500.
    if (reason instanceof VideoError)
      throw new Error(
        `video generation returned no usable clips: ${reason.message}`,
      );
    throw reason ?? new Error("video generation produced no clips");
  }

  asset.videoClips = clips;
  asset.status = deriveStatus(asset.roadie);
  deps.store.save(asset);
  return asset;
}

// --- card art ----------------------------------------------------------------------------------

export function attachCardArtUpload(
  deps: ActionDeps,
  curatorId: string,
  srcPath: string,
  originalFilename: string,
): AlbumAsset {
  const asset = load(deps.store, curatorId);
  // Card art is independent of the state machine — it can be added at any point, even after verified.
  // Card art is small (cover-sized), so reading the streamed temp file back into a buffer here is
  // fine — the memory concern in issue #16 is the multi-GB video path, not this one.
  asset.cardArt = ingestCardArt(
    { paths: deps.store.paths, now: deps.now },
    { buffer: readFileSync(srcPath), fileId: curatorId, originalFilename },
  );
  asset.status = deriveStatus(asset.roadie);
  deps.store.save(asset);
  return asset;
}

/** Claim an image already sitting in /incoming/ and attach it as card art. */
export function attachCardArtIncoming(
  deps: ActionDeps,
  curatorId: string,
  incomingName: string,
): AlbumAsset {
  const asset = load(deps.store, curatorId);
  const src = safeIncomingPath(deps.store, incomingName);
  if (!existsSync(src))
    throw new NotFoundError(`no incoming file "${incomingName}"`);
  asset.cardArt = ingestCardArt(
    { paths: deps.store.paths, now: deps.now },
    {
      buffer: readFileSync(src),
      fileId: curatorId,
      originalFilename: incomingName,
    },
  );
  rmSync(src, { force: true });
  asset.status = deriveStatus(asset.roadie);
  deps.store.save(asset);
  return asset;
}

export function detachCardArt(
  deps: ActionDeps,
  curatorId: string,
  deleteFile: boolean,
): AlbumAsset {
  const asset = load(deps.store, curatorId);
  if (!asset.cardArt) throw new ValidationError("no card art attached");
  if (deleteFile)
    rmSync(
      deps.store.paths.cardArtFile(asset.cardArt.fileId, asset.cardArt.ext),
      {
        force: true,
      },
    );
  delete asset.cardArt;
  deps.store.save(asset);
  return asset;
}

/**
 * Generate a set of card-art candidates from the drafted card-art prompt variants (Nano Banana,
 * one image per variant). Stored as `cardArtCandidates` for the human to pick from; the manual
 * upload and `selectCardArt` both still set the single attached `cardArt`. Requires a Gemini client.
 * Images generate in parallel; a partial failure keeps the successes — only an all-fail throws.
 */
export async function generateCardArtSet(
  deps: ActionDeps,
  curatorId: string,
): Promise<AlbumAsset> {
  if (!deps.gemini)
    throw new ValidationError(
      "Gemini is not configured — set an API key in Settings",
    );
  if (!deps.generateCardArt)
    throw new ValidationError(
      "Card-art generation is off — enable it in Settings, or copy the prompt into your own tool",
    );
  const asset = load(deps.store, curatorId);
  const draft = asset.promptDrafts?.cardArt;
  if (!draft || draft.variants.length === 0)
    throw new ValidationError(
      "no card-art prompt drafted yet — nothing to generate from",
    );

  const gemini = deps.gemini;
  // Generate *and* ingest inside allSettled: a candidate can fail either at the API (network/5xx)
  // or at ingest (Gemini returned 200 with non-image bytes). Both are per-candidate failures — the
  // set keeps the successes (ADR 0010). Doing the ingest in a bare forEach would let one malformed
  // image throw and discard the whole batch.
  const results = await Promise.allSettled(
    draft.variants.map(async (v, i) =>
      ingestCardArtCandidate(
        { paths: deps.store.paths, now: deps.now },
        {
          buffer: await gemini.generateImage(v.text),
          curatorId,
          index: i,
          nudge: v.nudge,
        },
      ),
    ),
  );

  const candidates: CardArtCandidate[] = results.flatMap((r) =>
    r.status === "fulfilled" ? [r.value] : [],
  );
  if (candidates.length === 0) {
    const reason = (
      results.find((r) => r.status === "rejected") as
        PromiseRejectedResult | undefined
    )?.reason;
    // A whole-batch generation failure is an upstream fault → 5xx (curator-spec §Card art / ADR
    // 0010), whichever way the candidates failed. A GeminiError already maps to 500 (it's not in
    // actionError's known set); but a per-image ImageError would otherwise map to 422 ("your upload
    // is bad"), which is wrong here — the human didn't upload anything. Wrap that case so it's a 5xx.
    if (reason instanceof ImageError)
      throw new Error(
        `card-art generation returned no usable images: ${reason.message}`,
      );
    throw reason ?? new Error("card-art generation produced no images");
  }

  asset.cardArtCandidates = candidates;
  asset.status = deriveStatus(asset.roadie);
  deps.store.save(asset);
  return asset;
}

/** Promote a generated candidate to the attached card art (reuses the normal ingest/serve path). */
export function selectCardArt(
  deps: ActionDeps,
  curatorId: string,
  index: number,
): AlbumAsset {
  const asset = load(deps.store, curatorId);
  const candidate = asset.cardArtCandidates?.find((c) => c.index === index);
  if (!candidate)
    throw new ValidationError(`no card-art candidate at index ${index}`);

  const buffer = readFileSync(
    deps.store.paths.cardArtFile(candidate.fileId, candidate.ext),
  );
  asset.cardArt = ingestCardArt(
    { paths: deps.store.paths, now: deps.now },
    {
      buffer,
      fileId: curatorId,
      originalFilename: `generated-${candidate.nudge ?? candidate.index}.${candidate.ext}`,
    },
  );
  asset.status = deriveStatus(asset.roadie);
  deps.store.save(asset);
  return asset;
}

// --- preview -----------------------------------------------------------------------------------

/** "Looks good" — approve the preview, advancing to awaiting_tag_write (curator-spec §10). */
export function approvePreview(
  deps: ActionDeps,
  curatorId: string,
): AlbumAsset {
  const asset = load(deps.store, curatorId);
  transitionTo(asset, "awaiting_tag_write", clock(deps)); // throws if not in awaiting_preview
  asset.verification = {
    ...asset.verification,
    previewApprovedAt: clock(deps)(),
  };
  deps.store.save(asset);
  return asset;
}

/** "Something's off" — step back from preview to review or video to iterate (curator-spec §10). */
export function rejectPreview(
  deps: ActionDeps,
  curatorId: string,
  to: "awaiting_review" | "awaiting_video",
): AlbumAsset {
  const asset = load(deps.store, curatorId);
  transitionTo(asset, to, clock(deps)); // throws if not a legal step back
  deps.store.save(asset);
  return asset;
}

// --- helpers -----------------------------------------------------------------------------------

/** Resolve a name to a path inside /incoming/, rejecting any traversal or nested path. */
export function safeIncomingPath(store: AssetStore, name: string): string {
  if (!name || name !== basenameOnly(name))
    throw new ValidationError(`invalid incoming filename "${name}"`);
  return store.paths.incomingFile(name);
}

// Reduce a filename to a safe on-disk name: strip any directory, then collapse everything outside
// [A-Za-z0-9._-] (spaces, shell metacharacters, unicode) so a stored name can never inject when it
// later reaches an argv (the prober runs without a shell too — defense in depth). No leading dots.
const basenameOnly = (name: string): string =>
  name
    .replace(/^.*[\\/]/, "")
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .replace(/\.{2,}/g, ".")
    .replace(/^\.+/, "")
    .slice(0, 200);

/**
 * Move a raw upload with no curatorId into /incoming/ for a later claim (curator-spec §9). The bytes
 * are already streamed to `srcPath` (a temp in /incoming/), so this is a same-directory rename rather
 * than a re-copy of a potentially multi-GB file (issue #16). Overwrites any prior file of that name,
 * matching the previous write-through behavior (renameSync onto an existing path throws on Windows).
 */
export function saveIncoming(
  store: AssetStore,
  originalFilename: string,
  srcPath: string,
): { name: string } {
  const name = basenameOnly(originalFilename) || `upload-${Date.now()}`;
  mkdirSync(store.paths.incoming, { recursive: true });
  const dest = store.paths.incomingFile(name);
  rmSync(dest, { force: true });
  renameSync(srcPath, dest);
  return { name };
}
