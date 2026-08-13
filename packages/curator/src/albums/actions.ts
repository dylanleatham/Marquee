// The human-driven onboarding actions (step 7): mark a prompt copied, redraft a prompt, attach /
// detach a video or card art, approve or reject a preview. Each validates the album's state and
// throws a typed error the server maps to a status code. Kept out of server.ts to keep routes thin.
import { mkdirSync, existsSync, rmSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import {
  PATTERN_TYPES,
  validatePatternParams,
  type PatternType,
} from "@marquee/contracts";
import type { AssetStore } from "../store/asset-store.js";
import {
  transitionTo,
  deriveStatus,
  isProcessingState,
  TransitionError,
  type AlbumAsset,
  type RoadieState,
  type CardArtCandidate,
  type CardArtRefusal,
  type VideoClip,
} from "./asset.js";
import { replaceFile } from "../media/replace-file.js";
import { ValidationError, type PaletteGenerator } from "./add-manual.js";
import type { TagObject } from "../tags/flipper-nfc.js";
import {
  selectDefaultPattern,
  type PaletteColor,
} from "@marquee/palette-press";
import {
  sanitizePaletteEdit,
  blendPalettes,
  type PaletteEditColor,
  type PaletteSource,
} from "./palette.js";
import { feelingPaletteWithGemini } from "../gemini/feeling.js";
import { resolvedArtworkFile } from "./artwork.js";
import {
  draftPrompts,
  type PromptType,
  type DraftOptions,
  type DraftedPrompt,
  type PromptVariant,
} from "../roadie/prompts.js";
import { draftOnePromptWithGemini } from "../gemini/draft.js";
import {
  GeminiError,
  describeRefusal,
  type GeminiClient,
  type GeminiRefusal,
  type ReferenceImage,
} from "../gemini/client.js";
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
  /**
   * Palette generator for re-extraction. Optional on the type because callers may assemble
   * `ActionDeps` themselves, and `regeneratePalette` still refuses with a 400 when it is missing —
   * but no longer optional in practice: `buildServer` defaults it to real Palette Press
   * ([#319](https://github.com/dylanleatham/Marquee/issues/319)). Anything reached through the HTTP
   * API has one.
   */
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

/**
 * Draft one prompt type on demand — the lazy replacement for Roadie's old `drafting_prompts`
 * pipeline step (ADR 0027). Prefers the grounded LLM path and silently falls back to the
 * deterministic templates, so like the pipeline step it *cannot fail*: the caller always gets
 * prompts, LLM-authored or templated.
 *
 * Distinct from its one neighbour on purpose:
 *  - `regeneratePromptWithAI` requires Gemini and never falls back ("I specifically want AI").
 *  - this one is "I have no prompts yet, get me the best available" — the first-visit action, and
 *    the only way back to a template draft now that the style selector is gone (issue #140): it
 *    re-runs on demand and falls back, so a run without a Gemini key still reaches the templates.
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
/**
 * Override an album's motion with any of the seven pattern types, or return it to the derived
 * pattern with `null` (ADR 0039; generalises ADR 0035's streaming-only opt-in).
 *
 * Never a pattern *editor*: the derived `pattern` is left exactly as Palette Press produced it, so
 * clearing the override is a delete rather than a restore, a palette regeneration re-derives
 * underneath it, and an album can't lose its energy-aware motion by being overridden. Whether the
 * override displaces `pattern` or rides beside it is decided at payload-build time, per half.
 *
 * Rejected while Roadie is processing, for the same reason a palette edit is
 * ([ADR 0025](../../../../docs/adrs/0025-palette-edit-rejected-during-processing.md)): the pipeline
 * is still writing the asset.
 */
export function setPatternOverride(
  deps: ActionDeps,
  curatorId: string,
  type: PatternType | null,
  params?: unknown,
): AlbumAsset {
  const asset = load(deps.store, curatorId);
  assertNotProcessing(asset);
  if (type !== null && !PATTERN_TYPES.includes(type))
    throw new ValidationError(
      `unknown pattern — expected one of ${PATTERN_TYPES.join(", ")}, or null for the derived pattern`,
    );
  if (type === null) {
    delete asset.patternOverride;
    delete asset.patternOverrideParams;
  } else {
    // Switching type drops the old tuning rather than carrying it: the knobs are per-pattern, and
    // silently reinterpreting `aurora.scale` as something on `wave` would be worse than losing it.
    const switching = asset.patternOverride !== type;
    let clean: Record<string, number>;
    try {
      clean = validatePatternParams(type, params);
    } catch (err) {
      throw new ValidationError((err as Error).message);
    }
    asset.patternOverride = type;
    // `params` omitted entirely on a re-save of the same type means "leave the tuning alone";
    // omitted while switching means "start from this pattern's defaults".
    if (params !== undefined || switching) {
      if (Object.keys(clean).length > 0) asset.patternOverrideParams = clean;
      else delete asset.patternOverrideParams;
    }
  }
  deps.store.save(asset);
  return asset;
}

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
    source: "hand",
    // Carried, not dropped (ADR 0052). The rationale is Roadie's prose about *this record* — why
    // the sleeve reads the way it does — not a claim about the exact hexes. Nudging one swatch by a
    // shade used to delete it, and the record page shows it above the editor, so it would vanish
    // the first time you touched anything.
    ...(asset.palette.rationale ? { rationale: asset.palette.rationale } : {}),
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
  const coverPath = resolvedArtworkFile(deps.store, asset);
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
      source: "cover",
      ...(insufficient
        ? { insufficient: true, reason: payload.palette.reason }
        : {}),
    };
    // The candidates *followed* the palette being replaced, so they are re-pointed at the new
    // extraction rather than deleted (ADR 0052).
    //
    // Deleting them was right about `cover` and `blend` — both describe a cover that no longer
    // exists — and wrong about `feeling`, which is about how the record *sounds*. Re-extracting the
    // sleeve does not change that, and the record page promises the two source palettes are
    // permanent: "nothing you do to this list destroys either". Under the old behaviour, pressing
    // "back to Roadie's original" silently threw away a palette that costs a Gemini call to recover.
    const prior = a.paletteCandidates;
    if (prior) {
      const cover = payload.palette.colors.map((c) => ({ hex: c.hex }));
      a.paletteCandidates = {
        ...prior,
        cover: sanitizePaletteEdit(cover),
        // Re-blended against the palette that now exists — a stale blend is the thing the old
        // comment was rightly worried about.
        blend: sanitizePaletteEdit(
          blendPalettes(
            cover,
            prior.feeling.map((c) => ({ hex: c.hex })),
          ),
        ),
      };
    }
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

