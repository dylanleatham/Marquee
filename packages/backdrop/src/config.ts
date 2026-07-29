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
  /**
   * Ceiling for a single `PUT /api/media/:fileId` (ADR 0038). Visualizer mp4s run to a few hundred
   * MB, so this is a disk-policy limit rather than a memory bound — the body streams to disk and is
   * never buffered. Bounded all the same: Backdrop runs off an SD card, and an unbounded upload
   * would fill it.
   */
  maxUploadBytes: number;
  /**
   * How long an inbound upload may make **no progress** before it is abandoned (ms, default 60s).
   *
   * A stall timeout, not a deadline, for the same reason as the client's: a real visualizer over a
   * poor link legitimately takes many minutes, so only "bytes stopped moving" separates slow from
   * dead. Without it a dropped Wi-Fi connection that never closes the socket leaves the read loop
   * waiting forever, holding a file descriptor and a temp file on the Pi's SD card.
   */
  uploadStallMs: number;
}

/** Default upload ceiling, in MB. Comfortably above a real visualizer, well under the Pi's card. */
const DEFAULT_MAX_UPLOAD_MB = 2048;

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
    // A malformed value falls back to the default rather than silently wedging every upload behind
    // a nonsense ceiling (same reasoning as Curator's own upload cap).
    uploadStallMs: Number(
      runtime.upload_stall_ms ?? process.env.BACKDROP_UPLOAD_STALL_MS ?? 60_000,
    ),
    maxUploadBytes: (() => {
      const mb = Number(
        storage.max_upload_mb ??
          process.env.BACKDROP_MAX_UPLOAD_MB ??
          DEFAULT_MAX_UPLOAD_MB,
      );
      return (
        (Number.isFinite(mb) && mb > 0 ? mb : DEFAULT_MAX_UPLOAD_MB) *
        1024 *
        1024
      );
    })(),
  };
  // `override` (tests, and buildServer opts) wins over file/env/defaults.
  return { ...base, ...override };
}
