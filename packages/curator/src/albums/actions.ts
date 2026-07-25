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
  isProcessingState,
  TransitionError,
  type AlbumAsset,
  type RoadieState,
  type CardArtCandidate,
  type VideoClip,
} from "./asset.js";
import { ValidationError, type PaletteGenerator } from "./add-manual.js";
import { sanitizePaletteEdit, type PaletteEditColor } from "./palette.js";
import {
  draftPrompts,
  type PromptType,
  type DraftOptions,
  type DraftedPrompt,
  type PromptVariant,
} from "../roadie/prompts.js";
import { draftOnePromptWithGemini } from "../gemini/draft.js";
import type { GeminiClient } from "../gemini/client.js";
import { ingestVideo, VideoError, type VideoProber } from "../media/video.js";
import {
  ingestCardArt,
  ingestCardArtCandidate,
  ImageError,
} from "../media/images.js";
import type { JobKind } from "../jobs/manager.js";

export class NotFoundError extends Error {
  constructor(message = "not found") {
    super(message);
    this.name = "NotFoundError";
  }
}

/**
 * The album's current state conflicts with a palette action: it's still being processed by Roadie, or
 * a re-extract would clobber a hand-edited palette without `force`. Maps to 409 Conflict (curator-spec
 * §Palettes — never overwrite a hand-edit without explicit user action).
 */
export class PaletteConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PaletteConflictError";
  }
}

