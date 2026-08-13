#!/usr/bin/env node
// `pnpm run deploy` — resolve one commit, put it on every host, prove it landed.
//
// Output carries no colour. State is in the words and the markers, never in a hue: this repo's
// operator is colour-blind, and a red/green terminal convention is exactly the kind of thing that
// reads as "fine" to the wrong pair of eyes.

import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { CuratorStaleError } from "./curator.js";
import {
  CommandFailed,
  RealExecutor,
  TIMEOUTS,
  type Executor,
} from "./exec.js";
import { parseConfig, ConfigError, type Host } from "./hosts.js";
import {
  deploy,
  describeEffects,
  DeployError,
  type DeployOptions,
  type Reporter,
} from "./run.js";

const USAGE = `
marquee-deploy — put one commit on every Marquee host, and verify it.

  pnpm run deploy [options]

Options:
  --ref <ref>        What to deploy. Default: origin/main. Accepts a branch, tag or SHA —
                     resolved to a single commit once, then used verbatim on every host.
                     Roll back with --ref <old-sha>.
  --only <names>     Comma-separated host names from the inventory (e.g. --only pi5,pizero).
  --full             Skip the change analysis; rebuild and restart everything.
  --dry-run          Preflight and print the plan. Changes nothing that runs — it does
                     fetch on each host, so the plan is the real one rather than a guess.
  --desktop          Also rebuild the Windows installer (packages/desktop/release/).
  --allow-dirty      Proceed even if a host has local modifications. They will be discarded.
  --hosts <path>     Inventory file. Default: packages/deploy/hosts.json
                     (copy hosts.example.json to create it).
  -h, --help         This.

Deploy order is Pis first, workstation second, and is not configurable: Curator is the only
service that pushes, so a runtime that is behind is recoverable and one that is ahead is not.
`.trim();

interface Args {
  ref: string;
  only: string[] | null;
  full: boolean;
  dryRun: boolean;
  desktop: boolean;
  allowDirty: boolean;
  hosts: string | null;
  help: boolean;
}

export function parseArgs(argv: readonly string[]): Args {
  const args: Args = {
    ref: "origin/main",
    only: null,
    full: false,
    dryRun: false,
    desktop: false,
    allowDirty: false,
    hosts: null,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined) throw new ConfigError(`${arg} needs a value`);
      return v;
    };
    switch (arg) {
      case "--ref":
        args.ref = value();
        break;
      case "--only":
        args.only = value()
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        break;
      case "--hosts":
        args.hosts = value();
        break;
      case "--full":
        args.full = true;
        break;
      case "--dry-run":
        args.dryRun = true;
        break;
      case "--desktop":
        args.desktop = true;
        break;
      case "--allow-dirty":
        args.allowDirty = true;
        break;
      case "-h":
      case "--help":
        args.help = true;
        break;
      default:
        throw new ConfigError(`unknown option "${arg}"\n\n${USAGE}`);
    }
  }
  return args;
}

/** Markers are text, not colour. `!` never appears on a line that isn't asking for attention. */
const reporter: Reporter = {
  info: (m) => console.log(`\n${m}`),
  step: (host, m) => console.log(`  → [${host}] ${m}`),
  ok: (host, m) => console.log(`  ✓ [${host}] ${m}`),
  warn: (host, m) => console.log(`  ! [${host}] WARNING: ${m}`),
};

/** Run a command in the repo on this machine — used to resolve the target before any host is touched. */
async function local(
  exec: Executor,
  repoRoot: string,
  argv: string[],
  label: string,
) {
  const self: Host = {
    name: "local",
    repo: repoRoot,
    services: {},
    user: "local",
    home: repoRoot,
  };
  return exec.exec(self, {
    argv,
    timeoutMs: TIMEOUTS.git,
    label,
    cwd: repoRoot,
  });
}

