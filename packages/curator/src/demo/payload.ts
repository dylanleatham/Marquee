// The album → PalettePayload mapping now lives in @marquee/contracts (issue #45 / ADR 0019), so
// Conductor's /api/scan and Curator's Demo Room build the light-show payload the exact same way from
// one source. Re-exported here so existing Curator imports keep working; `DemoNotReadyError` is kept
// as an alias for the shared `PaletteNotReadyError`.
export {
  buildPalettePayload,
  PaletteNotReadyError,
  PaletteNotReadyError as DemoNotReadyError,
} from "@marquee/contracts";
