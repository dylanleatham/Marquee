// What a set of changed files actually requires — docs/runbook.md's "What actually needs what"
// table, encoded so it is applied by a machine instead of remembered by a person.
//
// The table exists because restarting the wrong thing is the usual reason an update "didn't take".
// Every entry here is a rule the runbook already states in prose; the value of having it as code is
// that the fan-out cases (a `packages/contracts` edit reaching three services that have no source
// change of their own) are applied every time rather than when you remember the warning.
//
// The important design property is the fallback: a path matching **no** rule escalates to a full
// deploy of every host, and says which path did it. A new package, a renamed directory, or a file
// nobody anticipated therefore over-builds rather than silently skipping a service. Getting a rule
// wrong costs a rebuild; having no rule at all used to cost a stale runtime that looks healthy.

import { NODE_PI_SERVICES, type ServiceId } from "./hosts.js";

export interface Effects {
  /** `pnpm install` is required before any build (a dependency or the lockfile moved). */
  pnpmInstall: boolean;
  /** Services needing `pnpm --filter <pkg> build`. */
  build: Set<ServiceId>;
  /** Services needing a `systemctl restart` (or, for Curator, a process restart). */
  restart: Set<ServiceId>;
  /** Stylus needs `.venv/bin/pip install --no-deps .` — site-packages holds a *copy* (issue #201). */
  pipInstall: boolean;
  /** The Chromium kiosk needs its page reloaded; `git pull` alone leaves the old copy in memory. */
  kioskReload: boolean;
  /** Out-of-tree assets (`~/kiosk.sh`, autostart entries, unit files) need re-converging. */
  assets: boolean;
  /** Paths that matched no rule and so forced a full deploy. Empty on a normal run. */
  unrecognized: string[];
}

export function noEffects(): Effects {
  return {
    pnpmInstall: false,
    build: new Set(),
    restart: new Set(),
    pipInstall: false,
    kioskReload: false,
    assets: false,
    unrecognized: [],
  };
}

/** Everything, for every host — the escalation target and what `--full` produces. */
export function fullEffects(): Effects {
  return {
    pnpmInstall: true,
    build: new Set<ServiceId>([...NODE_PI_SERVICES, "curator"]),
    restart: new Set<ServiceId>([...NODE_PI_SERVICES, "curator", "stylus"]),
    pipInstall: true,
    kioskReload: true,
    assets: true,
    unrecognized: [],
  };
}

export function isEmpty(e: Effects): boolean {
  return (
    !e.pnpmInstall &&
    e.build.size === 0 &&
    e.restart.size === 0 &&
    !e.pipInstall &&
    !e.kioskReload &&
    !e.assets
  );
}

type Outcome = "ignore" | "full" | Partial<Effects>;

interface Rule {
  readonly test: RegExp;
  readonly why: string;
  readonly outcome: Outcome;
}

const buildAndRestart = (...ids: ServiceId[]): Partial<Effects> => ({
  build: new Set(ids),
  restart: new Set(ids),
});

/**
 * Ordered — **first match wins**, so the specific rules precede the general ones. Paths are
 * repo-relative and always use forward slashes (git's output format, on Windows too).
 */
