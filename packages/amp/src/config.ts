import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { parse as parseToml } from "smol-toml";

const pkgDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export interface Config {
  port: number;
  host: string;
  sharedSecret: string | null;
  dataDir: string;
  /**
   * Where Amp reads the synced album-assets store at scan time (same rsync target Conductor reads —
   * ADR 0019/0023). Defaults to `{dataDir}/album-assets`, overridable so the sync target can differ
   * from Amp's own data dir.
   */
  albumAssetsDir: string;
  idleTimeoutMinutes: number;
  /** Default Sonos room/group to play cards on. Can be overridden at runtime via PUT /api/settings. */
  defaultTargetRoom: string | null;
}

/**
 * Load config from config.toml (next to the package, or $AMP_CONFIG), with env fallbacks and sane
 * defaults. Mirrors hue-conductor's loadConfig — on the workstation env + defaults are enough for dev.
 */
export function loadConfig(override: Partial<Config> = {}): Config {
  const path = process.env.AMP_CONFIG ?? join(pkgDir, "config.toml");
  const file = existsSync(path)
    ? (parseToml(readFileSync(path, "utf8")) as Record<
        string,
        Record<string, unknown>
      >)
    : {};

  const server = file.server ?? {};
  const auth = file.auth ?? {};
  const storage = file.storage ?? {};
  const runtime = file.runtime ?? {};
  const sonos = file.sonos ?? {};

  const base: Config = {
    port: Number(server.port ?? process.env.AMP_PORT ?? 4741),
    host: String(server.host ?? "0.0.0.0"),
    sharedSecret:
      (auth.shared_secret as string | undefined) ??
      process.env.TRIGGER_SHARED_SECRET ??
      null,
    dataDir: resolve(pkgDir, String(storage.data_dir ?? "data")),
    albumAssetsDir: resolve(
      pkgDir,
      String(
        storage.album_assets_dir ??
          process.env.ALBUM_ASSETS_DIR ??
          join(String(storage.data_dir ?? "data"), "album-assets"),
      ),
    ),
    idleTimeoutMinutes: Number(runtime.idle_timeout_minutes ?? 90),
    defaultTargetRoom:
      (sonos.target_room as string | undefined) ??
      process.env.AMP_TARGET_ROOM ??
      null,
  };
  // `override` (used by tests) wins over file/env/defaults.
  return { ...base, ...override };
}
