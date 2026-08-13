// The files that live outside the checkout, and where each one belongs on which host.
//
// docs/runbook.md keeps a list titled "What `git pull` will never update" — the kiosk launcher, the
// autostart entries, the systemd units. They are copies. Editing the repo copy changes nothing on
// the stand, and the documented remedy is to remember to run two `diff` commands. That is the
// largest drift risk in the deployment and it is the one thing a deployer can close outright: this
// manifest is the mapping, and the deploy step diffs every entry on every run.
//
// `packages/*/config.toml` is deliberately **not** here. It holds the shared secret and per-install
// paths, it is gitignored, and only `config.example.toml` is tracked — so there is no repo-side
// source of truth to converge towards. The deployer reports when an example file gains a key the
// live config lacks, and leaves the edit to a human.

import { isLocal, type Host, type ServiceId } from "./hosts.js";

export interface Asset {
  /** Stable id, used in reports and by `--skip-asset`. */
  id: string;
  /** Repo-relative source path, forward slashes. */
  source: string;
  /**
   * `unit` files go to /etc/systemd/system under the host's configured unit name and need sudo plus
   * a `daemon-reload`; `user` files are a plain copy into the owning account's home.
   */
  kind: "unit" | "user";
  /** For `unit` assets: whose configured unit name gives the destination filename. */
  service?: ServiceId;
  /** For `user` assets: destination path relative to the account's home directory. */
  homePath?: string;
  /** Octal mode the installed copy must carry. */
  mode: "644" | "755";
  why: string;
}

export const ASSETS: readonly Asset[] = [
  {
    id: "conductor-unit",
    source: "packages/hue-conductor/deploy/marquee-conductor.service",
    kind: "unit",
    service: "conductor",
    mode: "644",
    why: "Conductor's systemd unit",
  },
  {
    id: "backdrop-unit",
    source: "packages/backdrop/deploy/marquee-backdrop.service",
    kind: "unit",
    service: "backdrop",
    mode: "644",
    why: "Backdrop's systemd unit",
  },
  {
    id: "amp-unit",
    source: "packages/amp/deploy/marquee-amp.service",
    kind: "unit",
    service: "amp",
    mode: "644",
    why: "Amp's systemd unit",
  },
  {
    id: "stylus-unit",
    // The one unit that was already tracked, and so the one that sets the pattern. It sits at the
    // package root rather than under deploy/ because DEPLOY.md has pointed at that path since it
    // was written; moving it would break a documented `cp` for no gain.
    source: "packages/stylus/marquee-stylus.service",
    kind: "unit",
    service: "stylus",
    mode: "644",
    why: "Stylus's systemd unit",
  },
  {
    id: "kiosk-launcher",
    source: "packages/backdrop/deploy/kiosk.sh",
    kind: "user",
    homePath: "kiosk.sh",
    // Executed by the autostart entry, so it must carry the execute bit; a 644 copy fails at boot
    // with nothing in /tmp/kiosk.log to explain it, because the script never runs to open the log.
    mode: "755",
    why: "every Chromium flag and the 1920x1080@60 display mode",
  },
  {
    id: "kiosk-autostart",
    source: "packages/backdrop/deploy/backdrop-kiosk.desktop",
    kind: "user",
    homePath: ".config/autostart/backdrop-kiosk.desktop",
    mode: "644",
    why: "starts the kiosk with the desktop session",
  },
  {
    id: "compositor-override",
    source: "packages/backdrop/deploy/xcompmgr.desktop",
    kind: "user",
    homePath: ".config/autostart/xcompmgr.desktop",
    mode: "644",
    why: "disables the tearing compositor (ADR 0047)",
  },
];

/** The kiosk assets — installed only on the host that drives the display. */
const KIOSK_ASSET_IDS = new Set([
  "kiosk-launcher",
  "kiosk-autostart",
  "compositor-override",
]);

/** The assets `host` is responsible for, given the services it runs and whether it drives a kiosk. */
export function assetsFor(host: Host): Asset[] {
  return ASSETS.filter((asset) => {
    if (KIOSK_ASSET_IDS.has(asset.id)) return host.kiosk === true;
    return (
      asset.service !== undefined && host.services[asset.service] !== undefined
    );
  });
}

/** Absolute destination path for `asset` on `host`. */
export function destFor(asset: Asset, host: Host): string {
  if (asset.kind === "unit") {
    const unit = asset.service ? host.services[asset.service]?.unit : undefined;
    if (!unit) {
      throw new Error(
        `asset ${asset.id} is a unit for "${asset.service}", which ${host.name} does not run`,
      );
    }
    return `/etc/systemd/system/${unit}.service`;
  }
  return `${host.home}/${asset.homePath}`;
}

/**
 * The canonical paths the tracked asset files are written with. A stock install — user `pi`, repo at
 * `~/Marquee` — renders byte-for-byte identical to the file in the repo, which keeps the documented
 * `cp ~/Marquee/packages/backdrop/deploy/kiosk.sh ~/kiosk.sh` honest for anyone installing by hand.
 */
export const CANONICAL_REPO = "/home/pi/Marquee";
export const CANONICAL_HOME = "/home/pi";

/**
 * `source` with the canonical paths rewritten for `host`.
 *
 * Repo before home, because the repo path contains the home path — replacing the shorter one first
 * would turn `/home/pi/Marquee` into `<home>/Marquee` and quietly ignore a configured `repo`.
 */
export function render(source: string, host: Host): string {
  return source
    .split(CANONICAL_REPO)
    .join(host.repo)
    .split(CANONICAL_HOME)
    .join(host.home);
}

/**
 * Assets are installed over SSH by piping content to `sudo tee`, so a host that runs commands
 * locally (the workstation) has none — Curator has no unit and drives no kiosk. Guarding here keeps
 * the install path from having to reason about a local/remote split it would otherwise get wrong
 * exactly once.
 */
export function hostTakesAssets(host: Host): boolean {
  return !isLocal(host) && assetsFor(host).length > 0;
}