export const RULES: readonly Rule[] = [
  // --- things that change nothing that runs ----------------------------------------------------
  // Checked first so a DEPLOY.md edit inside a service package doesn't trip that package's rule.
  {
    test: /(^|\/)[^/]+\.md$/,
    why: "documentation",
    outcome: "ignore",
  },
  {
    test: /^(docs|\.github|review-agents|spikes|flipper|fixtures|e2e|contract-tests)\//,
    why: "docs, CI config, and tooling that never runs on a device",
    outcome: "ignore",
  },
  {
    test: /^packages\/(fakes|deploy)\//,
    why: "test doubles and this deployer itself — neither ships to a host",
    outcome: "ignore",
  },
  {
    test: /^packages\/[^/]+\/(test|tests)\//,
    why: "tests don't ship",
    outcome: "ignore",
  },
  {
    test: /^packages\/[^/]+\/config\.example\.toml$/,
    // The real config.toml is gitignored and hand-maintained; the example moving is a prompt to a
    // human, not an action. Reported by the assets step rather than acted on here.
    why: "example config — the live config.toml is not managed by deploy",
    outcome: "ignore",
  },
  {
    test: /^(\.gitignore|\.nvmrc|\.prettier\w*|commitlint\.config\.mjs|\.env\.example)$/,
    why: "repo hygiene",
    outcome: "ignore",
  },

  // --- dependency and toolchain changes: rebuild everything --------------------------------------
  // A moved dependency can change any service's behaviour without touching its source, and a build
  // against a half-installed tree fails in ways that read as a code error. Cheapest correct answer.
  {
    test: /^(pnpm-lock\.yaml|pnpm-workspace\.yaml|package\.json|turbo\.json|tsconfig\.base\.json)$/,
    why: "workspace dependency or toolchain change",
    outcome: "full",
  },
  {
    test: /^packages\/[^/]+\/(package\.json|tsconfig\.json)$/,
    why: "a package's dependencies or compiler settings moved",
    outcome: "full",
  },

  // --- shared libraries: the fan-out the runbook warns about ------------------------------------
  {
    test: /^packages\/contracts\//,
    // "Rebuild every Node service on the Pi — they each compile contracts in as a dependency."
    // Stylus is added to that list here: it is stdlib-only and needs no build, but it hand-builds
    // payloads to match these schemas, so a widened schema or a new scan-URI kind is exactly the
    // case where a stale reader sends a shape the freshly-built services reject. Reinstalling it
    // costs seconds and removes the judgement call.
    why: "every service compiles contracts in; Stylus encodes the same shapes by hand",
    outcome: {
      build: new Set<ServiceId>([...NODE_PI_SERVICES, "curator"]),
      restart: new Set<ServiceId>([...NODE_PI_SERVICES, "curator", "stylus"]),
      pipInstall: true,
    },
  },
  {
    test: /^packages\/observability\//,
    why: "shared logging library, compiled into every Node service",
    outcome: {
      build: new Set<ServiceId>([...NODE_PI_SERVICES, "curator"]),
      restart: new Set<ServiceId>([...NODE_PI_SERVICES, "curator"]),
    },
  },
  {
    test: /^packages\/palette-press\//,
    why: "palette extraction runs in-process in Curator only",
    outcome: buildAndRestart("curator"),
  },

  // --- Backdrop: three different artefacts in one package ---------------------------------------
  {
    test: /^packages\/backdrop\/public\//,
    // Vanilla JS/CSS loaded as file:// straight from the working tree, so the checkout updates it
    // instantly — but Chromium is already holding the old copy in memory. No build, no restart:
    // the backend never reads these files. Reloading the browser is the entire action.
    why: "kiosk SPA — served from the working tree, cached in the running browser",
    outcome: { kioskReload: true },
  },
  {
    // Backdrop's deploy/ holds two unrelated kinds of file, and they need opposite actions: the
    // unit is systemd's and wants a service restart, the rest are the desktop session's and want a
    // reboot. Lumping them together either reboots the Pi for a unit edit or — the one that
    // actually matters — leaves Backdrop running on the old unit after its unit file changed.
    test: /^packages\/backdrop\/deploy\/marquee-backdrop\.service$/,
    why: "Backdrop unit file",
    outcome: { assets: true, restart: new Set<ServiceId>(["backdrop"]) },
  },
  {
    test: /^packages\/backdrop\/deploy\//,
    // kiosk.sh and the autostart entries are *copied* out of the repo, so a pull never updates the
    // installed copy. Converging them changes how the session starts, which needs the session
    // restarted to take effect.
    why: "kiosk launcher / autostart assets, installed by copy",
    outcome: { assets: true, kioskReload: true },
  },
  {
    test: /^packages\/backdrop\/src\//,
    why: "Backdrop backend",
    outcome: buildAndRestart("backdrop"),
  },

  // --- the remaining Node services ---------------------------------------------------------------
  {
    test: /^packages\/hue-conductor\/deploy\//,
    why: "Conductor unit file",
    outcome: { assets: true, restart: new Set<ServiceId>(["conductor"]) },
  },
  {
    test: /^packages\/hue-conductor\//,
    why: "Conductor",
    outcome: buildAndRestart("conductor"),
  },
  {
    test: /^packages\/amp\/deploy\//,
    why: "Amp unit file",
    outcome: { assets: true, restart: new Set<ServiceId>(["amp"]) },
  },
  {
    test: /^packages\/amp\//,
    why: "Amp",
    outcome: buildAndRestart("amp"),
  },

  // --- Stylus: no build, but the installed copy is not the checkout ------------------------------
  {
    test: /^packages\/stylus\/marquee-stylus\.service$/,
    why: "Stylus unit file",
    outcome: { assets: true, restart: new Set<ServiceId>(["stylus"]) },
  },
  {
    test: /^packages\/stylus\//,
    // Installed non-editable, so site-packages holds a copy that `git pull` never touches. Skipping
    // the pip install leaves `systemctl status` reporting active over four-day-old code (#201).
    why: "Stylus — installed non-editable, so the checkout is not what runs",
    outcome: { pipInstall: true, restart: new Set<ServiceId>(["stylus"]) },
  },

  // --- the workstation ---------------------------------------------------------------------------
  {
    test: /^packages\/(curator|desktop)\//,
    // Desktop is here because it forks Curator and serves Curator's UI: a desktop-side change lands
    // only when the shell is rebuilt and relaunched, which is the same action Curator needs.
    why: "Curator and the desktop shell that hosts it",
    outcome: buildAndRestart("curator"),
  },
];

