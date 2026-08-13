// The deploy itself: preflight every host, then put one pinned commit on each in order and prove it
// landed.
//
// The guarantee this file exists to provide is narrow and worth stating exactly. On a zero exit,
// every host in the inventory has the target commit checked out, every out-of-tree asset matches the
// repo at that commit, and every service has been restarted *after* that checkout and is answering.
// On any other exit, it says which host and which step, and no later host was touched.
//
// Three properties do most of that work:
//
//   * **Preflight is total and mutates nothing.** Every host is checked — reachable, clean, units
//     present, sudo usable — before any host is written to. A typo in the Pi Zero's hostname fails
//     before the Pi 5 has restarted anything, instead of halfway through.
//   * **Restart is verified against the clock, not assumed.** No service reports its commit, so
//     "did it restart?" is answered by comparing the unit's ActiveEnterTimestamp with the moment the
//     checkout finished. A unit that was already running before the checkout is stale, and says so —
//     which is the whole of issue #201's failure mode, and the `systemctl status` that reads
//     `active (running)` over four-day-old code.
//   * **A unit rewrite is reversible.** Converging a systemd unit takes a backup first; if the
//     service then fails to come up, the previous unit is put back — restored from the backup, or
//     removed if this deploy is what created it — before the error is raised. A deploy that fails is
//     acceptable; a deploy that fails *and* leaves the stand dead is not.

import { createHash } from "node:crypto";
import {
  assetsFor,
  destFor,
  hostTakesAssets,
  render,
  type Asset,
} from "./assets.js";
import {
  buildOrder,
  effectsFor,
  fullEffects,
  isEmpty,
  noEffects,
  type Effects,
} from "./changes.js";
import { buildDesktopInstaller, reportCurator } from "./curator.js";
import {
  CommandFailed,
  shellQuote,
  TIMEOUTS,
  type Command,
  type Executor,
} from "./exec.js";
import {
  isLocal,
  SERVICE_PACKAGE,
  type Host,
  type ServiceId,
} from "./hosts.js";

export interface Reporter {
  /** A step about to run. */
  step(host: string, message: string): void;
  /** A step that succeeded, or a verified fact. */
  ok(host: string, message: string): void;
  /** Something the operator must act on that isn't fatal. */
  warn(host: string, message: string): void;
  /** Run-level narration. */
  info(message: string): void;
}

export interface DeployOptions {
  /** What the caller asked for (`origin/main`, a tag, a SHA) — reported, never re-resolved. */
  targetRef: string;
  /** The single commit every host will end up on. */
  targetSha: string;
  /** Skip the change analysis and do everything. */
  full: boolean;
  /** Plan and report without mutating any host. */
  dryRun: boolean;
  /** Proceed even if a host has local modifications. Off by default: they'd be silently discarded. */
  allowDirty: boolean;
  /** Also rebuild the desktop installer on the workstation. */
  desktop: boolean;
  /** Injectable for tests. */
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** Repo root on the machine running the deploy. Used for locally-built output, not for assets. */
  repoRoot: string;
  /**
   * One out-of-tree asset's content **as of the target commit** — not as of the working tree.
   *
   * The distinction is the whole correctness of asset convergence, and getting it wrong is not
   * theoretical: the first real deploy of this tool ran from a feature branch based on an older
   * commit while deploying `origin/main`. `marquee-stylus.service` had changed on main from
   * `Type=simple` to `Type=notify` with `WatchdogSec=30`, but the deployer compared the Pi's
   * installed unit against the *branch's* older copy, found them identical, and converged nothing.
   * The Pi ended up running the new code — which sends `READY=1`/`WATCHDOG=1` — under a unit that
   * arms no watchdog, so `sd_notify` silently no-opped and the "a wedged poll loop gets restarted"
   * fix was inert. Every check passed and the deploy reported success.
   *
   * Implemented as `git show <targetSha>:<path>`, so it depends on the commit and never on what the
   * deploying checkout happens to have.
   *
   * Returns **null** when the path doesn't exist at that commit, which is a normal state rather than
   * an error: the manifest describes assets this repo tracks *now*, and a rollback to a commit from
   * before one was tracked must not explode on it. An asset that didn't exist at the target commit
   * simply isn't managed at the target commit, and is left exactly as the host has it.
   */
  readAssetSource: (repoRelativePath: string) => Promise<string | null>;
}

