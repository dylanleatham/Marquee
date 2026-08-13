// The backend services the desktop app supervises, plus the health-poll used to gate the window on
// them being up. Kept separate from main.ts (which is all Electron glue) so this logic is unit-
// testable without launching Electron.
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

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

/**
 * What `/healthz` has to report before the shell will believe it is talking to the service it meant
 * to talk to. A 200 only proves *something* is listening on the port — which is how a stale Curator
 * from another checkout came to answer the gate and get driven as if it were ours (issue #229).
 */
export interface ServiceIdentity {
  /** The `service` field `/healthz` must carry. Rules out any other 200, and older builds. */
  service: string;
  /** The `/healthz` field naming this service's on-disk root… */
  dirField: string;
  /** …and the value the shell pinned it to. A mismatch means a different collection. */
  dir: string;
}

export interface ServiceSpec {
  name: string;
  /** Path to the server entry to `fork` (built ESM in dev, bundled .cjs when packaged). */
  entry: string;
  healthUrl: string;
  env: Record<string, string>;
  identity: ServiceIdentity;
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
  instanceId: string = newInstanceId(),
): ServiceSpec[] {
  /**
   * Tell Curator about the Conductor started beside it — **without** claiming to be the only one
   * ([ADR 0079](../../../docs/adrs/0079-the-asset-push-has-more-than-one-target.md)).
   *
   * This used to set `CONDUCTOR_URL` itself. That pinned the Demo Room at the local Conductor, which
   * was the point (issue #164: the repo `.env` names the Pi, which on a one-box install does not
   * resolve, and Preview would read "offline") — but `CONDUCTOR_URL` is *also* where the asset push
   * gets its target, and Node's `loadEnvFile` won't override an already-set var, so the `.env`'s
   * real runtime became invisible to Curator entirely. The Pi's Conductor — and Amp, which reads the
   * directory Conductor writes — then had no writer at all, while `POST /api/runtime/sync` went on
   * reporting success ([#306](https://github.com/dylanleatham/Marquee/issues/306)).
   *
   * The co-located URL now travels under its own name. Curator aims the Demo Room at it exactly as
   * before, and pushes the store to it **and** to whatever `.env`/`config.toml` names.
   *
   * MARQUEE_DATA_DIR is pinned to the same resolved value that roots Conductor's ALBUM_ASSETS_DIR
   * below, so the pair agree by construction instead of by both happening to compute the same
   * default.
   */
  const curatorEnv: Record<string, string> = {
    MARQUEE_COLOCATED_CONDUCTOR_URL: `http://localhost:${CONDUCTOR_PORT}`,
    MARQUEE_DATA_DIR: dataDir,
    MARQUEE_INSTANCE_ID: instanceId,
  };
  if (ffmpeg) {
    curatorEnv.FFMPEG_PATH = ffmpeg.ffmpeg;
    curatorEnv.FFPROBE_PATH = ffmpeg.ffprobe;
  }
  // On the Pi an rsync lands Curator's asset store where Conductor reads it (runbook A4.3). The
  // desktop app is one box with no rsync, so Conductor must be pointed straight at the store Curator
  // writes — otherwise it reads its own empty dir beside the install and answers every scan
  // `202 ignored: album not synced` while Preview claims the lights are running (issue #164).
  const albumAssetsDir = join(dataDir, "album-assets");
  return [
    {
      name: "hue-conductor",
      entry: entries.conductor,
      healthUrl: `http://localhost:${CONDUCTOR_PORT}/healthz`,
      env: {
        ALBUM_ASSETS_DIR: albumAssetsDir,
        MARQUEE_INSTANCE_ID: instanceId,
      },
      // The store is the thing a foreign Conductor would get wrong, and getting it wrong is #164
      // all over again — so it's the directory the gate insists on agreeing about.
      identity: {
        service: "hue-conductor",
        dirField: "albumAssetsDir",
        dir: albumAssetsDir,
      },
    },
    {
      name: "curator",
      entry: entries.curator,
      healthUrl: `http://localhost:${CURATOR_PORT}/healthz`,
      env: curatorEnv,
      identity: { service: "curator", dirField: "dataDir", dir: dataDir },
    },
  ];
}