/** The first rule matching `path`, or undefined if nothing claims it. */
export function ruleFor(path: string): Rule | undefined {
  return RULES.find((r) => r.test.test(path));
}

function merge(into: Effects, from: Partial<Effects>): void {
  if (from.pnpmInstall) into.pnpmInstall = true;
  if (from.pipInstall) into.pipInstall = true;
  if (from.kioskReload) into.kioskReload = true;
  if (from.assets) into.assets = true;
  for (const id of from.build ?? []) into.build.add(id);
  for (const id of from.restart ?? []) into.restart.add(id);
}

/**
 * The work a set of changed paths requires.
 *
 * `paths` is the output of `git diff --name-only <deployed> <target>` — repo-relative, forward
 * slashes. An unrecognized path escalates the whole result to a full deploy and is recorded in
 * `unrecognized` so the run can say what caused it.
 */
export function effectsFor(paths: readonly string[]): Effects {
  const effects = noEffects();
  const unrecognized: string[] = [];

  for (const path of paths) {
    const rule = ruleFor(path);
    if (!rule) {
      unrecognized.push(path);
      continue;
    }
    if (rule.outcome === "ignore") continue;
    if (rule.outcome === "full") return { ...fullEffects(), unrecognized: [] };
    merge(effects, rule.outcome);
  }

  if (unrecognized.length > 0) return { ...fullEffects(), unrecognized };
  return effects;
}

/**
 * A build ordering that respects the fact that every service compiles `packages/contracts`.
 *
 * `pnpm --filter <pkg> build` runs `tsc -b`, which follows project references and builds the
 * dependency itself — so this is about a stable, reportable order rather than about correctness.
 */
export function buildOrder(ids: Iterable<ServiceId>): ServiceId[] {
  const order: ServiceId[] = [
    "conductor",
    "backdrop",
    "amp",
    "curator",
    "stylus",
  ];
  const wanted = new Set(ids);
  return order.filter((id) => wanted.has(id));
}
