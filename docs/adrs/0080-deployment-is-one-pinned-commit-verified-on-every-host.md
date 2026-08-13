# ADR 0080 — Deployment is one pinned commit, verified on every host

**Date:** 2026-08-13
**Status:** Accepted
**Supersedes:** nothing. Amends [docs/runbook.md](../runbook.md) Part B0 (the repeat-deploy
procedure becomes a script, with the manual steps kept as the fallback),
[backdrop/DEPLOY.md](../../packages/backdrop/DEPLOY.md) §10/§15,
[amp/DEPLOY.md](../../packages/amp/DEPLOY.md) §4, [stylus/DEPLOY.md](../../packages/stylus/DEPLOY.md)
§13, and [runtime-overview](../specs/runtime-overview.md) (new §9 deployment).

## Context

Deploying Marquee was `ssh`, `git pull`, `pnpm build`, `systemctl restart`, typed by hand, on three
hosts, in an order that mattered. Part B0 of the runbook describes it well — it is 180 lines of
careful prose, and most of that length is warnings, because almost every step has a way of appearing
to succeed while changing nothing:

- **Stylus is installed non-editable**, so `site-packages` holds a _copy_ that `git pull` never
  touches. Skipping the `pip install` leaves `systemctl status` saying `active (running)` over stale
  code. This is not hypothetical: the stand ran a four-day-old build with two shipped fixes missing
  ([#201](https://github.com/dylanleatham/Marquee/issues/201)).
- **The Backdrop unit has two names.** `backdrop/DEPLOY.md` creates `backdrop`, the runbook creates
  `marquee-backdrop`, and both exist on real installs. A `systemctl restart` naming the wrong one
  fails partway through, with the other units in that command already restarted.
- **Out-of-tree files are copies.** `~/kiosk.sh`, the autostart entries and every unit file live
  outside the checkout. Editing the repo copy changes nothing on the Pi, and the documented remedy is
  to remember to run two `diff` commands. That drift is what made [#211](https://github.com/dylanleatham/Marquee/issues/211)
  last as long as it did.
- **The contracts fan-out is invisible.** A change to `packages/contracts` reaches Conductor, Backdrop
  and Amp only through a rebuild. Their `src/` is untouched, so "rebuild what changed" is exactly the
  wrong instinct, and the runbook has to say so in bold.
- **Curator can be built without being updated.** `localhost:4739` is usually the packaged
  `Marquee.exe` serving its _own bundled copy_, so a checkout and a build on the workstation can both
  succeed and change nothing about what is running.
- **The order is load-bearing.** Curator is the only service that pushes, and
  [ADR 0073](0073-a-record-with-no-visualizer-plays-the-default.md) has it push `usesDefault` entries
  that an older Backdrop rejects with a `400`, failing the whole sync.

Every one of those is a step a human has to remember, and each failure produces a system that looks
deployed. Nothing recorded which commit a host was actually on, so "is the stand up to date?" had no
answer short of SSHing in and reading `git log`, and rollback meant remembering what to check out.

## Decision

**Deploying is `pnpm run deploy`: one commit is resolved once, applied to every host in a fixed
order, and then _proved_ to be running. The properties the operator had to supply from memory are
supplied by the tool.**

Five parts.

1. **One pinned commit.** `--ref` (default `origin/main`) is resolved to a single SHA before any host
   is contacted; every host is then `git checkout --detach`ed to that exact SHA and reports it back.
   A push landing mid-deploy cannot leave two hosts on different code. Rollback is `--ref <old-sha>`.
   The checkout is detached deliberately: a host is pinned to a commit, not tracking a branch, and
   `git status` saying so is the honest report.

2. **Preflight is total and mutates nothing.** Reachability, a clean tree, the existence of every
   configured unit, passwordless sudo and the presence of the target commit are checked on _all_
   hosts before the first one is written to. A typo in the Pi Zero's hostname fails before the Pi 5
   has restarted anything.

3. **Work is derived from the diff, and escalates when it can't be.** `packages/deploy/src/changes.ts`
   encodes the runbook's "What actually needs what" table as ordered rules — including the contracts
   fan-out, which it extends to Stylus. A changed path matching **no** rule forces a full deploy of
   every host and names the path that caused it. Getting a rule wrong costs a rebuild; having no rule
   costs a stale runtime that looks healthy, so the fallback is deliberately the expensive one.

4. **Out-of-tree assets are converged, not remembered.** The three systemd units that existed only as
   prose to copy-paste are now tracked files, alongside the Stylus unit that already was. On each run
   the deployer hashes the installed copy of every asset, and rewrites the ones that differ — taking a
   backup first, and restoring it if the service then fails to come up. Unit _names_ stay
   configuration, because the Backdrop split is real and installing under the repo's preferred name
   would leave two services on port 4740.

5. **Success is verified, not assumed.** No service reports its commit, so a restart is proved by
   comparing the unit's `ActiveEnterTimestamp` with the moment the checkout finished — a unit running
   since before the checkout is serving the previous commit, whatever `systemctl status` says.
   Stylus additionally gets the `diff -rq` against `site-packages`; `/healthz` is polled over
   loopback **on the host** (mDNS resolves for `ssh` from Windows but not reliably for `curl`);
   Backdrop's `503` is reported as a kiosk warning rather than a backend failure. Curator, which has
   no unit, is checked by comparing the hashed Vite bundle it is serving with the one just built —
   the [#183](https://github.com/dylanleatham/Marquee/issues/183) mechanism used as an oracle.

## Consequences

**The runbook's Part B0 becomes the fallback, not the procedure.** It stays — for a host the script
cannot reach, and because it explains _why_ each step exists — but it now opens by pointing at
`pnpm run deploy`. Where the two disagree, the script is what runs, so the prose is annotated rather
than left to rot.

**Four systemd units enter the repo.** They were prose in three different documents; that is how
Backdrop's came to have two names. Tracking them means an edit can be reviewed and converged, and
`packages/deploy/test/assets.test.ts` now fails if one loses its restart policy or its
`network-online` ordering. A `marquee-kiosk.service` named in the runbook and the bring-up checklist
turned out never to have existed — the kiosk has always started from XDG autostart — so that entry is
now a tracked `.desktop` file and the two documents are corrected.

**A new deployable surface needs a rule.** Adding a package without adding a rule to `changes.ts`
makes every deploy a full one until somebody notices the warning. That is the intended failure
direction, and the warning names the path.

**Deploys still build on the devices.** This ADR does not change that. Cross-compiling `sharp`,
`serialport` and `node-aead-crypto` for arm64 from a Windows workstation is a project of its own, and
the win here is determinism rather than speed.

**`pnpm deploy` is not the command.** pnpm has a built-in `deploy`, so the script is only reachable as
`pnpm run deploy`. The root `package.json` carries a `//deploy` note saying so.

**What is still manual.** Provisioning a bare Pi (Part A) — apt packages, `raspi-config`, Hue
pairing, secret generation. The `config.toml` files, which are gitignored and hold the shared secret,
so there is no repo-side source to converge towards. And installing the desktop installer: `--desktop`
builds it, but running an NSIS installer that replaces the app the operator is using is their call.
