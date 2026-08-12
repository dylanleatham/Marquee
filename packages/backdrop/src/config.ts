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
  /**
   * The clip played for a record Curator knows about that has no visualizer of its own yet
   * (ADR 0073). Resolved against `mediaDir` when relative, so the operator only has to drop one file
   * beside the visualizers.
   *
   * Always a path, never null: an absent file is a *runtime* condition the controller reports on the
   * screen, not a boot-time one. Making it configurably-off would add a second way to express "no
   * default" that behaves identically to the first (the file isn't there), and the wrong one would
   * be silent.
   */
  defaultVisualizerPath: string;
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

/** Where visualizers live when config.toml doesn't say. */
const DEFAULT_MEDIA_DIR = "data/media/visualizers";

/** Filename of the fallback clip inside the media dir when config.toml doesn't say (ADR 0073). */
const DEFAULT_VISUALIZER_FILE = "default.mp4";

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
    mediaDir: resolve(pkgDir, String(storage.media_dir ?? DEFAULT_MEDIA_DIR)),
    // Placeholder: the real value is resolved below, against the *effective* media dir. Declared
    // here only so `base` is a complete Config.
    defaultVisualizerPath: "",
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
  const merged = { ...base, ...override };

  // Resolved last, and against `merged.mediaDir` rather than the file's — a caller that overrides
  // only the media dir (every test, and the desktop shell) must get a default clip that still sits
  // inside it. Resolved against the *file's* dir it would land outside, and `play()` refuses to load
  // anything outside `mediaDir`: the default would be configured, present on disk, and never play.
  return {
    ...merged,
    defaultVisualizerPath:
      override.defaultVisualizerPath ??
      resolve(
        merged.mediaDir,
        String(
          storage.default_visualizer ??
            process.env.BACKDROP_DEFAULT_VISUALIZER ??
            DEFAULT_VISUALIZER_FILE,
        ),
      ),
  };
}
