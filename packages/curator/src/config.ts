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
  /** Spotify client-credentials, if configured. Absent → the Spotify add/search routes 503. */
  spotify?: { clientId: string; clientSecret: string };
}

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

  const base: Config = {
    port: Number(server.port ?? process.env.CURATOR_PORT ?? 4739),
    host: String(server.host ?? "127.0.0.1"),
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
