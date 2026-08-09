// @marquee/curator — admin app + source of truth for the collection. See docs/specs/curator-spec.md.

export { buildServer, type BuildOptions } from "./server.js";
export { AssetStore } from "./store/asset-store.js";
export { Paths } from "./store/paths.js";
export {
  addManualAlbum,
  ValidationError,
  type ManualAlbumInput,
  type PaletteGenerator,
} from "./albums/add-manual.js";
export {
  addSpotifyAlbum,
  DuplicateAlbumError,
  parseAlbumId,
} from "./albums/add-spotify.js";
export {
  addDiscogsAlbum,
  buildAlbumIndexes,
  buildDiscogsIndex,
  type DiscogsIndex,
} from "./albums/add-discogs.js";
export {
  discogsSyncRunner,
  MAX_SYNC_PAGES,
  type DiscogsSyncReport,
  type DiscogsSyncOutcome,
} from "./albums/discogs-sync.js";
export {
  DiscogsPoller,
  MIN_POLL_INTERVAL_MS,
  DEFAULT_POLL_INTERVAL_MS,
  type DiscogsPollerStatus,
} from "./discogs/poller.js";
export {
  buildAlbumAsset,
  buildFreshAsset,
  deriveStatus,
  isProcessingState,
  transitionTo,
  canTransition,
  TransitionError,
  type AlbumAsset,
  type AlbumMetadata,
  type RoadieState,
} from "./albums/asset.js";
export * as actions from "./albums/actions.js";
export { NotFoundError } from "./albums/actions.js";
export {
  validateVideo,
  ingestVideo,
  ffmpegProber,
  VideoError,
  DECODE_BUDGET,
  budgetViolations,
  needsNormalize,
  buildNormalizeArgs,
  fitWithinBudget,
  parseFrameRate,
  type VideoProber,
  type VideoInfo,
  type BudgetViolation,
} from "./media/video.js";
export {
  detectImage,
  imageSize,
  ingestCardArt,
  ImageError,
} from "./media/images.js";
export { Roadie, type RoadieOptions } from "./roadie/worker.js";
export {
  draftPrompts,
  VIDEO_TEMPLATES,
  CARD_ART_TEMPLATES,
  type PromptDrafts,
} from "./roadie/prompts.js";
export {
  SpotifyClient,
  SpotifyError,
  type SpotifyAlbumMeta,
  type SpotifyClientOptions,
} from "./spotify/client.js";
export { generateCuratorId, isCuratorId } from "./ids.js";
export { loadConfig, type Config } from "./config.js";