export interface ActionDeps {
  store: AssetStore;
  prober: VideoProber;
  /** Gemini client for on-demand AI actions (prompt regenerate, card-art/video generate); absent → 400. */
  gemini?: GeminiClient;
  /** Palette generator (real Palette Press in prod; a fake in tests) for re-extraction; absent → 400. */
  generate?: PaletteGenerator;
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

/**
 * Draft one prompt type on demand — the lazy replacement for Roadie's old `drafting_prompts`
 * pipeline step (ADR 0027). Prefers the grounded LLM path and silently falls back to the
 * deterministic templates, so like the pipeline step it *cannot fail*: the caller always gets
 * prompts, LLM-authored or templated.
 *
 * Distinct from its two neighbours on purpose:
 *  - `redraftPrompt` is templates-only with an explicit template choice ("try a different style").
 *  - `regeneratePromptWithAI` requires Gemini and never falls back ("I specifically want AI").
 *  - this one is "I have no prompts yet, get me the best available" — the first-visit action.
 *
 * Idempotent by intent, not by guard: drafting again simply replaces that type's draft.
 */
export async function draftPrompt(
  deps: ActionDeps,
  curatorId: string,
  type: PromptType,
): Promise<AlbumAsset> {
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

  let drafted: DraftedPrompt | undefined;
  if (deps.gemini) {
    try {
      drafted = await draftOnePromptWithGemini(
        deps.gemini,
        type,
        asset.metadata,
        colors,
        { now: clock(deps) },
      );
    } catch {
      // Fall through to templates — the whole point of the fallback is that drafting can't fail.
      drafted = undefined;
    }
  }
  drafted ??= draftPrompts(asset.metadata, colors, { now: clock(deps) })[type];

  // Re-read + save synchronously so a slow LLM draft can't clobber a concurrent write (#38).
  const saved = deps.store.update(curatorId, (a) => {
    a.promptDrafts = { ...a.promptDrafts, [type]: drafted };
  });
  if (!saved)
    throw new NotFoundError(`album ${curatorId} was deleted mid-draft`);
  return saved;
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
  // Re-read + save synchronously so the slow LLM draft can't clobber a concurrent write (#38).
  const saved = deps.store.update(curatorId, (a) => {
    a.promptDrafts = { ...a.promptDrafts, [type]: drafted };
  });
  if (!saved)
    throw new NotFoundError(`album ${curatorId} was deleted mid-draft`);
  return saved;
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

// --- palette (curator-spec §Palettes) ----------------------------------------------------------

/** A palette can't be edited or re-extracted while Roadie is still processing that album (spec §Edge
 * cases — Roadie holds a per-album lock). Single-threaded Roadie makes this a simple state check. */
function assertNotProcessing(asset: AlbumAsset): void {
  if (isProcessingState(asset.roadie.state))
    throw new PaletteConflictError(
      `album is still processing (${asset.roadie.state}) — wait for it to reach review`,
    );
}

/**
 * Set a hand-edited palette (curator-spec §Palettes). Replaces the colors with the validated set,
 * marks `handEdited` so a later generate/batch won't clobber it, and bumps `generatedAt` so prompts
 * drafted from the previous palette read as stale in the UI. Order is authoritative — the first swatch
 * is the dominant/primary. Clears any monochrome-insufficient flag: a hand-crafted palette is whatever
 * the human made it. Synchronous, so a plain load→save is race-safe (no await to interleave).
 */
export function editPalette(
  deps: ActionDeps,
  curatorId: string,
  colors: PaletteEditColor[],
): AlbumAsset {
  const asset = load(deps.store, curatorId);
  assertNotProcessing(asset);
  if (!asset.palette)
    throw new ValidationError("palette isn't generated yet — nothing to edit");
  const clean = sanitizePaletteEdit(colors);
  asset.palette = {
    colors: clean,
    generatedAt: clock(deps)(),
    algorithm: asset.palette.algorithm,
    handEdited: true,
  };
  asset.roadie.flags.palette_insufficient = false;
  asset.status = deriveStatus(asset.roadie);
  deps.store.save(asset);
  return asset;
}

/**
 * Drop the hand-edit flag (curator-spec §Palettes `/palette/reset`) without changing the colors, so a
 * subsequent generate — or the batch regenerate — is free to replace the palette. To restore the
 * algorithmic palette in one step instead, use `regeneratePalette(force)`.
 */
export function resetPalette(deps: ActionDeps, curatorId: string): AlbumAsset {
  const asset = load(deps.store, curatorId);
  assertNotProcessing(asset);
  if (!asset.palette)
    throw new ValidationError("palette isn't generated yet — nothing to reset");
  asset.palette.handEdited = false;
  deps.store.save(asset);
  return asset;
}

/**
 * Re-run Palette Press from the album's cover art (curator-spec §Palettes `/palette/generate`),
 * replacing the palette + pattern with a fresh extraction. Refuses to overwrite a hand-edited palette
 * unless `force` is set (409). Mirrors Roadie's `generating_palette` step, but leaves Roadie state
 * untouched — the album stays in review. Async, so it re-reads under `store.update` after the slow
 * decode so a concurrent write isn't clobbered (issue #38).
 */
export async function regeneratePalette(
  deps: ActionDeps,
  curatorId: string,
  force = false,
): Promise<AlbumAsset> {
  if (!deps.generate)
    throw new ValidationError("palette generator isn't available");
  const asset = load(deps.store, curatorId);
  assertNotProcessing(asset);
  if (asset.palette?.handEdited && !force)
    throw new PaletteConflictError(
      "palette was hand-edited — re-extracting will discard your edits (pass force to proceed)",
    );
  const coverPath = deps.store.paths.artworkFile(curatorId);
  if (!asset.artwork || !existsSync(coverPath))
    throw new ValidationError(
      "album has no cover art to extract a palette from",
    );

  const bytes = readFileSync(coverPath);
  const payload = await deps.generate(bytes, {
    curatorId,
    name: asset.metadata.name,
    artist: asset.metadata.artist,
    year: asset.metadata.year,
  });
  const insufficient = Boolean(payload.palette.insufficient);
  const now = clock(deps);

  const saved = deps.store.update(curatorId, (a) => {
    // Re-validate on the fresh copy: the album may have moved while `generate` ran (issue #38). The
    // pre-await checks aren't enough on their own — the per-album lock has to hold at write time too.
    assertNotProcessing(a);
    if (a.palette?.handEdited && !force)
      throw new PaletteConflictError(
        "palette was hand-edited during re-extraction — discarding the edits needs force",
      );
    a.palette = {
      colors: payload.palette.colors,
      generatedAt: payload.meta?.generatedAt ?? now(),
      algorithm: payload.meta?.generator ?? "palette-press",
      handEdited: false,
      ...(insufficient
        ? { insufficient: true, reason: payload.palette.reason }
        : {}),
    };
    a.pattern = {
      type: payload.pattern.type,
      params: payload.pattern.params,
      handEdited: false,
    };
    a.roadie.flags.palette_insufficient = insufficient;
    a.status = deriveStatus(a.roadie);
  });
  if (!saved)
    throw new NotFoundError(`album ${curatorId} was deleted mid-regeneration`);
  return saved;
}

// --- video -------------------------------------------------------------------------------------

// A video can be attached from review onward (issue #11 / ADR 0005): having the file in hand is
// reason enough — copying the prompt was never a precondition, only the usual way you got a video.
const VIDEO_ATTACHABLE: RoadieState[] = [
  "awaiting_review",
  "awaiting_video",
  "awaiting_preview",
];

/**
 * Set/replace the visualizer and advance to awaiting_preview (replacing at preview keeps state).
 * Re-reads + saves synchronously (#38) so the slow `ingestVideo` above can't clobber a concurrent
 * write; re-validates the transition on the fresh copy since state may have changed meanwhile.
 */
function finishVideoAttach(
  deps: ActionDeps,
  curatorId: string,
  vis: AlbumAsset["visualizer"],
): AlbumAsset {
  const saved = deps.store.update(curatorId, (a) => {
    if (!VIDEO_ATTACHABLE.includes(a.roadie.state))
      throw new TransitionError(a.roadie.state, "awaiting_preview");
    a.visualizer = vis;
    if (a.roadie.state !== "awaiting_preview")
      transitionTo(a, "awaiting_preview", clock(deps));
    else a.status = deriveStatus(a.roadie);
  });
  if (!saved)
    throw new NotFoundError(`album ${curatorId} was deleted mid-attach`);
  return saved;
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
  return finishVideoAttach(deps, curatorId, vis);
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
  return finishVideoAttach(deps, curatorId, vis);
}

/**
 * Splice the generated clips into one looping MP4 and attach it as the visualizer (issue #29 / ADR
 * 0011), keeping the whole flow in Curator instead of an external editor. `order` is the ordered list
 * of clip indices to join — defaults to all clips in index order; pass a subset/reordering to
 * deselect or resequence. Concatenates to a temp file (re-encoded H.264), then runs it through the
 * same `ingestVideo` path as a manual upload, so validation/thumbnail/state-transition are identical.
 * The manual single-video upload remains the override.
 */
export async function spliceVisualizer(
  deps: ActionDeps,
  curatorId: string,
  order?: number[],
  opts: { crossfade?: { durationSec: number } } = {},
): Promise<AlbumAsset> {
  const asset = load(deps.store, curatorId);
  if (!VIDEO_ATTACHABLE.includes(asset.roadie.state))
    throw new TransitionError(asset.roadie.state, "awaiting_preview");

  const clips = asset.videoClips ?? [];
  if (clips.length === 0)
    throw new ValidationError(
      "no generated clips to splice — generate clips first",
    );

  // Resolve the ordered selection → on-disk clip files. Default: every clip in index order.
  const byIndex = new Map(clips.map((c) => [c.index, c]));
  const chosen = order && order.length ? order : clips.map((c) => c.index);
  const seen = new Set<number>();
  const files: string[] = [];
  for (const i of chosen) {
    const clip = byIndex.get(i);
    if (!clip) throw new ValidationError(`clip ${i} does not exist`);
    if (seen.has(i)) throw new ValidationError(`clip ${i} listed twice`);
    seen.add(i);
    const path = deps.store.paths.visualizerFile(clip.fileId);
    if (!existsSync(path))
      throw new ValidationError(`clip ${i} is missing on disk`);
    files.push(path);
  }

  // Concat → temp, then ingest as the single visualizer. Clean up the temp on any failure so a bad
  // splice never leaks files in /incoming/ (ingestVideo removes it on success via removeSrc).
  mkdirSync(deps.store.paths.incoming, { recursive: true });
  const tmp = deps.store.paths.incomingFile(
    `.splice-${curatorId}-${randomUUID()}.mp4`,
  );
  let vis;
  try {
    await deps.prober.concat(files, tmp, opts);
    vis = await ingestVideo(
      { prober: deps.prober, paths: deps.store.paths, now: deps.now },
      {
        srcPath: tmp,
        fileId: curatorId,
        originalFilename: "spliced-loop.mp4",
        removeSrc: true,
      },
    );
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
  return finishVideoAttach(deps, curatorId, vis);
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

/** Optional per-set generation options — a progress callback the background job model hooks into. */
export interface GenerateOptions {
  /** Called as each variant settles (fulfilled or rejected): `(done, total)`. */
  onProgress?: (done: number, total: number) => void;
  /** Aborts in-flight generation when the job is cancelled (issue #57); threaded into the Gemini
   * fetch so an upstream call stops rather than running to completion. */
  signal?: AbortSignal;
}

/**
 * Run per-variant work with progress reporting. `onProgress(0, total)` fires up front (so the UI
 * shows "0/N" immediately), then once per settled item — regardless of success or failure, since a
 * failed clip is still "one down." Returns settled results so callers keep the partial-success
 * semantics (ADR 0010/0011).
 */
async function settleWithProgress<T>(
  promises: Promise<T>[],
  onProgress?: (done: number, total: number) => void,
): Promise<PromiseSettledResult<T>[]> {
  const total = promises.length;
  let done = 0;
  onProgress?.(0, total);
  return Promise.allSettled(
    promises.map((p) =>
      p.finally(() => {
        done += 1;
        onProgress?.(done, total);
      }),
    ),
  );
}

/**
 * The cheap, synchronous preconditions for generating a set — Gemini configured, generation enabled,
 * the album + its drafted prompt (and, for video, cover art) present. Throws the same typed errors
 * the generate functions do. Exported so a route can reject a misconfigured request with an immediate
 * 4xx *before* enqueuing a background job, instead of letting it surface as a job failure (issue #30).
 * The generate functions call it too, so they stay safe as standalone entry points.
 */
export function assertGenerable(
  deps: ActionDeps,
  curatorId: string,
  kind: JobKind,
  index?: number,
): void {
  const { draft } =
    kind === "video"
      ? ensureVideoGenerable(deps, curatorId)
      : ensureCardArtGenerable(deps, curatorId);
  // For a per-prompt generation, the requested variant index must exist — reject up front so a bad
  // index is a 4xx precheck, not a job/action failure later.
  if (index !== undefined) assertVariantIndex(draft, index);
}

/** Validate a per-prompt variant index against a drafted prompt, or throw a 400 ValidationError. */
function assertVariantIndex(draft: DraftedPrompt, index: number): void {
  if (!Number.isInteger(index) || index < 0 || index >= draft.variants.length)
    throw new ValidationError(
      `variant index ${index} out of range (0..${draft.variants.length - 1})`,
    );
}

/**
 * Video preconditions → the (narrowed) Gemini client, loaded draft, and cover path. Shared by the
 * route precheck and the action; returning the narrowed `gemini` lets the action skip a redundant
 * non-null assertion.
 */
function ensureVideoGenerable(
  deps: ActionDeps,
  curatorId: string,
): { gemini: GeminiClient; draft: DraftedPrompt; coverPath: string } {
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
  return { gemini: deps.gemini, draft, coverPath };
}

/**
 * Generate a set of visualizer clips from the drafted video prompt variants (Veo/"Omni",
 * image-to-video off the album cover). Stored as `videoClips` for the human to download and splice
 * externally (ADR 0011 — no in-app splicing yet); the single attached `visualizer` is still set by
 * the manual upload. Requires a Gemini client and the album's cover art. Clips generate in parallel;
 * a partial failure keeps the successes — only an all-fail throws (as a 5xx, an upstream fault).
 * Long-running — the server runs it as a background job (issue #30 / ADR 0018), passing `onProgress`.
 */
/**
 * Generate one visualizer clip from a single prompt variant: Omni image-to-video off the cover, then
 * ingest to `visualizers/{curatorId}-v{index}.mp4`. Cleans up its temp file on a validation failure so
 * failed clips don't leak into /incoming/. Shared by the whole-set and per-prompt generation paths.
 */
async function generateVideoClip(
  deps: ActionDeps,
  gemini: GeminiClient,
  curatorId: string,
  cover: Buffer,
  variant: PromptVariant,
  index: number,
  now: () => string,
  signal?: AbortSignal,
): Promise<VideoClip> {
  const bytes = await gemini.generateVideo(
    variant.text,
    cover,
    undefined,
    signal,
  );
  const tmp = deps.store.paths.incomingFile(
    `.vidgen-${curatorId}-${index}-${randomUUID()}.mp4`,
  );
  await writeFile(tmp, bytes);
  // ingestVideo removes the temp on success (removeSrc), but throws *before* that on a validation
  // failure — clean it up ourselves so failed clips don't leak files in /incoming/.
  let vis;
  try {
    vis = await ingestVideo(
      { prober: deps.prober, paths: deps.store.paths, now: deps.now },
      {
        srcPath: tmp,
        fileId: `${curatorId}-v${index}`,
        originalFilename: `clip-${variant.nudge ?? index}.mp4`,
        removeSrc: true,
      },
    );
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
  return {
    index,
    fileId: vis.fileId,
    nudge: variant.nudge,
    generatedAt: now(),
    ...(vis.durationSec !== undefined ? { durationSec: vis.durationSec } : {}),
    ...(vis.resolution ? { resolution: vis.resolution } : {}),
  };
}

export async function generateVideoSet(
  deps: ActionDeps,
  curatorId: string,
  opts: GenerateOptions = {},
): Promise<AlbumAsset> {
  const { gemini, draft, coverPath } = ensureVideoGenerable(deps, curatorId);
  const cover = readFileSync(coverPath);
  const now = clock(deps);

  // Generate + ingest each clip inside allSettled so one failure (generation or validation) is
  // isolated and the set keeps the rest (mirrors generateCardArtSet).
  mkdirSync(deps.store.paths.incoming, { recursive: true });
  const results = await settleWithProgress(
    draft.variants.map((v, i) =>
      generateVideoClip(deps, gemini, curatorId, cover, v, i, now, opts.signal),
    ),
    opts.onProgress,
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

  // Re-read + save synchronously so the slow generation above can't clobber a concurrent write (#38).
  const saved = deps.store.update(curatorId, (a) => {
    a.videoClips = clips;
    a.status = deriveStatus(a.roadie);
  });
  if (!saved)
    throw new NotFoundError(`album ${curatorId} was deleted mid-generation`);
  return saved;
}

/**
 * Generate a single visualizer clip from one drafted video prompt variant (ADR 0022), for the
 * per-prompt "Generate clip" buttons. The new clip replaces any existing one at that index and is
 * merged into `videoClips` under a re-read (#38) so it never clobbers a sibling clip a concurrent
 * per-prompt/set run just wrote. A clip is a multi-minute Omni call, so — unlike per-prompt card art
 * — the server runs this as a background job (issue #30 / ADR 0018), passing `onProgress`/`signal`.
 * Requires a Gemini client + generation enabled (opt-in) + cover art; an out-of-range index is a 400.
 */
export async function generateVideoOne(
  deps: ActionDeps,
  curatorId: string,
  index: number,
  opts: GenerateOptions = {},
): Promise<AlbumAsset> {
  const { gemini, draft, coverPath } = ensureVideoGenerable(deps, curatorId);
  assertVariantIndex(draft, index);
  const cover = readFileSync(coverPath);
  const now = clock(deps);

  opts.onProgress?.(0, 1);
  mkdirSync(deps.store.paths.incoming, { recursive: true });
  const clip = await generateVideoClip(
    deps,
    gemini,
    curatorId,
    cover,
    draft.variants[index]!,
    index,
    now,
    opts.signal,
  );
  opts.onProgress?.(1, 1);

  const saved = deps.store.update(curatorId, (a) => {
    const others = (a.videoClips ?? []).filter((c) => c.index !== index);
    a.videoClips = [...others, clip].sort((x, y) => x.index - y.index);
    a.status = deriveStatus(a.roadie);
  });
  if (!saved)
    throw new NotFoundError(`album ${curatorId} was deleted mid-generation`);
  return saved;
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

/** Card-art preconditions → the (narrowed) Gemini client + loaded draft (route precheck + action). */
function ensureCardArtGenerable(
  deps: ActionDeps,
  curatorId: string,
): { gemini: GeminiClient; draft: DraftedPrompt } {
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
  return { gemini: deps.gemini, draft };
}

/**
 * Generate a set of card-art candidates from the drafted card-art prompt variants (Nano Banana,
 * one image per variant). Stored as `cardArtCandidates` for the human to pick from; the manual
 * upload and `selectCardArt` both still set the single attached `cardArt`. Requires a Gemini client.
 * Images generate in parallel; a partial failure keeps the successes — only an all-fail throws.
 * Run as a background job by the server (issue #30 / ADR 0018), which passes `onProgress`.
 */
export async function generateCardArtSet(
  deps: ActionDeps,
  curatorId: string,
  opts: GenerateOptions = {},
): Promise<AlbumAsset> {
  const { gemini, draft } = ensureCardArtGenerable(deps, curatorId);
  // Generate *and* ingest inside allSettled: a candidate can fail either at the API (network/5xx)
  // or at ingest (Gemini returned 200 with non-image bytes). Both are per-candidate failures — the
  // set keeps the successes (ADR 0010). Doing the ingest in a bare forEach would let one malformed
  // image throw and discard the whole batch.
  const results = await settleWithProgress(
    draft.variants.map(async (v, i) =>
      ingestCardArtCandidate(
        { paths: deps.store.paths, now: deps.now },
        {
          buffer: await gemini.generateImage(v.text, undefined, opts.signal),
          curatorId,
          index: i,
          nudge: v.nudge,
        },
      ),
    ),
    opts.onProgress,
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

  // Re-read + save synchronously so the slow generation above can't clobber a concurrent write
  // (issue #38). The candidate files are keyed on curatorId, so they attach to whatever the album's
  // current state is.
  const saved = deps.store.update(curatorId, (a) => {
    a.cardArtCandidates = candidates;
    a.status = deriveStatus(a.roadie);
  });
  if (!saved)
    throw new NotFoundError(`album ${curatorId} was deleted mid-generation`);
  return saved;
}

/**
 * Generate a single card-art candidate from one drafted prompt variant (Nano Banana), for the
 * per-prompt "Generate art" buttons (ADR 0021). Unlike the whole-set job, this is a single bounded
 * image call, so the route runs it synchronously and returns the merged candidate list. The new
 * candidate replaces any existing one at that index and is merged into `cardArtCandidates` under a
 * re-read (#38) so it never clobbers a sibling candidate a concurrent per-prompt/set run just wrote.
 * Requires a Gemini client + generation enabled (opt-in); an out-of-range index is a 400.
 */
export async function generateCardArtOne(
  deps: ActionDeps,
  curatorId: string,
  index: number,
  opts: GenerateOptions = {},
): Promise<AlbumAsset> {
  const { gemini, draft } = ensureCardArtGenerable(deps, curatorId);
  assertVariantIndex(draft, index);
  const variant = draft.variants[index]!;

  const buffer = await gemini.generateImage(
    variant.text,
    undefined,
    opts.signal,
  );
  const candidate = ingestCardArtCandidate(
    { paths: deps.store.paths, now: deps.now },
    { buffer, curatorId, index, nudge: variant.nudge },
  );

  const saved = deps.store.update(curatorId, (a) => {
    const others = (a.cardArtCandidates ?? []).filter((c) => c.index !== index);
    a.cardArtCandidates = [...others, candidate].sort(
      (x, y) => x.index - y.index,
    );
    a.status = deriveStatus(a.roadie);
  });
  if (!saved)
    throw new NotFoundError(`album ${curatorId} was deleted mid-generation`);
  return saved;
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

// --- tag write / verify (step 11, curator-spec §7) ---------------------------------------------

/**
 * Record that a physical sticker was written for this album (curator-spec §7). Sleeve and card are
 * tracked separately, since one may be written without the other. Writing the **sleeve** — the object
 * scanned on the stand — advances `awaiting_tag_write → awaiting_verify`; the card is independent
 * bookkeeping (it may be printed and tagged later) and never gates the transition. The physical act
 * (actually writing the NTAG) is manual; this is the Curator-side record.
 */
export function markTagWritten(
  deps: ActionDeps,
  curatorId: string,
  object: "sleeve" | "card",
  tagUid?: string,
): AlbumAsset {
  const asset = load(deps.store, curatorId);
  const now = clock(deps);
  const tag = asset.tag ?? { payload: `curator:album:${curatorId}` };
  tag[object] = {
    written: true,
    writtenAt: now(),
    ...(tagUid ? { tagUid } : {}),
  };
  asset.tag = tag;
  if (object === "sleeve" && asset.roadie.state === "awaiting_tag_write")
    transitionTo(asset, "awaiting_verify", now); // recomputes status
  deps.store.save(asset);
  return asset;
}

/**
 * Mark the album physically verified (step 11): record `verification.physicallyVerifiedAt` and
 * transition `awaiting_verify → verified` (throws if not in `awaiting_verify`). The ★verify Backdrop
 * reconcile (ADR 0015) is fired by the route after this, so it stays out of the store transaction.
 */
export function verifyPhysical(
  deps: ActionDeps,
  curatorId: string,
): AlbumAsset {
  const asset = load(deps.store, curatorId);
  const now = clock(deps);
  transitionTo(asset, "verified", now); // throws if not in awaiting_verify
  asset.verification = {
    ...asset.verification,
    physicallyVerifiedAt: now(),
  };
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
