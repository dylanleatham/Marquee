import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { parse as parseToml } from "smol-toml";

// Resolve config.toml next to the package (matches hue-conductor), not the process cwd.
const pkgDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export interface Config {
  port: number;
  host: string;
  /** Root for the album-assets store and the media store (default ~/marquee). */
  dataDir: string;
  /** Ceiling for a single multipart upload. Visualizer videos are the only large uploads. */
  maxUploadBytes: number;
  /** Spotify client-credentials, if configured. Absent → the Spotify add/search routes 503. */
  spotify?: { clientId: string; clientSecret: string };
}

// Upload ceiling. A compiled-in 500 MB cap rejected real 1 GB visualizer videos (issue #12), so
// this is configurable and defaults high enough for them. Uploads stream straight to a temp file
// (issue #16 / ADR 0006), so this is a disk/policy limit, not a memory-safety bound — raise it as
// far as disk allows. It's still bounded (not unlimited) so a runaway upload can't fill the disk.
const DEFAULT_MAX_UPLOAD_MB = 2048;

/**
 * Curator config from config.toml / env / defaults. Curator's own UI+API runs unauthenticated
 * on the LAN (like Home Assistant, per runtime-overview §8); the shared secret only matters for
 * the outbound pushes to Conductor/Backdrop, which arrive in a later step. `override` wins (tests).
 */
export function loadConfig(override: Partial<Config> = {}): Config {
  const path = process.env.CURATOR_CONFIG ?? join(pkgDir, "config.toml");
  const file = existsSync(path)
    ? (parseToml(readFileSync(path, "utf8")) as Record<
        string,
        Record<string, unknown>
      >)
    : {};
  const server = file.server ?? {};
  const storage = file.storage ?? {};
  const spotifyFile = file.spotify ?? {};

  const clientId =
    (spotifyFile.client_id as string | undefined) ??
    process.env.SPOTIFY_CLIENT_ID;
  const clientSecret =
    (spotifyFile.client_secret as string | undefined) ??
    process.env.SPOTIFY_CLIENT_SECRET;

  // A malformed value (NaN, zero, negative) falls back to the default rather than silently
  // wedging every upload behind a nonsense ceiling.
  const maxUploadMb = Number(
    storage.max_upload_mb ??
      process.env.CURATOR_MAX_UPLOAD_MB ??
      DEFAULT_MAX_UPLOAD_MB,
  );

  const base: Config = {
    port: Number(server.port ?? process.env.CURATOR_PORT ?? 4739),
    host: String(server.host ?? "127.0.0.1"),
    maxUploadBytes:
      (Number.isFinite(maxUploadMb) && maxUploadMb > 0
        ? maxUploadMb
        : DEFAULT_MAX_UPLOAD_MB) *
      1024 *
      1024,
    dataDir: resolve(
      String(
        storage.data_dir ??
          process.env.MARQUEE_DATA_DIR ??
          join(homedir(), "marquee"),
      ),
    ),
    ...(clientId && clientSecret
      ? { spotify: { clientId, clientSecret } }
      : {}),
  };
  return { ...base, ...override };
}
