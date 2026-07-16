// The human-driven onboarding actions (step 7): mark a prompt copied, redraft a prompt, attach /
// detach a video or card art, approve or reject a preview. Each validates the album's state and
// throws a typed error the server maps to a status code. Kept out of server.ts to keep routes thin.
import {
  mkdirSync,
  existsSync,
  rmSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import type { AssetStore } from "../store/asset-store.js";
import {
  transitionTo,
  deriveStatus,
  TransitionError,
  type AlbumAsset,
  type RoadieState,
} from "./asset.js";
import { ValidationError } from "./add-manual.js";
import {
  draftPrompts,
  type PromptType,
  type DraftOptions,
} from "../roadie/prompts.js";
import { ingestVideo, type VideoProber } from "../media/video.js";
import { ingestCardArt } from "../media/images.js";

export class NotFoundError extends Error {
  constructor(message = "not found") {
    super(message);
    this.name = "NotFoundError";
  }
}

export interface ActionDeps {
  store: AssetStore;
  prober: VideoProber;
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

/** Attach a freshly-uploaded video (raw bytes). Ingests into visualizers/{curatorId}.mp4. */
export async function attachVideoUpload(
  deps: ActionDeps,
  curatorId: string,
  buffer: Buffer,
  originalFilename: string,
): Promise<AlbumAsset> {
  const asset = load(deps.store, curatorId);
  if (!VIDEO_ATTACHABLE.includes(asset.roadie.state))
    throw new TransitionError(asset.roadie.state, "awaiting_preview");

  // ffprobe needs a path; stage the bytes in /incoming/ under a temp name, then ingest + remove.
  mkdirSync(deps.store.paths.incoming, { recursive: true });
  const tmp = deps.store.paths.incomingFile(
    `.upload-${curatorId}-${Date.now()}.mp4`,
  );
  writeFileSync(tmp, buffer);
  const vis = await ingestVideo(
    { prober: deps.prober, paths: deps.store.paths, now: deps.now },
    { srcPath: tmp, fileId: curatorId, originalFilename, removeSrc: true },
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

// --- card art ----------------------------------------------------------------------------------

export function attachCardArtUpload(
  deps: ActionDeps,
  curatorId: string,
  buffer: Buffer,
  originalFilename: string,
): AlbumAsset {
  const asset = load(deps.store, curatorId);
  // Card art is independent of the state machine — it can be added at any point, even after verified.
  asset.cardArt = ingestCardArt(
    { paths: deps.store.paths, now: deps.now },
    { buffer, fileId: curatorId, originalFilename },
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

/** Save a raw upload with no curatorId into /incoming/ for a later claim (curator-spec §9). */
export function saveIncoming(
  store: AssetStore,
  originalFilename: string,
  buffer: Buffer,
): { name: string } {
  const name = basenameOnly(originalFilename) || `upload-${Date.now()}`;
  mkdirSync(store.paths.incoming, { recursive: true });
  const dest = store.paths.incomingFile(name);
  writeFileSync(dest, buffer);
  return { name };
}
