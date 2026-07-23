import type { PalettePayload } from "@marquee/contracts";
import type { AlbumMetadata, GenerateOptions } from "./types.js";
import { extractSwatches } from "./extract.js";
import { postProcessPalette } from "./postprocess.js";
import { selectDefaultPattern } from "./pattern.js";

/** The palette carries the insufficient signal as additive fields (contract ignores extras). */
export type GeneratedPalettePayload = PalettePayload & {
  palette: PalettePayload["palette"] & {
    insufficient?: boolean;
    reason?: "monochrome" | "all_clamped" | "unusable_art";
  };
};

const GENERATOR = "palette-press@0.0.0";

const spotifyIdFrom = (uri?: string): string | undefined =>
  uri?.startsWith("spotify:album:")
    ? uri.slice("spotify:album:".length)
    : undefined;

/**
 * Primary entry point: album art bytes + metadata → a PalettePayload that validates against
 * the integration contract. Throws only on unreadable image bytes or missing metadata. An
 * insufficient palette (monochrome art, etc.) is a *return value* — check `palette.insufficient`.
 */
export async function generatePalette(
  artwork: Buffer,
  metadata: AlbumMetadata,
  options: GenerateOptions = {},
): Promise<GeneratedPalettePayload> {
  if (
    !metadata ||
    typeof metadata.curatorId !== "string" ||
    !metadata.curatorId
  ) {
    throw new Error("generatePalette: metadata.curatorId is required");
  }

  const { swatches, populations } = await extractSwatches(artwork, options);
  const result = postProcessPalette(swatches, options, populations);
  const pattern = selectDefaultPattern(result, {
    audioFeatures: metadata.audioFeatures,
  });

  return {
    version: 1,
    source: {
      type: "album",
      ...(metadata.name ? { name: metadata.name } : {}),
      ...(metadata.artist ? { artist: metadata.artist } : {}),
      ...(metadata.year !== undefined ? { year: metadata.year } : {}),
      ...(spotifyIdFrom(metadata.spotifyUri)
        ? { spotifyId: spotifyIdFrom(metadata.spotifyUri) }
        : {}),
    },
    palette: {
      colors: result.colors,
      ...(result.insufficient
        ? { insufficient: true, reason: result.reason }
        : {}),
    },
    pattern,
    meta: {
      generatedAt: new Date().toISOString(),
      generator: GENERATOR,
      // Echo audio features into the payload when the caller supplied them, so the signal that
      // shaped the pattern travels with it (integration-contract §1). Absent for most albums today.
      ...(metadata.audioFeatures
        ? { audioFeatures: metadata.audioFeatures }
        : {}),
    },
  };
}