/**
 * Propose colours from how the album *sounds* (ADR 0030 / issue #105) — the escape hatch for a cover
 * whose colours aren't the ones you want. Two Gemini calls, invoked by a button press and never by
 * the pipeline or a batch sweep (ADR 0027).
 *
 * Stores the candidates and **changes nothing else**: the album keeps the palette it had until you
 * choose. That is what makes this safe to press — you can look at both against the sleeve, reload,
 * and still be looking at them.
 */
export async function proposeFeelingPalette(
  deps: ActionDeps,
  curatorId: string,
): Promise<AlbumAsset> {
  if (!deps.gemini)
    throw new ValidationError(
      "a Gemini API key is required to read colours from an album's feeling",
    );
  const asset = load(deps.store, curatorId);
  assertNotProcessing(asset);
  if (!asset.palette)
    throw new ValidationError(
      "the cover palette isn't generated yet — there is nothing to compare against",
    );

  const { rationale, hexes } = await feelingPaletteWithGemini(
    deps.gemini,
    asset.metadata,
  );
  // Through the same validation a hand-edit goes through: hex normalised, cie_xy recomputed and
  // gamut-clamped, roles positional. A model-supplied colour is no more trusted than a typed one.
  const feeling = sanitizePaletteEdit(hexes.map((hex) => ({ hex })));
  const blend = sanitizePaletteEdit(
    blendPalettes(
      asset.palette.colors.map((c) => ({ hex: c.hex })),
      hexes.map((hex) => ({ hex })),
    ),
  );

  const saved = deps.store.update(curatorId, (a) => {
    // Re-validate on the fresh copy: the album may have moved while the two calls ran (issue #38).
    assertNotProcessing(a);
    a.paletteCandidates = {
      generatedAt: clock(deps)(),
      rationale,
      cover: a.palette?.colors ?? [],
      feeling,
      blend,
    };
  });
  if (!saved)
    throw new NotFoundError(`album ${curatorId} was deleted mid-generation`);
  return saved;
}

/**
 * Apply one of the offered palettes (ADR 0030). `cover` re-runs Palette Press and drops the
 * protection, so it is the true undo; `feeling` and `blend` take the stored candidate.
 *
 * Choosing anything but the cover sets `handEdited` as well as `source`. That is deliberate reuse,
 * not a second mechanism: `handEdited` already means "a human decided this palette, don't overwrite
 * it", which is exactly true here — so `regeneratePalette`'s 409 and the library sweep's skip
 * (ADR 0029) protect a chosen palette with no new rule to keep in sync.
 */
