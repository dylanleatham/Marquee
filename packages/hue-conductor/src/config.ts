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
  idleTimeoutMinutes: number;
}

/**
 * Load config from config.toml (next to the package, or $CONDUCTOR_CONFIG), with env
 * fallbacks and sane defaults. On the workstation there may be no config.toml — env +
 * defaults are enough for dev.
 */
export function loadConfig(): Config {
  const path = process.env.CONDUCTOR_CONFIG ?? join(pkgDir, "config.toml");
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

  return {
    port: Number(server.port ?? process.env.CONDUCTOR_PORT ?? 4737),
    host: String(server.host ?? "0.0.0.0"),
    sharedSecret:
      (auth.shared_secret as string | undefined) ??
      process.env.TRIGGER_SHARED_SECRET ??
      null,
    dataDir: resolve(pkgDir, String(storage.data_dir ?? "data")),
    idleTimeoutMinutes: Number(runtime.idle_timeout_minutes ?? 90),
  };
}