/**
 * A fresh token per launch, handed to every child in `MARQUEE_INSTANCE_ID` and required back from
 * `/healthz`. This is the whole of what makes "the Curator this launch started" distinguishable
 * from "a Curator" — see `probeHealth` (issue #229).
 */
export function newInstanceId(): string {
  return randomUUID();
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

/**
 * What answered (or didn't) at a service's `/healthz`:
 *
 * - `absent` — nothing listening yet. Ours to start, or still coming up.
 * - `ours` — carries this launch's instance token: the child we forked.
 * - `adoptable` — a Marquee service of the right kind rooted at the same directory, from some other
 *   launch. Adopting it is the documented behaviour (ADR 0008) and still safe: same collection.
 * - `foreign` — something else on the port, or the right service on a *different* directory. This
 *   is the case the gate used to be blind to (issue #229).
 */
export type HealthVerdict =
  | { kind: "absent" }
  | { kind: "ours" }
  | { kind: "adoptable" }
  | { kind: "foreign"; reason: string };

/**
 * Windows paths differ in case and separator without differing in meaning, and the two sides of this
 * comparison arrive by different routes (we pin an env var; the service reports what `resolve()`
 * made of it). Comparing the raw strings would report a conflict that isn't one.
 */
function sameDir(a: string, b: string): boolean {
  const norm = (p: string) =>
    process.platform === "win32"
      ? p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase()
      : // A backslash is a legal character in a POSIX filename, so it is not a separator here.
        p.replace(/\/+$/, "");
  return norm(a) === norm(b);
}

/** One `/healthz` GET. `null` when nothing answered 200 with a JSON object. */
async function readHealth(
  url: string,
): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const body: unknown = await res.json();
    return body && typeof body === "object"
      ? (body as Record<string, unknown>)
      : {};
  } catch {
    // not accepting connections, probe timed out, or the body wasn't JSON — see below for why the
    // last of those still counts as "nothing of ours answered" rather than as a conflict
    return null;
  }
}

/**
 * Identify whoever is on a service's port. The old gate asked "did something answer 200", which is
 * a liveness check wearing an identity check's clothes: a stale Curator from another checkout
 * answered it, the shell adopted it, and the window opened on a different collection with no curator
 * child in its own process tree (issue #229).
 *
 * A non-JSON or non-200 responder reads as `absent` rather than `foreign` — we then fork, and our
 * child's `EADDRINUSE` exit is what reports the conflict (`watchBootExit` in main.ts). That keeps
 * this function from having to guess at every possible squatter.
 */
export async function probeHealth(
  spec: ServiceSpec,
  instanceId: string,
): Promise<HealthVerdict> {
  const body = await readHealth(spec.healthUrl);
  if (!body) return { kind: "absent" };

  const { service, dirField, dir } = spec.identity;
  if (body.service !== service)
    return {
      kind: "foreign",
      reason:
        `expected ${service}, but got ` +
        (typeof body.service === "string"
          ? `${body.service}`
          : `a service that doesn't say what it is (an older Marquee build, or something unrelated)`),
    };
  if (body.instance === instanceId) return { kind: "ours" };

  const reported = body[dirField];
  if (typeof reported !== "string")
    return {
      kind: "foreign",
      reason: `another ${service} is already running and doesn't report its ${dirField}`,
    };
  if (!sameDir(reported, dir))
    return {
      kind: "foreign",
      reason: `another ${service} is already running on ${reported}, not ${dir}`,
    };
  return { kind: "adoptable" };
}

/**
 * Poll until the service reports *this launch's* instance token. Used after forking a child, so
 * "some other process holds the port" is a failure and not something to wait out — the old
 * `waitForHealth` would have been satisfied by that other process.
 */
