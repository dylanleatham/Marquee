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
  buildManualAsset,
  type AlbumAsset,
  type AlbumMetadata,
} from "./albums/asset.js";
export { generateCuratorId, isCuratorId } from "./ids.js";
export { loadConfig, type Config } from "./config.js";
