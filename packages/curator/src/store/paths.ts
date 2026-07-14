import { join, sep } from "node:path";

/** Store paths are written into JSON as POSIX (curator-spec gotcha: convert at read time). */
export const toPosix = (p: string): string => p.split(sep).join("/");

/**
 * Resolves the on-disk layout under a data root (curator-spec §6):
 *   {dataDir}/album-assets/{curatorId}.json
 *   {dataDir}/media/{artwork,artwork-overrides,card-art,visualizers,thumbnails,incoming}/…
 */
export class Paths {
  readonly albumAssets: string;
  readonly media: string;
  readonly artwork: string;
  readonly artworkOverrides: string;
  readonly cardArt: string;
  readonly visualizers: string;
  readonly thumbnails: string;
  readonly incoming: string;

  constructor(readonly dataDir: string) {
    this.albumAssets = join(dataDir, "album-assets");
    this.media = join(dataDir, "media");
    this.artwork = join(this.media, "artwork");
    this.artworkOverrides = join(this.media, "artwork-overrides");
    this.cardArt = join(this.media, "card-art");
    this.visualizers = join(this.media, "visualizers");
    this.thumbnails = join(this.media, "thumbnails");
    this.incoming = join(this.media, "incoming");
  }

  assetFile(curatorId: string): string {
    return join(this.albumAssets, `${curatorId}.json`);
  }

  /** Downloaded/uploaded cover art, keyed on curatorId. Relative POSIX path for the asset JSON. */
  artworkFile(curatorId: string): string {
    return join(this.artwork, `${curatorId}.jpg`);
  }

  /** Attached visualizer video (H.264/MP4), keyed on fileId (usually the curatorId). */
  visualizerFile(fileId: string): string {
    return join(this.visualizers, `${fileId}.mp4`);
  }

  /** Video thumbnail (jpg), keyed on fileId. */
  thumbnailFile(fileId: string): string {
    return join(this.thumbnails, `${fileId}.jpg`);
  }

  /** Card-art image (Curator-only). Extension varies (png/jpg) — stored in the asset. */
  cardArtFile(fileId: string, ext: string): string {
    return join(this.cardArt, `${fileId}.${ext.replace(/^\./, "")}`);
  }

  /** A file in the /incoming/ drop zone. `name` is a bare filename (validated by the caller). */
  incomingFile(name: string): string {
    return join(this.incoming, name);
  }

  /** Path relative to dataDir, POSIX-formatted, for storing inside the asset JSON. */
  relPosix(absPath: string): string {
    return toPosix(
      absPath.startsWith(this.dataDir)
        ? absPath.slice(this.dataDir.length + 1)
        : absPath,
    );
  }
}
