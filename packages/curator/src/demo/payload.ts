// Build the cross-service PalettePayload (@marquee/contracts) that Conductor's playback engine
// consumes, from an album's stored palette + pattern. Used by the Demo Room to drive the real
// lights (issue: runtime preview). Kept tiny and pure so it's trivially unit-testable.
import type { PalettePayload, PaletteRole } from "@marquee/contracts";
import type { AlbumAsset } from "../albums/asset.js";

/** The album isn't far enough along to drive a light show (no palette/pattern yet). Server → 409. */
export class DemoNotReadyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DemoNotReadyError";
  }
}

const ROLES: PaletteRole[] = ["primary", "secondary", "accent"];
const asRole = (role: string): PaletteRole =>
  (ROLES as string[]).includes(role) ? (role as PaletteRole) : "accent";

const PATTERN_TYPES: PalettePayload["pattern"]["type"][] = [
  "static",
  "rotate",
  "pulse",
  "crossfade",
];

/**
 * Map a stored album into the palette+pattern payload Conductor plays. Throws DemoNotReadyError if
 * the album has no palette/pattern yet (still in Roadie's pipeline). Roles/pattern-type outside the
 * contract's unions are coerced to safe defaults rather than rejected — the light show is best-effort.
 */
export function buildPalettePayload(asset: AlbumAsset): PalettePayload {
  if (!asset.palette || asset.palette.colors.length === 0)
    throw new DemoNotReadyError("album has no palette yet");
  if (!asset.pattern) throw new DemoNotReadyError("album has no pattern yet");

  const type = (PATTERN_TYPES as string[]).includes(asset.pattern.type)
    ? (asset.pattern.type as PalettePayload["pattern"]["type"])
    : "static";

  return {
    version: 1,
    source: {
      type: "album",
      name: asset.metadata.name,
      artist: asset.metadata.artist,
      ...(asset.metadata.year ? { year: asset.metadata.year } : {}),
    },
    palette: {
      colors: asset.palette.colors.map((c) => ({
        hex: c.hex,
        role: asRole(c.role),
        ...(c.cie_xy ? { cie_xy: c.cie_xy } : {}),
      })),
    },
    pattern: {
      type,
      params: asset.pattern.params as PalettePayload["pattern"]["params"],
    },
  };
}
