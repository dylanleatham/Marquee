// The backend services the desktop app supervises, plus the health-poll used to gate the window on
// them being up. Kept separate from main.ts (which is all Electron glue) so this logic is unit-
// testable without launching Electron.
import { join } from "node:path";

export const CURATOR_PORT = 4739;
export const CONDUCTOR_PORT = 4737;

export interface ServiceSpec {
  name: string;
  /** Path to the server entry to `fork` (built ESM in dev, bundled .cjs when packaged). */
  entry: string;
  healthUrl: string;
  env: Record<string, string>;
}

/**
 * The two services, in start order. Ports are the services' own defaults, so Curator's default
 * `conductor.url` (localhost:4737) lines up with no extra config, and Conductor runs auth-disabled
 * (localhost-only, single box — the desktop app never leaves the machine).
 */
export function serviceSpecs(entries: {
  curator: string;
  conductor: string;
}): ServiceSpec[] {
  return [
    {
      name: "hue-conductor",
      entry: entries.conductor,
      healthUrl: `http://localhost:${CONDUCTOR_PORT}/healthz`,
      env: {},
    },
    {
      name: "curator",
      entry: entries.curator,
      healthUrl: `http://localhost:${CURATOR_PORT}/healthz`,
      // Pin Curator at the co-located Conductor. The repo `.env` points CONDUCTOR_URL at the Pi
      // (`conductor.local`) for real deployment; on one box that host doesn't resolve, so the Demo
      // Room would read "offline". Setting it here wins — Node's loadEnvFile won't override an
      // already-set var, so the `.env` Spotify creds still load.
      env: { CONDUCTOR_URL: `http://localhost:${CONDUCTOR_PORT}` },
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
