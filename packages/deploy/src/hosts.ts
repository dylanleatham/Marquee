// The deploy inventory: which hosts exist, how to reach them, and what each one runs.
//
// This file is the answer to "the Pi 5's address lives in three places" (docs/runbook.md) for the
// deploy path specifically: one file names the hosts, and everything else in this package derives
// from it. It is deliberately *not* read from `.env` — `.env` is documented as dev/CI-only, isn't
// loaded by every entry point (a Git Bash shell mangles path-shaped variables in it), and a deploy
// that silently picks up a stale exported variable is the opposite of what this package is for.
//
// `hosts.json` is gitignored and `hosts.example.json` is tracked, matching the `config.example.toml`
// convention the runtime services already use.

/** Every service the deployer knows how to put on a host. Anything else in config is an error. */
export const SERVICE_IDS = [
  "conductor",
  "backdrop",
  "amp",
  "stylus",
  "curator",
] as const;

export type ServiceId = (typeof SERVICE_IDS)[number];

/**
 * Services that are compiled by `tsc -b` and therefore inherit changes to `packages/contracts`
 * through a rebuild and no other way. Stylus is Python and Curator builds on the workstation.
 */
export const NODE_PI_SERVICES: readonly ServiceId[] = [
  "conductor",
  "backdrop",
  "amp",
];

/** The workspace package each service is built from — used to form `pnpm --filter` invocations. */
export const SERVICE_PACKAGE: Record<ServiceId, string> = {
  conductor: "@marquee/hue-conductor",
  backdrop: "@marquee/backdrop",
  amp: "@marquee/amp",
  stylus: "stylus",
  curator: "@marquee/curator",
};

export interface ServiceConfig {
  /**
   * The systemd unit name **as it exists on that host**, not as this repo would prefer it.
   *
   * Backdrop is the reason this is configuration rather than a constant: packages/backdrop/DEPLOY.md
   * creates `backdrop` and docs/runbook.md A3 creates `marquee-backdrop`, and both exist on real
   * installs. Guessing wrong gives `Unit marquee-backdrop.service not found` partway through a
   * `systemctl restart` that already touched the other units — the exact half-applied state Part B
   * tells you to avoid by hand. Preflight checks this name exists before anything mutates.
   *
   * Omitted for `curator`, which runs on the workstation under the desktop shell, not under systemd.
   */
  unit?: string;
  /** Port the service's `/healthz` answers on, checked from the host itself over loopback. */
  port: number;
}

export interface HostConfig {
  /** `user@host` for SSH. Omitted only for the workstation, which runs commands locally. */
  ssh?: string;
  /** Absolute path to the Marquee checkout on that host. */
  repo: string;
  /** Services this host runs, keyed by service id. */
  services: Partial<Record<ServiceId, ServiceConfig>>;
  /**
   * True if this host drives the Chromium kiosk. Kiosk changes need a browser reload rather than a
   * service restart, which is the single most common reason a Backdrop update "didn't take".
   */
  kiosk?: boolean;
  /**
   * The account that owns the checkout and the user-level kiosk assets (`~/kiosk.sh`, the autostart
   * entries). Defaults to the user in `ssh`. Only needed when they differ.
   */
  user?: string;
}

export interface DeployConfig {
  hosts: Record<string, HostConfig>;
}

export interface Host extends HostConfig {
  /** The inventory key (`pi5`, `pizero`, `workstation`) — how `--only` and reports name a host. */
  name: string;
  user: string;
  /** Home directory of `user` on that host, where the user-level kiosk assets live. */
  home: string;
}

/**
 * Deploy order. Pis first, workstation second.
 *
 * This is not cosmetic and it is not alphabetical. Curator is the only service that *pushes*, so the
 * runtime tolerates being old far better than being ahead: ADR 0073 has Curator push `usesDefault`
 * entries that a Backdrop predating it rejects with a 400, failing the whole sync. Deploying the
 * workstation first therefore produces a runtime that looks deployed and cannot be synced to.
 *
 * Hosts not named here run after the ones that are, in inventory order — a new Pi added to
 * `hosts.json` gets a sensible default rather than silently jumping the queue.
 */
export const HOST_ORDER: readonly string[] = ["pi5", "pizero", "workstation"];

export class ConfigError extends Error {}

function fail(message: string): never {
  throw new ConfigError(message);
}