export async function choosePalette(
  deps: ActionDeps,
  curatorId: string,
  source: PaletteSource,
): Promise<AlbumAsset> {
  if (source === "hand")
    throw new ValidationError(
      'a hand-edited palette is set by PUT /palette, not chosen — use "cover", "feeling" or "blend"',
    );
  // Back to the algorithmic extraction, protection cleared. force=true because the palette being
  // replaced is by definition a chosen one, and choosing the cover *is* the explicit user action
  // that the force flag exists to require.
  if (source === "cover") return regeneratePalette(deps, curatorId, true);

  const asset = load(deps.store, curatorId);
  assertNotProcessing(asset);
  const candidates = asset.paletteCandidates;
  if (!candidates)
    throw new ValidationError(
      "no palette candidates — run the feeling pass first",
    );

  const colors = candidates[source];
  const saved = deps.store.update(curatorId, (a) => {
    assertNotProcessing(a);
    a.palette = {
      colors,
      generatedAt: clock(deps)(),
      algorithm: a.palette?.algorithm ?? "palette-press",
      handEdited: true,
      source,
      rationale: candidates.rationale,
    };
    // Motion follows the palette in force (ADR 0033): a fiercer set of colours should drive a
    // livelier room. Re-deriving here is the point of choosing a feeling palette at all — otherwise
    // the colours change and the record still behaves like its sleeve.
    // sanitizePaletteEdit always computes cie_xy, so the fallback here is only to satisfy the
    // stored type's optionality — it is never reached for a candidate.
    const pattern = selectDefaultPattern({
      colors: colors.map((c) => ({
        hex: c.hex,
        cie_xy: c.cie_xy ?? ([0, 0] as [number, number]),
        role: c.role as PaletteColor["role"],
        sourceSwatch: c.sourceSwatch ?? "HandEdited",
      })),
    });
    a.pattern = {
      type: pattern.type,
      params: pattern.params,
      handEdited: false,
    };
    // A chosen palette is whatever the human picked — the monochrome-insufficient flag described the
    // cover extraction and no longer applies (same reasoning as editPalette).
    a.roadie.flags.palette_insufficient = false;
    a.status = deriveStatus(a.roadie);
  });
  if (!saved) throw new NotFoundError(`album ${curatorId} was deleted`);
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
 *
 * Then `settleNeeds`: on a record whose lights were signed off first (ADR 0063), the visualizer is
 * the need that unblocks the rest of the line, so it must carry on past `awaiting_preview` rather
 * than park there waiting for a sign-off that already happened.
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
    const now = clock(deps);
    if (a.roadie.state !== "awaiting_preview")
      transitionTo(a, "awaiting_preview", now);
    settleNeeds(a, now);
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

/**
 * Attach the video named by an attach body's `fileId` — either a filename in /incoming/, which is
 * claimed and moved (curator-spec §9 bulk-drop flow), or the id of a file already in `visualizers/`,
 * which is re-ingested into this album's own slot without disturbing the source (issue #99,
 * [ADR 0041](../../../../docs/adrs/0041-attach-by-fileid-re-keys-into-the-albums-own-slot.md)).
 * Re-attaching the album's own detached video resolves to the second form with source == destination,
 * which `ingestVideo` handles in place.
 */
export async function attachVideoByFileId(
  deps: ActionDeps,
  curatorId: string,
  fileId: string,
): Promise<AlbumAsset> {
  const asset = load(deps.store, curatorId);
  if (!VIDEO_ATTACHABLE.includes(asset.roadie.state))
    throw new TransitionError(asset.roadie.state, "awaiting_preview");
  const src = resolveAttachSource(deps.store, fileId, (id) =>
    storedVisualizerFile(deps.store, id),
  );

  const vis = await ingestVideo(
    { prober: deps.prober, paths: deps.store.paths, now: deps.now },
    {
      srcPath: src.path,
      fileId: curatorId,
      originalFilename: src.originalFilename,
      // Only an /incoming/ file is *claimed*; a stored one is a source we copy from and leave alone,
      // or — when it is this album's own — the destination itself.
      removeSrc: src.claimed,
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
 * Extension → mime type for cover art. `.jpg`/`.jpeg` are absent on purpose: they fall through to
 * each Gemini call's `image/jpeg` default, which is what covers overwhelmingly are.
 */
const MIME_BY_EXT: Record<string, string> = {
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
};

/**
 * The album's cover as a Gemini reference image, or undefined when there isn't one on disk. The one
 * place a cover is read for an LLM call — both generation paths go through it, so the mime type is
 * derived identically for video and card art (before ADR 0031 the video path hardcoded `image/jpeg`,
 * mislabelling a PNG override).
 *
 * Resolution goes through `resolvedArtworkFile`, so a manual artwork override is honoured. Callers
 * differ on whether absence is fatal: video throws (image-to-video needs something to animate), card
 * art degrades to a text-only prompt.
 */
function coverReference(
  deps: ActionDeps,
  asset: AlbumAsset,
): ReferenceImage | undefined {
  if (!asset.artwork) return undefined;
  const path = resolvedArtworkFile(deps.store, asset);
  if (!existsSync(path)) return undefined;
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return { bytes: readFileSync(path), mimeType: MIME_BY_EXT[ext] };
}

/**
 * Video preconditions → the (narrowed) Gemini client, loaded draft, and the cover as a reference
 * image. Shared by the route precheck and the action; returning the narrowed `gemini` lets the
 * action skip a redundant non-null assertion. The cover is non-optional here (unlike card art):
 * image-to-video has nothing to animate without one, so a missing cover is a 400.
 */
function ensureVideoGenerable(
  deps: ActionDeps,
  curatorId: string,
): { gemini: GeminiClient; draft: DraftedPrompt; cover: ReferenceImage } {
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
  const cover = coverReference(deps, asset);
  if (!cover)
    throw new ValidationError(
      "album has no cover art to animate — add art first",
    );
  return { gemini: deps.gemini, draft, cover };
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
  cover: ReferenceImage,
  variant: PromptVariant,
  index: number,
  now: () => string,
  signal?: AbortSignal,
): Promise<VideoClip> {
  const bytes = await gemini.generateVideo(variant.text, cover, { signal });
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
  const { gemini, draft, cover } = ensureVideoGenerable(deps, curatorId);
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
  const { gemini, draft, cover } = ensureVideoGenerable(deps, curatorId);
  assertVariantIndex(draft, index);
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

/**
 * Attach the image named by an attach body's `fileId` as card art — the same two forms as
 * `attachVideoByFileId`: an /incoming/ filename (claimed and moved) or the id of an image already in
 * `card-art/` (re-ingested into this album's own slot, source left alone). Re-ingesting sniffs the
 * bytes again, so a stored file keeps being validated rather than trusted for having been here before.
 */
export function attachCardArtByFileId(
  deps: ActionDeps,
  curatorId: string,
  fileId: string,
): AlbumAsset {
  const asset = load(deps.store, curatorId);
  const src = resolveAttachSource(deps.store, fileId, (id) =>
    storedCardArtFile(deps.store, id),
  );
  asset.cardArt = ingestCardArt(
    { paths: deps.store.paths, now: deps.now },
    {
      buffer: readFileSync(src.path),
      fileId: curatorId,
      originalFilename: src.originalFilename,
    },
  );
  // Same rule as the video path: claim (move) an /incoming/ file, leave a stored one where it is —
  // which also covers re-attaching this album's own card art, where the source *is* the destination
  // and removing it would delete what we just wrote.
  if (src.claimed) rmSync(src.path, { force: true });
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
 * Card-art preconditions → the (narrowed) Gemini client, loaded draft, and the cover reference when
 * one exists (route precheck + action). `cover` is attached only to `coverAnchored` variants — see
 * `referenceFor` / ADR 0031.
 */
function ensureCardArtGenerable(
  deps: ActionDeps,
  curatorId: string,
): {
  gemini: GeminiClient;
  draft: DraftedPrompt;
  cover: ReferenceImage | undefined;
} {
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
  return {
    gemini: deps.gemini,
    draft,
    cover: coverReference(deps, asset),
  };
}

/**
 * The reference image for one variant: the cover for the options that re-render the sleeve (Option 1
 * "Cover Reimagining"), undefined for the ones that deliberately depart from it (Signature Motif,
 * Visual Artist Provenance, Live Performance Era, Album Lore). Attaching it to all five would pull
 * the whole set back toward the cover and lose the spread the five-option strategy exists for
 * (ADR 0021 / ADR 0031).
 */
const referenceFor = (
  variant: PromptVariant,
  cover: ReferenceImage | undefined,
): ReferenceImage | undefined => (variant.coverAnchored ? cover : undefined);

/** A refused generation, or undefined if the error was something else (a 500, a timeout, a cancel). */
const refusalOf = (err: unknown): GeminiRefusal | undefined =>
  err instanceof GeminiError ? err.refusal : undefined;

/**
 * Generate one card-art image, retrying **once without the cover reference** if the first attempt
 * was refused (ADR 0032).
 *
 * Observed on a cover-anchored prompt: `IMAGE_RECITATION` — the model declining to reproduce
 * copyrighted material, that material being the album cover we handed it (issue #152). Asking for a
 * "direct adaptation" of a real sleeve while attaching that sleeve is close to a textbook recitation
 * trigger. The reference is the specific thing recitation is about, so removing it is a targeted
 * retry rather than a reword-and-hope.
 *
 * Bounded at exactly one retry, and only when there is a lever to pull: no reference on the first
 * attempt means an identical second attempt, so we don't spend the call. A non-refusal error
 * (network, 5xx, cancellation) rethrows untouched — retrying those is the caller's business.
 */
async function generateCardArtImage(
  gemini: GeminiClient,
  variant: PromptVariant,
  cover: ReferenceImage | undefined,
  signal?: AbortSignal,
): Promise<{ buffer: Buffer; coverReferenceDropped: boolean }> {
  const reference = referenceFor(variant, cover);
  try {
    return {
      buffer: await gemini.generateImage(variant.text, { signal, reference }),
      coverReferenceDropped: false,
    };
  } catch (err) {
    if (!reference || !refusalOf(err)) throw err;
    return {
      buffer: await gemini.generateImage(variant.text, { signal }),
      coverReferenceDropped: true,
    };
  }
}

/**
 * The refusal to record for a failed variant, or undefined when it failed for some other reason
 * (those already surface as the thrown error / a 5xx). `retriedWithoutCover` distinguishes "we had
 * a lever and pulled it, and it still said no" from "there was nothing to try".
 */
function refusalRecord(
  err: unknown,
  variant: PromptVariant,
  index: number,
  cover: ReferenceImage | undefined,
  at: string,
): CardArtRefusal | undefined {
  const refusal = refusalOf(err);
  if (!refusal) return undefined;
  return {
    index,
    ...(variant.nudge !== undefined ? { nudge: variant.nudge } : {}),
    reason: describeRefusal(refusal),
    retriedWithoutCover: referenceFor(variant, cover) !== undefined,
    at,
  };
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
  const { gemini, draft, cover } = ensureCardArtGenerable(deps, curatorId);
  // Generate *and* ingest inside allSettled: a candidate can fail either at the API (network/5xx)
  // or at ingest (Gemini returned 200 with non-image bytes). Both are per-candidate failures — the
  // set keeps the successes (ADR 0010). Doing the ingest in a bare forEach would let one malformed
  // image throw and discard the whole batch.
  const results = await settleWithProgress(
    draft.variants.map(async (v, i) => {
      const { buffer, coverReferenceDropped } = await generateCardArtImage(
        gemini,
        v,
        cover,
        opts.signal,
      );
      return ingestCardArtCandidate(
        { paths: deps.store.paths, now: deps.now },
        {
          buffer,
          curatorId,
          index: i,
          nudge: v.nudge,
          coverReferenceDropped,
        },
      );
    }),
    opts.onProgress,
  );

  const candidates: CardArtCandidate[] = results.flatMap((r) =>
    r.status === "fulfilled" ? [r.value] : [],
  );
  // A refused variant used to vanish here: rejected reasons were read only when *every* variant
  // failed, so 3-of-5 left two silent gaps in the gallery (issue #152). Keep each one, named.
  const at = clock(deps)();
  const refusals = results.flatMap((r, i) => {
    if (r.status !== "rejected") return [];
    const record = refusalRecord(r.reason, draft.variants[i]!, i, cover, at);
    return record ? [record] : [];
  });
  if (candidates.length === 0) {
    // Record before throwing. The all-refused case is the *worst* silent one — no images and no
    // explanation — and an early return here is what made it silent (issue #152).
    if (refusals.length > 0)
      deps.store.update(curatorId, (a) => {
        a.cardArtRefusals = refusals;
      });
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
    // The whole set was regenerated, so the previous run's refusals no longer describe anything.
    if (refusals.length > 0) a.cardArtRefusals = refusals;
    else delete a.cardArtRefusals;
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
  const { gemini, draft, cover } = ensureCardArtGenerable(deps, curatorId);
  assertVariantIndex(draft, index);
  const variant = draft.variants[index]!;

  let generated;
  try {
    generated = await generateCardArtImage(gemini, variant, cover, opts.signal);
  } catch (err) {
    // Record the refusal before rethrowing, so the album carries the reason even though the route
    // also surfaces it — the human may not be looking when the request returns (issue #152).
    const record = refusalRecord(err, variant, index, cover, clock(deps)());
    if (record)
      deps.store.update(curatorId, (a) => {
        const others = (a.cardArtRefusals ?? []).filter(
          (r) => r.index !== index,
        );
        a.cardArtRefusals = [...others, record].sort(
          (x, y) => x.index - y.index,
        );
      });
    throw err;
  }
  const candidate = ingestCardArtCandidate(
    { paths: deps.store.paths, now: deps.now },
    {
      buffer: generated.buffer,
      curatorId,
      index,
      nudge: variant.nudge,
      coverReferenceDropped: generated.coverReferenceDropped,
    },
  );

  const saved = deps.store.update(curatorId, (a) => {
    const others = (a.cardArtCandidates ?? []).filter((c) => c.index !== index);
    a.cardArtCandidates = [...others, candidate].sort(
      (x, y) => x.index - y.index,
    );
    // This index succeeded — any refusal recorded for it is now stale.
    const left = (a.cardArtRefusals ?? []).filter((r) => r.index !== index);
    if (left.length > 0) a.cardArtRefusals = left;
    else delete a.cardArtRefusals;
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

/**
 * "Looks right" — the lights sign-off, recorded on the asset (curator-spec §10).
 *
 * **Not gated on the machine** ([ADR 0063](../../../../docs/adrs/0063-the-machine-is-settled-from-the-asset-not-driven-by-the-button.md)).
 * This used to demand `awaiting_preview`, whose only entrance is attaching a visualizer — so on a
 * record with no visualizer, which is most of a freshly-synced collection, the lights need could
 * never be marked done at all. That is [ADR 0062](../../../../docs/adrs/0062-the-tag-step-is-recorded-on-the-asset-not-on-the-machine.md)'s
 * bug a second time, on the act that ADR explicitly left open (#263).
 *
 * The one thing it does refuse is a record with no palette: signing off means having watched the
 * lights, and there are none to watch yet. That is a claim about the artifact, so — unlike the state
 * gate it replaces — it cannot become unreachable in practice.
 *
 * Pressing it again is a no-op that keeps the original timestamp: the dock leaves the control on
 * screen afterwards, so a second press is an ordinary thing to do, and re-stamping it would restate
 * when you watched the record.
 */
export function approvePreview(
  deps: ActionDeps,
  curatorId: string,
): AlbumAsset {
  const now = clock(deps);
  // Read-mutate-save in one `update` rather than load/…/save. Both are synchronous here, so they
  // are equivalent today — but the needs are explicitly done in any order now, and the rule
  // that keeps a slow action from clobbering a concurrent write (#38) is worth not having to
  // re-derive from "does this function await anything?" every time it is edited.
  const saved = deps.store.update(curatorId, (a) => {
    if (!a.palette?.colors.length)
      throw new ValidationError(
        "Roadie hasn't pulled the lights for this record yet",
      );
    a.verification = {
      ...a.verification,
      previewApprovedAt: a.verification?.previewApprovedAt ?? now(),
    };
    settleNeeds(a, now);
  });
  if (!saved) throw new NotFoundError(`no such album: ${curatorId}`);
  return saved;
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

// --- naming an album on Spotify by hand (ADR 0059) ----------------------------------------------

/**
 * What a human can paste. Curator's own scheme is `spotify:album:<id>`, but the thing you get from
 * Spotify's share button is an `https://open.spotify.com/album/<id>?si=…` URL — and demanding the
 * URI form would mean explaining a conversion nobody should have to do.
 */
const SPOTIFY_ALBUM_INPUT = [
  /^spotify:album:([A-Za-z0-9]+)$/,
  /^https?:\/\/open\.spotify\.com\/(?:intl-[a-z]{2}\/)?album\/([A-Za-z0-9]+)/,
];

/** Normalize a pasted album reference to `spotify:album:<id>`, or `null` if it isn't one. */
export function normalizeSpotifyAlbum(input: string): string | null {
  const trimmed = input.trim();
  for (const re of SPOTIFY_ALBUM_INPUT) {
    const m = re.exec(trimmed);
    if (m) return `spotify:album:${m[1]}`;
  }
  return null;
}

/**
 * Name this album on Spotify by hand — or clear it with `null` (ADR 0059).
 *
 * The escape hatch for the two cases the matcher can't serve: it found nothing, or it found
 * something it deliberately won't play from. A pasted URI is a **fact**, not a guess, so it also
 * drops `spotifyMatch` — leaving the record of a guess beside a human's answer would let the UI keep
 * explaining a near-match that no longer decides anything.
 *
 * Deliberately not validated against Spotify: the album may be one Curator has never fetched, the
 * network may be down, and refusing a correct paste because a lookup failed would make the escape
 * hatch need its own escape hatch. A wrong id shows up as an empty tracklist, which is visible and
 * fixable right where you typed it.
 */
export function setSpotifyUri(
  deps: ActionDeps,
  curatorId: string,
  input: string | null,
): AlbumAsset {
  const uri = input === null ? null : normalizeSpotifyAlbum(input);
  if (input !== null && !uri)
    throw new ValidationError(
      `not a Spotify album link: ${JSON.stringify(input)} — paste a spotify:album:… URI or an open.spotify.com/album/… link`,
    );

  const asset = deps.store.update(curatorId, (a) => {
    if (uri) {
      a.metadata.spotifyUri = uri;
      delete a.metadata.spotifyMatch;
      /**
       * And the ambiguity, if there was one ([ADR 0068](../../../../docs/adrs/0068-ambiguous-is-a-third-answer-not-a-missing-one.md)).
       * This is the *primary* way an ambiguous record gets resolved — the picker on the record page
       * posts here — so leaving the marker would strand the definitive answer next to the reason
       * there wasn't one. A person naming the album is the strongest resolution there is; it ends
       * the question rather than adding to it.
       */
      delete a.metadata.spotifyAmbiguous;
    } else {
      delete a.metadata.spotifyUri;
      delete a.metadata.spotifyMatch;
      // The ambiguity goes too: it described a search for an album this record no longer claims, and
      // re-matching is what would establish whether it is still ambiguous.
      delete a.metadata.spotifyAmbiguous;
      // A demo cut names a track on the album we just disowned, so it can no longer be trusted to
      // be the right song — clearing it returns the demo tag to playing the record.
      a.demoTrack = null;
    }
  });
  if (!asset) throw new NotFoundError(`no such album: ${curatorId}`);
  return asset;
}

// --- the demo track (ADR 0058) -----------------------------------------------------------------

/** What the picker sends: the track's identity, without the bookkeeping the store adds. */
export interface DemoTrackChoice {
  spotifyUri: string;
  name: string;
  trackNumber?: number;
  durationMs?: number;
}

/**
 * Choose (or clear, with `null`) the track a demo tag plays for this album (ADR 0058).
 *
 * Gated on nothing: a demo track is a preference, not a step, so unlike the tag transitions this
 * works in any roadie state. Written through `store.update` rather than load-mutate-save because
 * this can land while Roadie is mid-pipeline on the same album — the read-before-save is what stops
 * the two clobbering each other.
 *
 * The URI must be a `spotify:track:` — the one field Amp actually hands Sonos. A `spotify:album:`
 * here would be accepted by Sonos and quietly play the whole record, which is precisely the bug
 * this feature exists to fix, so it is rejected at the boundary instead.
 */
export function setDemoTrack(
  deps: ActionDeps,
  curatorId: string,
  choice: DemoTrackChoice | null,
): AlbumAsset {
  if (choice) {
    if (!/^spotify:track:[A-Za-z0-9]+$/.test(choice.spotifyUri))
      throw new ValidationError(
        `not a Spotify track URI: ${JSON.stringify(choice.spotifyUri)}`,
      );
    if (!choice.name?.trim()) throw new ValidationError("track name is empty");
  }
  const at = clock(deps)();
  const asset = deps.store.update(curatorId, (a) => {
    a.demoTrack = choice
      ? {
          spotifyUri: choice.spotifyUri,
          name: choice.name.trim(),
          ...(choice.trackNumber ? { trackNumber: choice.trackNumber } : {}),
          ...(choice.durationMs ? { durationMs: choice.durationMs } : {}),
          chosenAt: at,
        }
      : null;
  });
  if (!asset) throw new NotFoundError(`no such album: ${curatorId}`);
  return asset;
}

// --- tag write / verify (step 11, curator-spec §7) ---------------------------------------------

/**
 * Record that a physical sticker was written for this album (curator-spec §7). Each object is
 * tracked separately, since one may be written without the others. Writing the **sleeve** — the
 * object scanned on the stand — advances `awaiting_tag_write → awaiting_verify`; the card and the
 * demo tag are independent bookkeeping (either may be made weeks later, or never) and never gate the
 * transition. The physical act (actually writing the NTAG) is manual; this is the Curator-side record.
 */
export function markTagWritten(
  deps: ActionDeps,
  curatorId: string,
  object: TagObject,
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
 * **Tags verified** — the record page's one button for the whole tag step (ADR 0052).
 *
 * The old bench had three controls in sequence: mark the sleeve written, mark the card written, then
 * mark physically verified. Two of those are bookkeeping about an act that happened at the Flipper,
 * not decisions — you write both stickers in one sitting, and nothing downstream distinguishes them.
 * The one that *is* a decision is the check: tapping each tag on a phone and confirming it opens the
 * right record, which is where the bugs turn up. So one button records the writes and the check
 * together, and verification stays a distinct, deliberate step rather than a third click.
 *
 * Both tags are marked written whatever their prior state, so pressing this after writing only the
 * sleeve does not leave the card claiming otherwise, and pressing it twice is a no-op rather than an
 * error — the panel keeps the button on screen after the check.
 *
 * **The record is on the asset, not in the machine** ([ADR 0062](../../../../docs/adrs/0062-the-tag-step-is-recorded-on-the-asset-not-on-the-machine.md)).
 * A sticker is a physical object: writing and checking it does not wait on a visualizer, so this
 * never throws for being early. It records the writes and `physicallyVerifiedAt` whatever the state,
 * and moves the machine only as far as the linear human path legally goes (`settleNeeds`).
 */
export function verifyTags(deps: ActionDeps, curatorId: string): AlbumAsset {
  const now = clock(deps);
  const at = now();
  // Through `update`, for the same reason as `approvePreview` above: one store idiom across the
  // human steps, so the write is safe by inspection rather than by tracing the awaits.
  const saved = deps.store.update(curatorId, (a) => {
    const tag = a.tag ?? { payload: `curator:album:${curatorId}` };
    for (const object of ["sleeve", "card"] as const)
      if (!tag[object]?.written) tag[object] = { written: true, writtenAt: at };
    a.tag = tag;
    a.verification = { ...a.verification, physicallyVerifiedAt: at };
    settleNeeds(a, now);
  });
  if (!saved) throw new NotFoundError(`no such album: ${curatorId}`);
  return saved;
}

/**
 * Move the machine as far along the linear human path as the **asset** says it may go, and no
 * further. The one place the needs model and the linear machine meet
 * ([ADR 0063](../../../../docs/adrs/0063-the-machine-is-settled-from-the-asset-not-driven-by-the-button.md)).
 *
 * The needs are done in any order (ADR 0052) but `HUMAN_TRANSITIONS` is a line. Rather than
 * each button driving its own edge — which is what made both the tag step (#261) and the lights
 * sign-off (#263) unreachable when the needs before them were outstanding — every step here is
 * gated on the **evidence on the asset**, not on which control was pressed. So it settles the same
 * way whichever need lands last, and there is nothing left to strand.
 *
 * Where the evidence runs out the state is left alone: the record genuinely still needs the other
 * things, and calling it `verified` would be a lie the collection would then repeat. From `verified`
 * there is nothing to do, which is what makes a second press harmless.
 */
function settleNeeds(asset: AlbumAsset, now: () => string): void {
  const done = asset.verification;
  if (asset.roadie.state === "awaiting_preview" && done?.previewApprovedAt)
    transitionTo(asset, "awaiting_tag_write", now);
  if (asset.roadie.state === "awaiting_tag_write" && done?.physicallyVerifiedAt)
    transitionTo(asset, "awaiting_verify", now);
  if (asset.roadie.state === "awaiting_verify" && done?.physicallyVerifiedAt)
    transitionTo(asset, "verified", now);
  asset.status = deriveStatus(asset.roadie);
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

/** Where an attach body's `fileId` resolved to, and whether attaching consumes it. */
interface AttachSource {
  path: string;
  /** True for an /incoming/ file — the caller moves it out. A stored file is only ever read. */
  claimed: boolean;
  /** What to record as the visualizer/card-art `originalFilename`. */
  originalFilename: string;
}

/**
 * Resolve an attach body's `fileId` to the file it names (curator-spec §Video / §Card art: "either an
 * ID of a file already in `visualizers/`, or the filename of a file in `/incoming/`"). `stored` maps
 * an id to its media-store path, or `undefined` when nothing is there.
 *
 * **The drop zone is probed first.** The two namespaces are near-disjoint in practice — a store id is a
 * bare curatorId (or `{curatorId}-v{n}`), an /incoming/ name carries its extension — but a name that
 * could mean both keeps the older claim-and-move meaning rather than silently changing behaviour for
 * an existing caller ([ADR 0041](../../../../docs/adrs/0041-attach-by-fileid-re-keys-into-the-albums-own-slot.md)).
 *
 * The `fileId` is validated as a bare on-disk name before either lookup: both paths are built by
 * joining it onto a media directory, so a nested or traversing name has to be rejected, not sanitized.
 */
function resolveAttachSource(
  store: AssetStore,
  fileId: string,
  stored: (id: string) => StoredFile | undefined,
): AttachSource {
  if (!fileId || fileId !== basenameOnly(fileId))
    throw new ValidationError(`invalid fileId "${fileId}"`);

  const incoming = store.paths.incomingFile(fileId);
  if (existsSync(incoming))
    return { path: incoming, claimed: true, originalFilename: fileId };

  const kept = stored(fileId);
  if (kept) return { ...kept, claimed: false };

  throw new NotFoundError(
    `no file "${fileId}" in /incoming/ or the media store`,
  );
}

/** A media-store file found by id. `originalFilename` is the id plus the extension it is stored under. */
type StoredFile = { path: string; originalFilename: string };

/** The stored visualizer for a fileId. Undefined if there is none — visualizers are always `.mp4`. */
function storedVisualizerFile(
  store: AssetStore,
  fileId: string,
): StoredFile | undefined {
  const path = store.paths.visualizerFile(fileId);
  return existsSync(path)
    ? { path, originalFilename: `${fileId}.mp4` }
    : undefined;
}

/** The stored card art for a fileId, whichever extension it landed with. Undefined if there is none. */
function storedCardArtFile(
  store: AssetStore,
  fileId: string,
): StoredFile | undefined {
  // The two extensions `ingestCardArt` can ever write (it sniffs magic bytes and canonicalises to
  // one of them), so this enumerates the whole namespace rather than guessing at it.
  for (const ext of ["png", "jpg"] as const) {
    const path = store.paths.cardArtFile(fileId, ext);
    if (existsSync(path)) return { path, originalFilename: `${fileId}.${ext}` };
  }
  return undefined;
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
 * than a re-copy of a potentially multi-GB file (issue #16). Overwrites any prior file of that name.
 *
 * Through `replaceFile` since issue #255. This used to unlink the destination first, unconditionally,
 * with a comment that a bare rename onto an existing path "throws on Windows" — half right: it throws
 * only when something has the destination **open**. The helper keeps the atomic rename for the
 * common case and unlinks only when it has to.
 */
export function saveIncoming(
  store: AssetStore,
  originalFilename: string,
  srcPath: string,
): { name: string } {
  const name = basenameOnly(originalFilename) || `upload-${Date.now()}`;
  mkdirSync(store.paths.incoming, { recursive: true });
  const dest = store.paths.incomingFile(name);
  replaceFile(srcPath, dest);
  return { name };
}