export async function main(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(USAGE);
    return 0;
  }

  const exec = new RealExecutor();

  const root = await local(
    exec,
    process.cwd(),
    ["git", "rev-parse", "--show-toplevel"],
    "find repo root",
  );
  const repoRoot = resolve(root.stdout.trim());

  const hostsPath = args.hosts
    ? resolve(args.hosts)
    : join(repoRoot, "packages", "deploy", "hosts.json");

  let hosts: Host[];
  try {
    hosts = parseConfig(JSON.parse(await readFile(hostsPath, "utf8")));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      console.error(
        `No deploy inventory at ${hostsPath}.\n\n` +
          `Create one by copying the example and filling in your hosts:\n` +
          `  cp packages/deploy/hosts.example.json packages/deploy/hosts.json\n\n` +
          `It is gitignored, like the config.toml files it sits alongside.`,
      );
      return 1;
    }
    throw err;
  }

  if (args.only) {
    const known = new Set(hosts.map((h) => h.name));
    const unknown = args.only.filter((n) => !known.has(n));
    if (unknown.length > 0) {
      console.error(
        `--only names host(s) not in ${hostsPath}: ${unknown.join(", ")}\n` +
          `Known hosts: ${[...known].join(", ")}`,
      );
      return 1;
    }
    hosts = hosts.filter((h) => args.only!.includes(h.name));
  }

  // Resolve the ref exactly once. Everything downstream uses the SHA, so a push landing mid-deploy
  // cannot leave two hosts on different commits — which is the whole point of the exercise.
  await local(
    exec,
    repoRoot,
    ["git", "fetch", "--quiet", "--tags", "origin"],
    "fetch",
  );
  const resolved = await local(
    exec,
    repoRoot,
    ["git", "rev-parse", `${args.ref}^{commit}`],
    `resolve ${args.ref}`,
  );
  const targetSha = resolved.stdout.trim();

  const options: DeployOptions = {
    targetRef: args.ref,
    targetSha,
    full: args.full,
    dryRun: args.dryRun,
    allowDirty: args.allowDirty,
    desktop: args.desktop,
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    repoRoot,
    // From the commit, not the checkout. Deploying `origin/main` while sitting on a feature branch
    // is the normal case, and reading assets off the working tree there installs the *branch's*
    // copy — which is how a Pi came to run new code under an old systemd unit.
    readAssetSource: async (path) => {
      const res = await exec.exec(
        {
          name: "local",
          repo: repoRoot,
          services: {},
          user: "local",
          home: repoRoot,
        },
        {
          argv: ["git", "show", `${targetSha}:${path}`],
          cwd: repoRoot,
          timeoutMs: TIMEOUTS.probe,
          label: `read ${path} at ${targetSha.slice(0, 8)}`,
          // A path absent at the target commit is data, not a failure — see `readAssetSource`.
          allowFailure: true,
        },
      );
      return res.code === 0 ? res.stdout : null;
    },
  };

  const result = await deploy(hosts, exec, options, reporter);

  console.log(
    args.dryRun
      ? `\nDry run — nothing that runs was changed (each host fetched). Target ${targetSha.slice(0, 8)} (${args.ref}).`
      : `\nDeployed ${targetSha.slice(0, 8)} (${args.ref}).`,
  );
  for (const host of result.hosts) {
    const did = describeEffects(host.effects);
    // "no change" is only true if the host was already on the target. A host with nothing to build
    // or restart still moves to the target commit, and saying "no change" there contradicts the
    // per-host line printed above it.
    const moved = host.previousSha !== null && host.previousSha !== targetSha;
    console.log(
      `  ${host.host}: ${did || (moved ? "check out the target commit only" : "already on the target, nothing to do")}`,
    );
    for (const asset of host.convergedAssets) {
      console.log(`    installed asset: ${asset}`);
    }
  }
  if (result.warnings.length > 0) {
    console.log(`\n${result.warnings.length} warning(s) need attention:`);
    for (const w of result.warnings) console.log(`  ! ${w}`);
  }
  return 0;
}

const isEntry =
  process.argv[1] !== undefined &&
  import.meta.url ===
    new URL(`file://${process.argv[1].replace(/\\/g, "/")}`).href;

if (isEntry) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err: unknown) => {
      // Expected, actionable failures print their message and nothing else. Anything unexpected
      // keeps its stack, because that one is a bug in the deployer rather than in the deployment.
      // CommandFailed is in this list because it is the *most* common real failure — a `tsc` error
      // on the Pi, a unit that won't start — and it already carries the command and the tail of the
      // output. Printing a Node stack above that buries the one part the operator needs.
      const expected =
        err instanceof DeployError ||
        err instanceof ConfigError ||
        err instanceof CuratorStaleError ||
        err instanceof CommandFailed;
      console.error(
        `\nDEPLOY FAILED\n\n${expected ? (err as Error).message : String((err as Error).stack ?? err)}`,
      );
      process.exit(1);
    });
}