/** Parse and fully validate a deploy inventory. Throws `ConfigError` naming the offending key. */
export function parseConfig(raw: unknown): Host[] {
  if (typeof raw !== "object" || raw === null) {
    fail("hosts config must be a JSON object");
  }
  const { hosts } = raw as { hosts?: unknown };
  if (typeof hosts !== "object" || hosts === null) {
    fail('hosts config must have a "hosts" object');
  }

  const entries = Object.entries(hosts as Record<string, unknown>);
  if (entries.length === 0) fail('hosts config has no hosts under "hosts"');

  const parsed = entries.map(([name, value]) => parseHost(name, value));

  // A service deployed to two hosts is a real configuration people reach for by copy-paste (the
  // workstation's co-located Conductor in the desktop app is the tempting case). It would make
  // "deployed" ambiguous — two hosts each reporting a different SHA for the same service — so it is
  // rejected rather than picked between.
  const seen = new Map<ServiceId, string>();
  for (const host of parsed) {
    for (const id of Object.keys(host.services) as ServiceId[]) {
      const other = seen.get(id);
      if (other)
        fail(`service "${id}" is configured on both ${other} and ${host.name}`);
      seen.set(id, host.name);
    }
  }

  return sortHosts(parsed);
}

function parseHost(name: string, value: unknown): Host {
  if (typeof value !== "object" || value === null) {
    fail(`host "${name}" must be an object`);
  }
  const host = value as HostConfig;

  if (typeof host.repo !== "string" || host.repo.length === 0) {
    fail(`host "${name}" needs a "repo" path`);
  }
  if (host.ssh !== undefined && typeof host.ssh !== "string") {
    fail(`host "${name}" has a non-string "ssh"`);
  }
  if (typeof host.services !== "object" || host.services === null) {
    fail(`host "${name}" needs a "services" object`);
  }

  const services: Partial<Record<ServiceId, ServiceConfig>> = {};
  for (const [id, svc] of Object.entries(host.services)) {
    if (!(SERVICE_IDS as readonly string[]).includes(id)) {
      fail(
        `host "${name}" names unknown service "${id}" — known services are ${SERVICE_IDS.join(", ")}`,
      );
    }
    if (typeof svc !== "object" || svc === null) {
      fail(`host "${name}" service "${id}" must be an object`);
    }
    const { unit, port } = svc as ServiceConfig;
    if (typeof port !== "number" || !Number.isInteger(port) || port <= 0) {
      fail(`host "${name}" service "${id}" needs an integer "port"`);
    }
    // Curator is the one service with no unit: it runs under the desktop shell, not systemd.
    if (id !== "curator" && (typeof unit !== "string" || unit.length === 0)) {
      fail(
        `host "${name}" service "${id}" needs a "unit" — the systemd unit name as it exists on that ` +
          `host (Backdrop is "backdrop" or "marquee-backdrop" depending on which guide you followed; ` +
          `check with: systemctl list-units --all 'marquee*' 'backdrop*' --no-pager)`,
      );
    }
    services[id as ServiceId] = { ...(unit ? { unit } : {}), port };
  }

  if (Object.keys(services).length === 0) {
    fail(`host "${name}" lists no services`);
  }

  const user = host.user ?? host.ssh?.split("@")[0];
  if (!user) {
    fail(`host "${name}" needs a "user" (it has no "ssh" to infer one from)`);
  }

  return {
    ...host,
    name,
    services,
    user,
    // Kiosk assets are installed into the owning account's home directory. Derived rather than
    // configured so there is one less field to get subtly wrong; `user` remains overridable.
    home: user === "root" ? "/root" : `/home/${user}`,
  };
}

function sortHosts(hosts: Host[]): Host[] {
  const rank = (h: Host) => {
    const i = HOST_ORDER.indexOf(h.name);
    return i === -1 ? HOST_ORDER.length : i;
  };
  return [...hosts].sort((a, b) => rank(a) - rank(b));
}

/** The host running `id`, or undefined if the inventory doesn't deploy it. */
export function hostFor(hosts: Host[], id: ServiceId): Host | undefined {
  return hosts.find((h) => h.services[id] !== undefined);
}

/** True when the host runs commands locally rather than over SSH. */
export function isLocal(host: Host): boolean {
  return host.ssh === undefined;
}
