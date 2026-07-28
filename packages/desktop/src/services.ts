// The backend services the desktop app supervises, plus the health-poll used to gate the window on
// them being up. Kept separate from main.ts (which is all Electron glue) so this logic is unit-
// testable without launching Electron.
import { homedir } from "node:os";
import { join } from "node:path";

export const CURATOR_PORT = 4739;
export const CONDUCTOR_PORT = 4737;

/**
 * The data root both services must agree on, resolved the way Curator's own config does
 * (`MARQUEE_DATA_DIR`, else `~/marquee`). Exported so the caller can override it and so the
 * agreement is testable without reaching into the environment.
 *
 * Not covered: a `config.toml` with `[storage].data_dir`, which outranks the env var inside Curator
 * but is invisible from here. A packaged install has no `config.toml`, so this only bites a dev
 * running the desktop app over a customised repo config — narrow enough to leave, loud enough to
 * write down.
 */
export function resolveDataDir(): string {
  return process.env.MARQUEE_DATA_DIR ?? join(homedir(), "marquee");
}

export interface ServiceSpec {
  name: string;
  /** Path to the server entry to `fork` (built ESM in dev, bundled .cjs when packaged). */
  entry: string;
  healthUrl: string;
  env: Record<string, string>;
}

/** Absolute paths to the ffmpeg/ffprobe binaries Curator shells out to for video ingest. */
export interface FfmpegPaths {
  ffmpeg: string;
  ffprobe: string;
}

/**
 * The two services, in start order. Ports are the services' own defaults, so Curator's default
 * `conductor.url` (localhost:4737) lines up with no extra config, and Conductor runs auth-disabled
 * (localhost-only, single box — the desktop app never leaves the machine).
 *
 * `ffmpeg`, when given, points Curator at bundled ffmpeg/ffprobe binaries (`FFMPEG_PATH`/
 * `FFPROBE_PATH`) so the packaged app needs no system ffmpeg on PATH; omitted → Curator falls back
 * to PATH (fine in dev).
 */
export function serviceSpecs(
  entries: { curator: string; conductor: string },
  ffmpeg?: FfmpegPaths,
  dataDir: string = resolveDataDir(),
): ServiceSpec[] {
  // Pin Curator at the co-located Conductor. The repo `.env` points CONDUCTOR_URL at the Pi
  // (`conductor.local`) for real deployment; on one box that host doesn't resolve, so the Demo Room
  // would read "offline". Setting it here wins — Node's loadEnvFile won't override an already-set
  // var, so the `.env` Spotify creds still load.
  //
  // MARQUEE_DATA_DIR is pinned to the same resolved value that roots Conductor's ALBUM_ASSETS_DIR
  // below, so the pair agree by construction instead of by both happening to compute the same
  // default.
  const curatorEnv: Record<string, string> = {
    CONDUCTOR_URL: `http://localhost:${CONDUCTOR_PORT}`,
    MARQUEE_DATA_DIR: dataDir,
  };
  if (ffmpeg) {
    curatorEnv.FFMPEG_PATH = ffmpeg.ffmpeg;
    curatorEnv.FFPROBE_PATH = ffmpeg.ffprobe;
  }
  return [
    {
      name: "hue-conductor",
      entry: entries.conductor,
      healthUrl: `http://localhost:${CONDUCTOR_PORT}/healthz`,
      // On the Pi an rsync lands Curator's asset store where Conductor reads it (runbook A4.3).
      // The desktop app is one box with no rsync, so Conductor must be pointed straight at the
      // store Curator writes — otherwise it reads its own empty dir beside the install and answers
      // every scan `202 ignored: album not synced` while Preview claims the lights are running
      // (issue #164).
      env: { ALBUM_ASSETS_DIR: join(dataDir, "album-assets") },
    },
    {
      name: "curator",
      entry: entries.curator,
      healthUrl: `http://localhost:${CURATOR_PORT}/healthz`,
      env: curatorEnv,
    },
  ];
}

/** Built ESM server entries under a monorepo root — the dev / unpacked run path. */
export function devEntries(repoRoot: string): {
  curator: string;
  conductor: string;
} {
  return {
    curator: join(repoRoot, "packages", "curator", "dist", "server.js"),
    conductor: join(repoRoot, "packages", "hue-conductor", "dist", "server.js"),
  };
}

// Per-probe cap so a socket that connects but never answers can't hang boot: the fetch aborts and
// the caller falls through to its deadline check / false result (review: runtime).
const PROBE_TIMEOUT_MS = 2000;

/** One-shot health probe — used to adopt an already-running service instead of forking a duplicate. */
export async function isHealthy(url: string): Promise<boolean> {
  try {
    return (await fetch(url, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) }))
      .ok;
  } catch {
    return false;
  }
}

/** Poll a `/healthz` endpoint until it answers 200, or reject once `timeoutMs` elapses. */
export async function waitForHealth(
  url: string,
  timeoutMs = 30000,
  intervalMs = 300,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
      if (res.ok) return;
    } catch {
      // not accepting connections yet, or a probe timed out — keep polling until the deadline
    }
    if (Date.now() >= deadline)
      throw new Error(`Timed out after ${timeoutMs}ms waiting for ${url}`);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/**
 * Given each spec's current health (aligned by index), the services we must start ourselves — the
 * already-healthy ones are adopted. Pure so the adopt-vs-fork decision is unit-testable.
 */
export function servicesToStart(
  specs: ServiceSpec[],
  healthy: boolean[],
): ServiceSpec[] {
  return specs.filter((_, i) => !healthy[i]);
}
