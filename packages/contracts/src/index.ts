// @marquee/contracts — the single source of truth for cross-service shapes.
//
// Schemas live in ../schemas/*.json. Run `pnpm --filter @marquee/contracts gen`
// to (re)generate TypeScript types into ./generated from those schemas, then
// re-export them here. Until codegen is wired, hand-written types can live here.
//
// See docs/specs/integration-contract.md for the authoritative contract doc.

export const CONTRACTS_VERSION = 1 as const;

// TODO(build order step 0): wire scripts/gen-schemas.mjs and export generated types:
//   export type { PalettePayload } from "./generated/palette-payload.js";
//   export type { ScanEvent } from "./generated/scan-event.js";
//   export type { LibraryEntry } from "./generated/library-entry.js";
//   export type { AlbumAsset } from "./generated/album-asset.js";
