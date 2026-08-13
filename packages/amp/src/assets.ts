// Read the synced album-assets store at scan time to resolve a scan's album → what to play: the
// album's Spotify URI for a card, or its chosen demo track for a demo tag (ADR 0058).
// Mirrors hue-conductor's FsAlbumAssetReader (ADR 0019) but reads the Spotify slice instead of the
// palette slice. Injectable so tests seed albums without touching disk.
import { readFile } from "node:fs/promises";
import { join } from "node:path";

/** The narrow slice of an album asset Amp needs. Curator's full AlbumAsset is a structural superset. */
export interface AlbumSpotifyInput {
  metadata: {
    name: string;
    artist: string;
    /** `spotify:album:<id>`, present only when the album is on Spotify (optional in the asset). */
    spotifyUri?: string;
  };
  /**
   * The one track a **demo** scan plays (ADR 0058), chosen by hand in Curator. Absent or null — the
   * default for every album — means a demo scan plays the whole album, exactly as a card does.
   */
  demoTrack?: {
    /** `spotify:track:<id>`. Reported back on the scan, and the fallback hand-off (ADR 0078). */
    spotifyUri: string;
    name?: string;
    /**
     * 1-based position in the album — how the cut is actually played ([ADR 0078](../../../docs/adrs/0078-a-demo-cut-plays-as-a-position-in-the-album.md)): Sonos is
     * given the album container and seeked here, because it will not start a bare track. Optional on
     * the asset, so a cut recorded without one still plays by the older route.
     */
    trackNumber?: number;
  } | null;
}

/** Reads one album's Spotify-relevant fields by curatorId, or null if absent/unreadable. */
export interface AlbumAssetReader {
  read(curatorId: string): Promise<AlbumSpotifyInput | null>;
}

/**
 * Filesystem reader over the synced store at `{albumAssetsDir}/{curatorId}.json`. Async so the disk
 * read doesn't block the always-on service. A missing or unparseable file returns null rather than
 * throwing — a scan for an album Amp hasn't synced yet must degrade gracefully (stay silent), not
 * error (runtime-overview §9).
 */
export class FsAlbumAssetReader implements AlbumAssetReader {
  constructor(private readonly dir: string) {}

  async read(curatorId: string): Promise<AlbumSpotifyInput | null> {
    // curatorId reaches here from a scan URI — validate its shape before building a path from it.
    if (!/^[a-z0-9]{8}$/.test(curatorId)) return null;
    try {
      const raw = await readFile(join(this.dir, `${curatorId}.json`), "utf8");
      return JSON.parse(raw) as AlbumSpotifyInput;
    } catch {
      // ENOENT (not synced) or bad JSON — both degrade to "stay silent".
      return null;
    }
  }
}