export interface HostOutcome {
  host: string;
  previousSha: string | null;
  effects: Effects;
  /** Assets whose installed copy differed and was replaced. */
  convergedAssets: string[];
  warnings: string[];
  rebooted: boolean;
}

export interface DeployResult {
  targetSha: string;
  hosts: HostOutcome[];
  warnings: string[];
}

export class DeployError extends Error {}

const short = (sha: string) => sha.slice(0, 8);

/** Bounded poll. Never loops forever: `attempts` is the only exit besides success. */
async function waitFor<T>(
  what: string,
  attempts: number,
  delayMs: number,
  sleep: (ms: number) => Promise<void>,
  probe: () => Promise<T | null>,
): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await sleep(delayMs);
    try {
      const result = await probe();
      if (result !== null) return result;
      last = "not ready";
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
    }
  }
  throw new DeployError(
    `${what}: gave up after ${attempts} attempts over ~${Math.round((attempts * delayMs) / 1000)}s (${String(last)})`,
  );
}

// --- preflight -----------------------------------------------------------------------------------

export interface Preflight {
  host: Host;
  /** The commit the host is on right now, or null if it couldn't be determined. */
  currentSha: string | null;
  /** Paths changed between `currentSha` and the target, or null if the diff wasn't computable. */
  changed: string[] | null;
}

/**
 * Everything that can be checked without changing anything. Runs for every host before the first
 * mutation, so a misconfigured inventory costs nothing but time.
 */
export async function preflight(
  host: Host,
  exec: Executor,
  opts: DeployOptions,
  report: Reporter,
): Promise<Preflight> {
  const run = (cmd: Command) => exec.exec(host, cmd);
  report.step(host.name, "preflight");

  // Reachability and repo presence in one command: `git rev-parse` fails if the path isn't a repo.
  const head = await run({
    argv: ["git", "rev-parse", "HEAD"],
    timeoutMs: TIMEOUTS.probe,
    label: "read current commit",
    allowFailure: true,
  });
  if (head.code !== 0) {
    throw new DeployError(
      `${host.name}: no git checkout at ${host.repo} (or the host is unreachable)\n${head.stderr.trim()}`,
    );
  }
  const currentSha = head.stdout.trim();

  // A dirty tree is refused rather than stashed: `git checkout` would either fail or, for an
  // untracked file that collides, clobber it. Deploying is not the time to make that judgement.
  const status = await run({
    argv: ["git", "status", "--porcelain", "--untracked-files=no"],
    timeoutMs: TIMEOUTS.probe,
    label: "check for local modifications",
  });
  if (status.stdout.trim() !== "") {
    const files = status.stdout.trim().split("\n").slice(0, 10).join("\n");
    if (!opts.allowDirty) {
      throw new DeployError(
        `${host.name}: ${host.repo} has local modifications, which a checkout would discard:\n${files}\n` +
          `Commit or revert them on the host, or re-run with --allow-dirty to discard them.`,
      );
    }
    report.warn(
      host.name,
      `proceeding over local modifications (--allow-dirty):\n${files}`,
    );
  }

  // Fetch now, in preflight, so "the target commit doesn't exist on this host" is a preflight
  // failure rather than something discovered after two other hosts have already been restarted.
  //
  // This runs on a dry run too. A fetch writes remote-tracking refs and objects into .git; it does
  // not touch the working tree and it does not touch a running service, so it is inside what
  // "changes nothing that runs" promises. Skipping it made `--dry-run` actively misleading: without
  // the target commit present, the diff below cannot resolve, every host escalated to a full
  // deploy, and the printed plan was the pessimistic one rather than the real one.
  await run({
    argv: ["git", "fetch", "--quiet", "--tags", "origin"],
    timeoutMs: TIMEOUTS.git,
    label: "fetch",
  });
  const hasTarget = await run({
    argv: ["git", "cat-file", "-e", `${opts.targetSha}^{commit}`],
    timeoutMs: TIMEOUTS.probe,
    label: "check the target commit is present",
    allowFailure: true,
  });
  if (hasTarget.code !== 0) {
    throw new DeployError(
      `${host.name}: commit ${short(opts.targetSha)} is not on this host after a fetch — ` +
        `is it pushed to origin?`,
    );
  }

  // Units must exist under the names the inventory claims, before anything is restarted.
  for (const [id, svc] of Object.entries(host.services)) {
    if (!svc.unit) continue;
    const cat = await run({
      argv: ["systemctl", "cat", "--no-pager", `${svc.unit}.service`],
      timeoutMs: TIMEOUTS.probe,
      label: `check unit ${svc.unit}`,
      allowFailure: true,
    });
    if (cat.code !== 0) {
      throw new DeployError(
        `${host.name}: service "${id}" is configured as unit "${svc.unit}" but systemd has no such ` +
          `unit.\nList what it does have:\n` +
          `  ssh ${host.ssh} systemctl list-units --all 'marquee*' 'backdrop*' --no-pager`,
      );
    }
  }

  // Assets and restarts both need passwordless sudo; find out now rather than at the write.
  if (hostTakesAssets(host)) {
    const sudo = await run({
      argv: ["sudo", "-n", "true"],
      timeoutMs: TIMEOUTS.probe,
      label: "check passwordless sudo",
      allowFailure: true,
    });
    if (sudo.code !== 0) {
      throw new DeployError(
        `${host.name}: needs passwordless sudo to install units and restart services, but ` +
          `\`sudo -n true\` failed. Raspberry Pi OS grants this to the default user by default; ` +
          `check /etc/sudoers.d for this host.`,
      );
    }
  }

  const changed = await diffPaths(host, exec, currentSha, opts);
  report.ok(
    host.name,
    `preflight OK — on ${short(currentSha)}` +
      (changed === null
        ? // Say so rather than silently producing a full plan: an unrelated history or a shallow
          // clone is worth knowing about, and otherwise "deploying everything" looks like a rule
          // that misfired instead of a deliberate escalation.
          `, but cannot diff it against ${short(opts.targetSha)} — deploying in full`
        : `, ${changed.length} path(s) differ from target`),
  );
  return { host, currentSha, changed };
}

