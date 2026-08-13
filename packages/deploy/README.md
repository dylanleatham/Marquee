# @marquee/deploy

Puts one commit on every Marquee host and proves it landed. See
[ADR 0080](../../docs/adrs/0080-deployment-is-one-pinned-commit-verified-on-every-host.md) for why it
works the way it does, and [docs/runbook.md](../../docs/runbook.md) Part B for the by-hand equivalent.

```bash
pnpm run deploy
```

> Always `pnpm run deploy`. `pnpm deploy` is pnpm's own built-in command and will not run this.

## First run

Copy the inventory and fill in your hosts:

```bash
cp packages/deploy/hosts.example.json packages/deploy/hosts.json
```

`hosts.json` is gitignored, like the `config.toml` files it sits alongside. The one field worth
checking rather than guessing is each service's **`unit`** — the systemd unit name _as it exists on
that host_. Backdrop's is `backdrop` on some installs and `marquee-backdrop` on others, because
`backdrop/DEPLOY.md` and the runbook created it under different names at different times:

```bash
ssh pi@backdrop.local systemctl list-units --all 'marquee*' 'backdrop*' --no-pager
```

Deploying needs key-based SSH to each Pi (the run uses `BatchMode=yes`, so a missing key fails
immediately rather than hanging on a password prompt) and passwordless `sudo` there, which Raspberry
Pi OS grants the default user out of the box.

Try it without touching anything first:

```bash
pnpm run deploy --dry-run
```

## What it guarantees

On a zero exit: every host has the target commit checked out, every out-of-tree asset matches the
repo at that commit, and every service has been restarted **after** that checkout and is answering.
On any other exit it names the host and the step, and no later host was touched.

## Options

| Option           | Effect                                                                                                             |
| ---------------- | ------------------------------------------------------------------------------------------------------------------ |
| `--ref <ref>`    | Branch, tag or SHA to deploy. Default `origin/main`. Resolved once, then used verbatim on every host.              |
| `--only <names>` | Restrict to named hosts, e.g. `--only pi5,pizero`.                                                                 |
| `--full`         | Skip the change analysis; rebuild and restart everything.                                                          |
| `--dry-run`      | Preflight and print the plan. Changes nothing that runs — it does fetch on each host, so the plan is the real one. |
| `--desktop`      | Also rebuild the Windows installer into `packages/desktop/release/`.                                               |
| `--allow-dirty`  | Proceed over local modifications on a host. They will be discarded.                                                |
| `--hosts <path>` | Use a different inventory file.                                                                                    |

**Rolling back** is a deploy of an older commit — the same code path, so it is verified the same way:

```bash
pnpm run deploy --ref 53b39d3
```

## How it decides what to do

`src/changes.ts` maps changed paths to work, and is the executable form of the runbook's "What
actually needs what" table. The two rules worth knowing:

- **A change to `packages/contracts` rebuilds every Node service**, including the two with no source
  change of their own — each compiles contracts in through a project reference and no other path
  carries the change. It also reinstalls Stylus, which the runbook's table omits: Stylus compiles
  nothing but hand-builds payloads against those schemas.
- **A path matching no rule forces a full deploy** and says which path did it. Adding a package
  without adding a rule over-builds rather than silently skipping a service. If you see that warning,
  add the rule.

## The parts that aren't obvious

**Stylus is installed non-editable**, so `site-packages` holds a copy the checkout doesn't update.
The deploy runs `pip install --no-deps .` and then the `diff -rq` that proves it took — the only
thing that distinguishes "restarted" from "restarted the new code"
([#201](https://github.com/dylanleatham/Marquee/issues/201)).

**A restart is verified against the clock.** No service reports its commit, so the deploy compares
each unit's `ActiveEnterTimestamp` with the moment the checkout finished. A unit running since before
the checkout fails the deploy, however healthy it looks.

**Backdrop's `/healthz` returning 503 is a kiosk warning, not a failure** — the backend is fine and no
browser is attached. It is the most useful signal after a Backdrop deploy, because a crashed Chromium
is invisible from `systemctl status`.

**Curator is checked by its bundle name.** It has no unit to restart or timestamp, and `:4739` is
usually the packaged `Marquee.exe` serving its own bundled copy — so a green checkout and a green
build can both be true while nothing that is running has changed. Vite renames the entry bundle on
every build and Curator enumerates `dist-ui` once at startup, so comparing the bundle it serves with
the one just built says exactly whether it is stale. If it is, the deploy fails and tells you how to
restart it.

**Unit files are converged, with a backup.** The three units that used to exist only as prose are
tracked under each package's `deploy/`. If a rewritten unit stops its service from coming up, the
previous one goes back — restored from the backup, or removed if this deploy created it — and the
service is restarted on it before the error is raised.

**Every host ends up on a detached HEAD**, including the workstation, whose inventory entry probably
points at the checkout you work in. That is the honest report — the host is pinned to a commit, not
tracking a branch — but it does mean your working copy moves. Two things make it safe rather than
annoying: a host already on the target commit is skipped entirely (so deploying `origin/main` while
you sit on an up-to-date `main` does nothing at all), and a dirty tree is refused rather than
discarded. To get back:

```bash
git switch main
```

If you'd rather the workstation were never touched, leave it out of `hosts.json` or use
`--only pi5,pizero`.

## Layout

| File             | What it holds                                                             |
| ---------------- | ------------------------------------------------------------------------- |
| `src/hosts.ts`   | The inventory: parsing, validation, deploy order.                         |
| `src/changes.ts` | Changed paths → work. Pure, and the file to edit when a package is added. |
| `src/assets.ts`  | The out-of-tree asset manifest and its path templating.                   |
| `src/exec.ts`    | Bounded command execution, local and over SSH. The only I/O.              |
| `src/run.ts`     | Preflight, deploy, verify.                                                |
| `src/curator.ts` | The workstation's staleness check.                                        |
| `src/cli.ts`     | Argument parsing and output.                                              |

The core is pure and the I/O is behind an `Executor` interface, so `test/run.test.ts` drives whole
deploys — including the rollback and staleness paths — with no Raspberry Pi switched on.

```bash
pnpm --filter @marquee/deploy test
```