export async function waitForOurs(
  spec: ServiceSpec,
  instanceId: string,
  timeoutMs = 30000,
  intervalMs = 300,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last: HealthVerdict = { kind: "absent" };
  for (;;) {
    last = await probeHealth(spec, instanceId);
    if (last.kind === "ours") return;
    if (last.kind === "foreign")
      throw new Error(`${spec.name} at ${spec.healthUrl}: ${last.reason}`);
    if (Date.now() >= deadline)
      throw new Error(
        `Timed out after ${timeoutMs}ms waiting for ${spec.name} at ${spec.healthUrl} ` +
          `(last seen: ${last.kind})`,
      );
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

type ExitListener = (
  code: number | null,
  signal: NodeJS.Signals | null,
) => void;

/**
 * Just the slice of `ChildProcess` `watchBootExit` touches — structural, so the exit paths can be
 * driven from a test without forking a real process to make it die on cue.
 */
export interface ChildExitEvents {
  once(event: "exit", listener: ExitListener): unknown;
  once(event: "error", listener: (err: Error) => void): unknown;
  off(event: "exit", listener: ExitListener): unknown;
  off(event: "error", listener: (err: Error) => void): unknown;
}

/**
 * A child that dies before it is healthy has to fail the boot. It didn't used to: the old poll was
 * happy with whatever else held the port, so a Curator that lost an `EADDRINUSE` race left the
 * window open on a stranger, behind a "service stopped — restart the app" dialog that restarting
 * could never fix (issue #229).
 *
 * Race `rejected` against the health wait, then `dispose()` once boot is past — otherwise the normal
 * shutdown kill would reject a promise nobody is waiting on any more.
 */
export function watchBootExit(
  spec: Pick<ServiceSpec, "name">,
  child: ChildExitEvents,
): { rejected: Promise<never>; dispose(): void } {
  let onExit!: (code: number | null, signal: NodeJS.Signals | null) => void;
  let onError!: (err: Error) => void;
  const rejected = new Promise<never>((_, reject) => {
    onExit = (code, signal) =>
      reject(
        new Error(
          `${spec.name} exited (${code ?? signal ?? "unknown"}) before it was ready. ` +
            `Another process may already be using its port — see the log for its output.`,
        ),
      );
    onError = (spawnErr) =>
      reject(new Error(`Could not start ${spec.name}: ${spawnErr.message}`));
    child.once("exit", onExit);
    child.once("error", onError);
  });
  return {
    rejected,
    dispose: () => {
      child.off("exit", onExit);
      child.off("error", onError);
    },
  };
}

/** What boot should do with each service, given what answered on its port. */
export interface BootPlan {
  /** Nothing there — fork it. */
  start: ServiceSpec[];
  /** Already running, same kind, same directory — use it (ADR 0008). */
  adopt: ServiceSpec[];
  /** Someone else's. Boot fails; the reason names the port and what's on it. */
  conflicts: { spec: ServiceSpec; reason: string }[];
}

/**
 * Sort the probe verdicts (aligned by index) into the three outcomes. Pure, so the adopt / fork /
 * refuse decision is unit-testable without standing up servers.
 */
export function planBoot(
  specs: ServiceSpec[],
  verdicts: HealthVerdict[],
): BootPlan {
  const plan: BootPlan = { start: [], adopt: [], conflicts: [] };
  specs.forEach((spec, i) => {
    const verdict = verdicts[i] ?? { kind: "absent" };
    if (verdict.kind === "foreign")
      plan.conflicts.push({ spec, reason: verdict.reason });
    // `ours` can't happen before we've forked anything, but if it somehow does the service is
    // already the one we want — adopting is the same no-op as leaving it alone.
    else if (verdict.kind === "adoptable" || verdict.kind === "ours")
      plan.adopt.push(spec);
    else plan.start.push(spec);
  });
  return plan;
}
