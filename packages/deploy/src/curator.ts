// The workstation's own trap, and the check that catches it.
//
// Curator is the one service with no systemd unit — it runs under the desktop shell — so the deploy
// cannot restart it and cannot use a unit's restart timestamp to prove it did. Worse, on this host
// "built" and "running" are genuinely independent: `localhost:4739` is usually the packaged
// Marquee.exe serving its *own bundled copy* of Curator, so a `git checkout` plus a `pnpm build` in
// the repo can complete perfectly and change nothing about what is actually serving.
//
// There is an exact check available, and it falls out of the bug that made this matter. Curator
// registers `@fastify/static` with `wildcard: false`, so it enumerates `dist-ui` once at startup;
// Vite renames every bundle on each build. That combination is why a Curator kept running across a
// UI build serves a stale UI (issue #183, which failed *silently* until it was made to 404). Turned
// around, it is a staleness oracle: ask the running server for `/` and compare the bundle it names
// with the bundle now on disk. Same name → it started after this build. Different name → it is
// serving the previous commit, whatever `git rev-parse HEAD` says.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { TIMEOUTS, type Executor } from "./exec.js";
import type { Host } from "./hosts.js";
import type { Reporter } from "./run.js";

/** The hashed entry bundle Vite writes into `index.html`, e.g. `/assets/index-D4f9Xa2b.js`. */
export function entryBundle(html: string): string | null {
  return html.match(/\/assets\/index-[A-Za-z0-9_-]+\.js/)?.[0] ?? null;
}

export type CuratorState =
  | { kind: "not-running" }
  | { kind: "fresh"; bundle: string }
  | { kind: "stale"; running: string | null; built: string }
  | { kind: "unknown"; why: string };

/**
 * Compare the freshly built `dist-ui` with what the running Curator is serving.
 *
 * Returns `unknown` rather than throwing when the comparison can't be made — a missing `dist-ui`
 * after a deploy that didn't build Curator is normal, and shouldn't read as a failure.
 */
export async function curatorState(
  host: Host,
  repoRoot: string,
  port: number,
  exec: Executor,
): Promise<CuratorState> {
  let built: string | null;
  try {
    const html = await readFile(
      join(repoRoot, "packages", "curator", "dist-ui", "index.html"),
      "utf8",
    );
    built = entryBundle(html);
  } catch {
    return {
      kind: "unknown",
      why: "no built dist-ui/index.html to compare against",
    };
  }
  if (!built) {
    return {
      kind: "unknown",
      why: "the built index.html names no /assets/index-*.js bundle",
    };
  }

  const res = await exec.exec(host, {
    argv: ["curl", "-s", "--max-time", "5", `http://127.0.0.1:${port}/`],
    timeoutMs: TIMEOUTS.probe,
    label: "fetch the running Curator's index",
    allowFailure: true,
  });
  // Nothing listening is not a failure: a deploy to a workstation with Curator closed is fine, and
  // the next launch picks up the new build on its own.
  if (res.code !== 0 || res.stdout.trim() === "")
    return { kind: "not-running" };

  const running = entryBundle(res.stdout);
  if (running === built) return { kind: "fresh", bundle: built };
  return { kind: "stale", running, built };
}

export class CuratorStaleError extends Error {}

/**
 * Report the workstation's Curator, and fail if it is demonstrably serving the previous build.
 *
 * This is a hard failure rather than a warning on purpose. The promise this deployer makes is that
 * on a zero exit every host is running the target commit; a Curator serving last week's bundle
 * breaks that promise, and it is the single failure the operator is most likely to shrug off,
 * because every other signal — `git rev-parse`, a green build, a 200 from `/healthz` — looks right.
 */
export async function reportCurator(
  host: Host,
  repoRoot: string,
  port: number,
  exec: Executor,
  report: Reporter,
): Promise<void> {
  const state = await curatorState(host, repoRoot, port, exec);

  switch (state.kind) {
    case "fresh":
      report.ok(host.name, `Curator is serving this build (${state.bundle})`);
      return;
    case "not-running":
      report.ok(
        host.name,
        "Curator is not running — the next launch picks up this build. Start it with `pnpm app`.",
      );
      return;
    case "unknown":
      report.warn(
        host.name,
        `could not verify what Curator is serving: ${state.why}`,
      );
      return;
    case "stale":
      throw new CuratorStaleError(
        `${host.name}: Curator on :${port} is serving ${state.running ?? "an unrecognised page"}, ` +
          `but this build produced ${state.built} — it is running the previous commit.\n\n` +
          `Restart it, then re-run this deploy:\n` +
          `  • Packaged app: quit Marquee.exe and relaunch it. Note that the installer bundles its ` +
          `own copy of Curator, so a relaunch only picks up this commit if you also rebuild and ` +
          `reinstall it — re-run with --desktop to build the installer.\n` +
          `  • From the repo: stop and restart \`pnpm curator\`.`,
      );
  }
}

/**
 * Build the Windows installer. Deliberately stops at the artifact: installing it runs an NSIS UI and
 * replaces the app the operator is using, which is their call to make, not a deploy step.
 */
export async function buildDesktopInstaller(
  host: Host,
  exec: Executor,
  report: Reporter,
): Promise<void> {
  report.step(host.name, "building the desktop installer (several minutes)");
  await exec.exec(host, {
    argv: ["pnpm", "--filter", "@marquee/desktop", "dist"],
    // Bundles two servers, rebuilds native deps and runs electron-builder; the slowest step here by
    // a wide margin, and still bounded.
    timeoutMs: 1_800_000,
    label: "build desktop installer",
  });
  report.ok(
    host.name,
    "installer built in packages/desktop/release/ — run it to update the packaged app " +
      "(unsigned, so SmartScreen will warn)",
  );
}
