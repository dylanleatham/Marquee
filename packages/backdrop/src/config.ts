import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { parse as parseToml } from "smol-toml";

const pkgDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export interface Config {
  port: number;
  host: string;
  /** X-Trigger-Secret required on every route except /healthz. Null → auth disabled (dev). */
  sharedSecret: string | null;
  /** Where library.json lives. */
  dataDir: string;
  /**
   * Root the browser is allowed to load videos from. A scan's resolved filePath must sit under
   * this (backdrop-spec §5: videos are served straight off local disk). Kept configurable so tests
   * can point it at a temp dir.
   */
  mediaDir: string;
  /** Auto-fade to idle after this many minutes with no scan event (safety net for a lost `stop`). */
  idleTimeoutMinutes: number;
}

/**
 * Load config from config.toml (next to the package, or $BACKDROP_CONFIG) with env fallbacks and
 * sane defaults — mirrors Conductor's loader. On the Pi there's a config.toml; on the workstation
 * env + defaults are enough for dev and tests.
 */
export function loadConfig(override: Partial<Config> = {}): Config {
  const path = process.env.BACKDROP_CONFIG ?? join(pkgDir, "config.toml");
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

  const base: Config = {
    port: Number(server.port ?? process.env.BACKDROP_PORT ?? 4740),
    host: String(server.host ?? "0.0.0.0"),
    sharedSecret:
      (auth.shared_secret as string | undefined) ??
      process.env.TRIGGER_SHARED_SECRET ??
      null,
    dataDir: resolve(pkgDir, String(storage.data_dir ?? "data")),
    mediaDir: resolve(
      pkgDir,
      String(storage.media_dir ?? "data/media/visualizers"),
    ),
    idleTimeoutMinutes: Number(runtime.idle_timeout_minutes ?? 90),
  };
  // `override` (tests, and buildServer opts) wins over file/env/defaults.
  return { ...base, ...override };
}
