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
  buildAlbumAsset,
  buildFreshAsset,
  deriveStatus,
  isProcessingState,
  type AlbumAsset,
  type AlbumMetadata,
  type RoadieState,
} from "./albums/asset.js";
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