/**
 * Paths differing between the host's commit and the target, or null when that can't be answered —
 * an unrelated history, a shallow clone, or a first deploy. Null escalates to a full deploy.
 */
async function diffPaths(
  host: Host,
  exec: Executor,
  currentSha: string,
  opts: DeployOptions,
): Promise<string[] | null> {
  if (currentSha === opts.targetSha) return [];
  const diff = await exec.exec(host, {
    argv: ["git", "diff", "--name-only", currentSha, opts.targetSha],
    timeoutMs: TIMEOUTS.probe,
    label: "diff against target",
    allowFailure: true,
  });
  if (diff.code !== 0) return null;
  return diff.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

/** The work `host` needs, given the preflight diff and the run options. */
export function effectsForHost(pre: Preflight, opts: DeployOptions): Effects {
  const all =
    opts.full || pre.changed === null ? fullEffects() : effectsFor(pre.changed);
  return restrictToHost(all, pre.host);
}

/** Drop the parts of a change set that belong to services this host doesn't run. */
export function restrictToHost(effects: Effects, host: Host): Effects {
  const runs = (id: ServiceId) => host.services[id] !== undefined;
  const build = new Set([...effects.build].filter(runs));
  const restart = new Set([...effects.restart].filter(runs));
  return {
    // An install is only needed where something will be built from the workspace.
    pnpmInstall: effects.pnpmInstall && build.size > 0,
    build,
    restart,
    pipInstall: effects.pipInstall && runs("stylus"),
    kioskReload: effects.kioskReload && host.kiosk === true,
    assets: effects.assets && hostTakesAssets(host),
    unrecognized: effects.unrecognized,
  };
}

// --- per-host deploy -----------------------------------------------------------------------------

export async function deployHost(
  pre: Preflight,
  effects: Effects,
  exec: Executor,
  opts: DeployOptions,
  report: Reporter,
): Promise<HostOutcome> {
  const host = pre.host;
  const run = (cmd: Command) => exec.exec(host, cmd);
  const outcome: HostOutcome = {
    host: host.name,
    previousSha: pre.currentSha,
    effects,
    convergedAssets: [],
    warnings: [],
    rebooted: false,
  };

  if (isEmpty(effects) && pre.currentSha === opts.targetSha) {
    report.ok(host.name, `already on ${short(opts.targetSha)}, nothing to do`);
    return outcome;
  }

  if (opts.dryRun) {
    report.info(
      `${host.name}: would ${describeEffects(effects) || "check out the target commit only"}`,
    );
    return outcome;
  }

  // --- check out the pinned commit --------------------------------------------------------------
  // Detached on purpose. The host is pinned to a commit, not tracking a branch, and `git status`
  // saying so is the honest report — a local branch quietly fast-forwarded to a SHA that isn't its
  // upstream's tip looks identical to one that is. `git switch main` puts it back.
  report.step(host.name, `checkout ${short(opts.targetSha)}`);
  await run({
    argv: ["git", "checkout", "--detach", "--force", opts.targetSha],
    timeoutMs: TIMEOUTS.git,
    label: "checkout target commit",
  });
  // Everything after this must have happened *after* this instant to count as fresh.
  const checkoutAt = await hostClock(host, exec, opts);

  // --- dependencies and builds ------------------------------------------------------------------
  if (effects.pnpmInstall) {
    report.step(host.name, "pnpm install");
    await run({
      // Frozen: the lockfile is committed, so a deploy that would have to change it is a deploy
      // against a tree that doesn't match what was tested.
      argv: ["pnpm", "install", "--frozen-lockfile"],
      timeoutMs: TIMEOUTS.install,
      label: "pnpm install",
    });
  }

  for (const id of buildOrder(effects.build)) {
    report.step(host.name, `build ${id}`);
    await run({
      argv: ["pnpm", "--filter", SERVICE_PACKAGE[id], "build"],
      timeoutMs: TIMEOUTS.build,
      label: `build ${id}`,
    });
  }

  // The packaged app bundles its own copy of Curator, so on a workstation that runs Marquee.exe the
  // repo build above is not what will serve :4739 — rebuilding the installer is the actual deploy.
  if (opts.desktop && host.services.curator) {
    await buildDesktopInstaller(host, exec, report);
  }

  if (effects.pipInstall) {
    // Not optional, and not `-e`: site-packages holds a copy, so this is the only step that makes
    // the checkout and the running code the same thing (issue #201). Verified below by diff.
    report.step(host.name, "pip install stylus");
    await run({
      argv: [".venv/bin/pip", "install", "--no-deps", "--quiet", "."],
      cwd: `${host.repo}/packages/stylus`,
      timeoutMs: TIMEOUTS.pip,
      label: "pip install stylus",
    });
  }

  // --- out-of-tree assets ------------------------------------------------------------------------
  let unitsChanged = false;
  const backups = new Map<string, Converged>();
  if (effects.assets) {
    for (const asset of assetsFor(host)) {
      const converged = await convergeAsset(asset, host, exec, opts, report);
      if (!converged) continue;
      outcome.convergedAssets.push(asset.id);
      if (asset.kind === "unit") {
        unitsChanged = true;
        backups.set(asset.id, converged);
      }
    }
    if (unitsChanged) {
      await run({
        argv: ["sudo", "systemctl", "daemon-reload"],
        timeoutMs: TIMEOUTS.restart,
        label: "systemctl daemon-reload",
      });
    }
  }

  // --- restarts ----------------------------------------------------------------------------------
  for (const id of effects.restart) {
    const unit = host.services[id]?.unit;
    if (!unit) continue; // Curator: no unit, handled by the workstation step below.
    report.step(host.name, `restart ${unit}`);
    try {
      await run({
        argv: ["sudo", "systemctl", "restart", `${unit}.service`],
        timeoutMs: TIMEOUTS.restart,
        label: `restart ${unit}`,
      });
      await assertActive(host, unit, exec, opts);
      // Inside the try, not after it. A unit that comes up but reports a start time older than the
      // checkout is still a failed restart — and if we just rewrote that unit, it is a failed
      // restart on a *new unit file*, which is precisely the case rollback exists for. Leaving this
      // outside meant the one failure mode most likely to be caused by a bad rewrite was the one
      // that skipped the revert.
      await assertRestartedAfter(host, unit, checkoutAt, exec, opts, report);
    } catch (err) {
      // A unit we just rewrote is the most likely reason a restart fails. Put the old one back and
      // get the service running again before reporting — a failed deploy should not also be an
      // outage.
      if (backups.size > 0) {
        await rollbackUnits(host, backups, exec, report);
      }
      throw err;
    }
  }

  // --- the kiosk ---------------------------------------------------------------------------------
  if (effects.kioskReload) {
    // Chromium holds the SPA in memory and the autostart entry only runs at session start, so there
    // is no lighter reliable reload: killing the browser leaves a black screen with nothing to
    // restart it. This is the runbook's `sudo reboot`, made to wait and verify.
    report.step(host.name, "reboot for the kiosk");
    await run({
      argv: ["sudo", "systemctl", "reboot"],
      timeoutMs: TIMEOUTS.reboot,
      label: "reboot",
      // The connection dies with the host; a non-zero exit here is expected, not a failure.
      allowFailure: true,
    });
    outcome.rebooted = true;
    await waitForHost(host, exec, opts, report);
  }

  // --- verification ------------------------------------------------------------------------------
  await verifyHost(host, effects, checkoutAt, exec, opts, report, outcome);
  return outcome;
}

/** The host's own clock, so timestamps are compared within one clock rather than across two. */
async function hostClock(
  host: Host,
  exec: Executor,
  opts: DeployOptions,
): Promise<number> {
  if (isLocal(host)) return opts.now();
  const res = await exec.exec(host, {
    argv: ["date", "+%s"],
    timeoutMs: TIMEOUTS.probe,
    label: "read host clock",
    allowFailure: true,
  });
  const seconds = Number(res.stdout.trim());
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : opts.now();
}

async function assertActive(
  host: Host,
  unit: string,
  exec: Executor,
  opts: DeployOptions,
): Promise<void> {
  await waitFor(
    `${host.name}: ${unit} did not reach active`,
    10,
    1000,
    opts.sleep,
    async () => {
      const res = await exec.exec(host, {
        argv: ["systemctl", "is-active", `${unit}.service`],
        timeoutMs: TIMEOUTS.probe,
        label: `is-active ${unit}`,
        allowFailure: true,
      });
      return res.stdout.trim() === "active" ? true : null;
    },
  );
}

/**
 * The check that distinguishes "restarted" from "restarted the new code": a unit whose current run
 * began before the checkout is running the previous commit, however healthy it looks.
 */
async function assertRestartedAfter(
  host: Host,
  unit: string,
  checkoutAt: number,
  exec: Executor,
  opts: DeployOptions,
  report: Reporter,
): Promise<void> {
  // systemd prints `Wed 2026-08-13 07:35:12 BST`, which JavaScript's Date.parse reads inconsistently
  // and, for a named timezone, usually not at all. Hand it to the host's own `date` instead: the
  // answer comes back as an epoch, in the same clock domain as `hostClock`, with no parsing here.
  const res = await exec.exec(host, {
    argv: [
      "sh",
      "-c",
      // The unit name goes through a shell variable rather than being interpolated into the script
      // text, so it is quoted exactly once and the rest of the line can't be re-read as syntax.
      // Same discipline as `toRemoteScript`; this call site needs a real shell only for the `$(…)`.
      `u=${shellQuote(unit)}; date -d "$(systemctl show --property=ActiveEnterTimestamp --value "$u".service)" +%s`,
    ],
    timeoutMs: TIMEOUTS.probe,
    label: `restart time of ${unit}`,
    allowFailure: true,
  });
  const seconds = Number(res.stdout.trim());
  if (res.code !== 0 || !Number.isFinite(seconds) || seconds <= 0) {
    // A unit that has never activated reports an empty timestamp, which `date` rejects. Warn rather
    // than fail: `assertActive` has already established the unit is running, and a deployer that
    // refuses to finish over a missing timestamp is worse than one that says it couldn't check.
    report.warn(
      host.name,
      `could not read ${unit}'s start time, so the restart was not independently verified`,
    );
    return;
  }
  const startedAt = seconds * 1000;
  // Two seconds of slack: the timestamp has second resolution and the two readings are separate
  // round trips, so an exact comparison would flag a genuinely fresh restart about half the time.
  if (startedAt + 2000 < checkoutAt) {
    throw new DeployError(
      `${host.name}: ${unit} has been running since ${new Date(startedAt).toISOString()}, which is ` +
        `before this deploy checked out ${short(opts.targetSha)} — it is serving the previous ` +
        `commit. The restart did not take.`,
    );
  }
}

async function waitForHost(
  host: Host,
  exec: Executor,
  opts: DeployOptions,
  report: Reporter,
): Promise<void> {
  report.step(host.name, "waiting for the host to come back");
  // A Pi 5 reboots in well under a minute; five gives room for a fsck without waiting forever.
  await waitFor(
    `${host.name} did not come back after the reboot`,
    60,
    5000,
    opts.sleep,
    async () => {
      const res = await exec.exec(host, {
        argv: ["true"],
        timeoutMs: TIMEOUTS.probe,
        label: "ping host",
        allowFailure: true,
      });
      return res.code === 0 ? true : null;
    },
  );
  report.ok(host.name, "back up");
}

// --- assets ---------------------------------------------------------------------------------------

interface Converged {
  /**
   * Where the previous copy was saved, or null if there wasn't one.
   *
   * Null is reachable even though preflight proves the unit exists: `systemctl cat` finds a unit
   * anywhere on the unit path, including `/lib/systemd/system`, while this deployer always writes
   * the `/etc/systemd/system` override. Rolling back a file that had no previous version means
   * *removing* it, not restoring nothing — otherwise a failed restart leaves the broken new unit
   * shadowing the working packaged one.
   */
  backupPath: string | null;
  dest: string;
}

/**
 * Bring one asset's installed copy in line with the repo. Returns null when it already matched —
 * the common case, and the one that must be silent enough to leave the interesting output visible.
 */
async function convergeAsset(
  asset: Asset,
  host: Host,
  exec: Executor,
  opts: DeployOptions,
  report: Reporter,
): Promise<Converged | null> {
  const dest = destFor(asset, host);
  // From the target commit, never from the working tree — see `readAssetSource`.
  const source = await opts.readAssetSource(asset.source);
  if (source === null) {
    // Not tracked at this commit. Leave the host's copy alone and say so — silently skipping would
    // let a rollback quietly stop managing a file the operator believes is being converged.
    report.warn(
      host.name,
      `${asset.source} does not exist at ${short(opts.targetSha)}, so ${dest} is left as-is ` +
        `(it is not managed at that commit)`,
    );
    return null;
  }
  const wanted = render(source, host);
  const wantedHash = sha256(wanted);

  const current = await exec.exec(host, {
    argv: ["sha256sum", "--", dest],
    timeoutMs: TIMEOUTS.probe,
    label: `hash ${dest}`,
    allowFailure: true,
  });
  const currentHash =
    current.code === 0 ? current.stdout.trim().split(/\s+/)[0] : null;

  if (currentHash === wantedHash) return null;

  report.step(
    host.name,
    currentHash === null
      ? `install ${dest} (missing) — ${asset.why}`
      : `update ${dest} (differs from repo) — ${asset.why}`,
  );

  const sudo = asset.kind === "unit";
  const backupPath =
    currentHash === null ? null : `${dest}.bak-${short(opts.targetSha)}`;
  if (backupPath !== null) {
    await exec.exec(host, {
      argv: [...(sudo ? ["sudo"] : []), "cp", "-p", "--", dest, backupPath],
      timeoutMs: TIMEOUTS.file,
      label: `back up ${dest}`,
    });
  }

  // `tee` rather than a redirect: the redirect is performed by the *calling* shell, which for a
  // sudo-owned path is the unprivileged one, so `sudo echo > /etc/...` fails on permission while
  // looking like it should work.
  await exec.exec(host, {
    argv: [
      ...(sudo ? ["sudo"] : []),
      "install",
      "-D",
      "-m",
      asset.mode,
      "/dev/stdin",
      dest,
    ],
    timeoutMs: TIMEOUTS.file,
    label: `write ${dest}`,
    stdin: wanted,
  });

  return { backupPath, dest };
}

async function rollbackUnits(
  host: Host,
  backups: Map<string, Converged>,
  exec: Executor,
  report: Reporter,
): Promise<void> {
  report.warn(host.name, "restart failed — restoring the previous unit files");
  for (const [id, { backupPath, dest }] of backups) {
    await exec.exec(host, {
      // No backup means this deploy *created* the file — most likely an /etc override shadowing a
      // unit that ships elsewhere on the unit path. Undoing that is a removal; restoring nothing
      // would leave the broken new unit winning.
      argv: backupPath
        ? ["sudo", "cp", "-p", "--", backupPath, dest]
        : ["sudo", "rm", "-f", "--", dest],
      timeoutMs: TIMEOUTS.file,
      label: backupPath
        ? `restore ${id}`
        : `remove the ${id} file this deploy created`,
      allowFailure: true,
    });
  }
  await exec.exec(host, {
    argv: ["sudo", "systemctl", "daemon-reload"],
    timeoutMs: TIMEOUTS.restart,
    label: "daemon-reload after rollback",
    allowFailure: true,
  });
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

// --- verification -----------------------------------------------------------------------------------

async function verifyHost(
  host: Host,
  effects: Effects,
  checkoutAt: number,
  exec: Executor,
  opts: DeployOptions,
  report: Reporter,
  outcome: HostOutcome,
): Promise<void> {
  const run = (cmd: Command) => exec.exec(host, cmd);

  // 1. The checkout is what we asked for.
  const head = await run({
    argv: ["git", "rev-parse", "HEAD"],
    timeoutMs: TIMEOUTS.probe,
    label: "verify commit",
  });
  const landed = head.stdout.trim();
  if (landed !== opts.targetSha) {
    throw new DeployError(
      `${host.name}: expected ${short(opts.targetSha)} after deploy but the checkout is ${short(landed)}`,
    );
  }
  report.ok(host.name, `on ${short(opts.targetSha)}`);

  // 2. Stylus's installed copy is the checkout. The runbook's `diff -rq`, which is the only thing
  //    that tells "restarted" apart from "restarted the new code" for a non-editable install.
  if (host.services.stylus) {
    const diff = await run({
      argv: [
        "sh",
        "-c",
        // The repo path goes through a shell variable, quoted once, so a path containing a space
        // can't word-split the comparison into two wrong paths — which would fail the diff and
        // surface as the very misleading "running stale code" error below.
        //
        // A real shell is unavoidable here: `python*` has to glob, because the venv's directory
        // carries the interpreter's minor version (python3.13 today). That glob is the one thing
        // deliberately left outside the quotes.
        `d=${shellQuote(host.repo)}; ` +
          `diff -rq -x __pycache__ "$d/packages/stylus/stylus/" ` +
          `"$d"/packages/stylus/.venv/lib/python*/site-packages/stylus/`,
      ],
      timeoutMs: TIMEOUTS.probe,
      label: "verify the installed Stylus copy",
      allowFailure: true,
    });
    if (diff.code !== 0 || diff.stdout.trim() !== "") {
      throw new DeployError(
        `${host.name}: the installed Stylus copy differs from the checkout — the service is running ` +
          `stale code (issue #201):\n${diff.stdout.trim() || diff.stderr.trim()}`,
      );
    }
    report.ok(host.name, "installed Stylus copy matches the checkout");
  }

  // 3. Every unit is active, and — where it was restarted — was restarted after the checkout.
  for (const [id, svc] of Object.entries(host.services)) {
    if (!svc.unit) continue;
    await assertActive(host, svc.unit, exec, opts);
    if (effects.restart.has(id as ServiceId) || outcome.rebooted) {
      await assertRestartedAfter(
        host,
        svc.unit,
        checkoutAt,
        exec,
        opts,
        report,
      );
    }
    report.ok(host.name, `${svc.unit} active`);
  }

  // 4. Health, over loopback *on the host*. Deliberately not from the workstation: the runbook is
  //    explicit that mDNS resolves for ssh from Windows but not reliably for curl/undici, so a
  //    check run from here would fail for reasons that have nothing to do with the deploy.
  for (const [id, svc] of Object.entries(host.services)) {
    // Curator has no unit and no /healthz worth polling for this purpose — what matters is whether
    // the *running* process is serving this build, which needs a different question entirely.
    if (id === "curator") {
      await reportCurator(host, opts.repoRoot, svc.port, exec, report);
      continue;
    }
    // Backdrop's 503 is "backend up, no browser attached" — which is the *normal* state for up to a
    // minute after a reboot, while Chromium starts and opens its WebSocket back. Treat it as
    // not-ready and keep polling rather than as a verdict.
    //
    // Reported as a verdict on the first probe, this warning fired on every kiosk reboot with the
    // TV coming up perfectly seconds later. A warning that is usually wrong trains you to ignore
    // the one time it isn't — and this is the one signal that can see a crashed Chromium at all,
    // since `systemctl status` cannot.
    const kioskStarting = id === "backdrop" && outcome.rebooted;
    let lastCode = "";

    const probe = async (): Promise<string | null> => {
      const res = await run({
        argv: [
          "curl",
          "-s",
          "-o",
          "/dev/null",
          "-w",
          "%{http_code}",
          "--max-time",
          "5",
          `http://127.0.0.1:${svc.port}/healthz`,
        ],
        timeoutMs: TIMEOUTS.probe,
        label: `health check ${id}`,
        allowFailure: true,
      });
      const code = res.stdout.trim();
      if (code === "000" || code === "") return null;
      lastCode = code;
      if (id === "backdrop" && code === "503") return null;
      return code;
    };

    // A rebooted kiosk gets a longer budget than a plain restart: Chromium has to come up, load the
    // SPA and connect, which is comfortably longer than a service bind.
    const attempts = kioskStarting ? 48 : 12;
    let status: string;
    try {
      status = await waitFor(
        `${host.name}: ${id} /healthz never answered`,
        attempts,
        2500,
        opts.sleep,
        probe,
      );
    } catch (err) {
      // Exhausting the budget having *only* ever seen Backdrop's 503 is the real "the kiosk did not
      // come back" case, and is the warning below rather than a failure. Anything else — nothing
      // answered at all — is a genuine failure.
      if (lastCode === "") throw err;
      status = lastCode;
    }

    if (status === "200") {
      report.ok(host.name, `${id} healthy (200)`);
      continue;
    }
    // Still 503 after the full budget: the backend is fine and the browser genuinely never attached.
    // Non-fatal, because nothing on the Pi is broken — but the TV is showing nothing, and that is
    // invisible from `systemctl status`.
    if (id === "backdrop" && status === "503") {
      const message =
        "Backdrop is up but no browser is attached (/healthz 503) — the TV is showing nothing. " +
        "Check the kiosk: `ssh " +
        host.ssh +
        " cat /tmp/kiosk.log`, or reboot the Pi.";
      report.warn(host.name, message);
      outcome.warnings.push(message);
      continue;
    }
    throw new DeployError(
      `${host.name}: ${id} /healthz returned ${status}, expected 200`,
    );
  }
}

/** One line describing what a change set will do, for dry runs and the summary. */
export function describeEffects(e: Effects): string {
  const parts: string[] = [];
  if (e.pnpmInstall) parts.push("pnpm install");
  if (e.build.size) parts.push(`build ${[...e.build].join(", ")}`);
  if (e.pipInstall) parts.push("pip install stylus");
  if (e.assets) parts.push("converge assets");
  if (e.restart.size) parts.push(`restart ${[...e.restart].join(", ")}`);
  if (e.kioskReload) parts.push("reboot for the kiosk");
  return parts.join("; ");
}

// --- the run -----------------------------------------------------------------------------------------

export async function deploy(
  hosts: Host[],
  exec: Executor,
  opts: DeployOptions,
  report: Reporter,
): Promise<DeployResult> {
  report.info(
    `Deploying ${short(opts.targetSha)} (${opts.targetRef}) to: ${hosts.map((h) => h.name).join(", ")}`,
  );

  // Total preflight before any mutation — see the note at the top of this file.
  const preflights: Preflight[] = [];
  for (const host of hosts) {
    preflights.push(await preflight(host, exec, opts, report));
  }

  const unrecognized = new Set<string>();
  for (const pre of preflights) {
    for (const path of effectsForHost(pre, opts).unrecognized)
      unrecognized.add(path);
  }
  if (unrecognized.size > 0) {
    report.warn(
      "plan",
      `these changed paths match no rule, so every host is being deployed in full:\n  ` +
        [...unrecognized].slice(0, 20).join("\n  ") +
        `\nAdd a rule for them in packages/deploy/src/changes.ts.`,
    );
  }

  const outcomes: HostOutcome[] = [];
  for (const pre of preflights) {
    const effects = effectsForHost(pre, opts);
    outcomes.push(await deployHost(pre, effects, exec, opts, report));
  }

  return {
    targetSha: opts.targetSha,
    hosts: outcomes,
    warnings: outcomes.flatMap((o) => o.warnings),
  };
}

export { noEffects };
export type { Effects };
export { CommandFailed };
