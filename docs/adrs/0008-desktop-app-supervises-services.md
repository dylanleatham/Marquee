# ADR 0008 — A desktop app supervises Curator + Conductor

Status: accepted · Date: 2026-07-17 · Amends: [runtime-overview §7](../specs/runtime-overview.md) (adds a launch surface) · Package: `packages/desktop`

## Context

Running Curator meant hand-starting three things — the Curator API (4739), the Vite UI dev server
(4738), and Conductor (4737) — then navigating to a `localhost` URL. That's fine for development but
wrong for _using_ the collection: the ask was "an app I launch from my desktop and get to work," no
terminals, no IPs. The Demo Room also needs Conductor up to drive the lights, so a launcher should
bring both services online together.

The services themselves are already the right shape: Curator's production server serves its built UI
at `http://localhost:4739` and both services expose `/healthz`. What was missing was a shell that
starts them, waits for them, and shows the UI as a window.

## Decision

**Add an Electron app (`@marquee/desktop`) that supervises the two Node services and shows Curator's
existing web UI in a native window.** It is a launcher/supervisor/shell — the services are unchanged
and still run headless for the Pi and CI. Nothing about the "config vs runtime" split in
runtime-overview §7 changes; this is only a new way to launch the config side.

1. **Supervise.** The Electron main process ([src/main.ts](../../packages/desktop/src/main.ts))
   starts Conductor then Curator, polls each `/healthz`, then opens the window on
   `http://localhost:4739`. It **adopts** an already-running instance instead of forking a duplicate
   onto a taken port, is single-instance, and tears the services down on quit.
2. **Spawn with Electron's own Node.** Services are `fork`ed with `ELECTRON_RUN_AS_NODE=1`, so a
   packaged app needs no separate Node install.
3. **Pin Curator local.** The desktop app sets `CONDUCTOR_URL=http://localhost:4737` in Curator's
   env. The repo `.env` points that at the Pi (`conductor.local`) for real deployment; on one box
   that host doesn't resolve and the Demo Room would read "offline." Node's `loadEnvFile` doesn't
   override an already-set var, so the `.env` Spotify credentials still load.
4. **Package by bundling, not by shipping node_modules.** `scripts/bundle-servers.mjs` esbuilds each
   server into one self-contained ESM file (with a `createRequire` banner for Fastify's internal
   dynamic `require`), staged next to the runtime files each server locates via `import.meta.url`
   (`../dist-ui` for Curator, `../data` for Conductor's paired bridge key). electron-builder
   ([electron-builder.yml](../../packages/desktop/electron-builder.yml)) ships those as
   `extraResources` and produces an unsigned Windows NSIS installer with a desktop shortcut. This
   sidesteps pnpm's symlinked `node_modules` — the real packaging hazard.

## Consequences

- **Two launch surfaces**: `pnpm app` (dev — builds + opens the window) and the packaged installer's
  desktop icon (users). Data still lives in `~/marquee`, outside the app bundle.
- **`services.ts` is unit-tested** (health polling, adopt-vs-fork specs); the Electron glue is
  verified by launching. The full boot + bundled-server runtime were both proven headlessly (fork →
  both healthy → Curator→Conductor `reachable:true`; bundled servers serve the UI and find the paired
  key).
- **Building the installer needs Windows Developer Mode** (symlink privilege for electron-builder's
  `winCodeSign` extraction), and the installer is **unsigned** (SmartScreen warns once). Both are
  documented one-time steps, not code issues.
- **Known follow-ups**, deliberately out of scope here: a packaged app finds no repo `.env`, so
  **Spotify credentials** need a real home (a `~/marquee` settings file or first-run prompt) — manual
  album add works without them; **ffmpeg** stays a system dependency; and a **custom app icon**
  replaces the default Electron one.
- Purely additive: the services' existing run paths, tests, and the Pi deployment are untouched.

> **Update (2026-07-17):** all three follow-ups are resolved.
>
> - **Spotify credentials**: Curator reads them from `settings.json` in the data dir (`~/marquee`) —
>   layered under `config.toml`/env, so dev is unchanged — written by an in-app **Settings** screen
>   (`GET`/`PUT /api/settings/spotify`). They apply on the next launch (the Spotify client + Roadie
>   are built at boot).
> - **App icon**: a generated amber-bulb `build/icon.png` (`scripts/make-icon.mjs`), converted to the
>   Windows `.ico` by electron-builder.
> - **ffmpeg**: the app bundles `ffmpeg-static` + `ffprobe-static`; the desktop main points Curator's
>   `FFMPEG_PATH`/`FFPROBE_PATH` at them (`resources/ffmpeg/*` packaged, the static packages in dev),
>   so no system ffmpeg is required. It adds ~145 MB to the installer — the cost of self-containment.

> **Update (2026-07-27, issue #164):** decision 3 ("Pin Curator local") was **half a pin**, and the
> missing half silently severed the runtime path.
>
> `CONDUCTOR_URL` was pinned because on one box the Pi hostname doesn't resolve. The same "one box"
> reasoning applies to the **album-assets store**, and it was not applied: Conductor reads
> `ALBUM_ASSETS_DIR` (default `{pkgDir}/data/album-assets`, i.e. beside the install), while Curator
> writes `~/marquee/album-assets`. On the Pi an rsync bridges those two paths (runbook A4.3); in a
> packaged desktop install there is no rsync and no Pi, so Conductor read an empty directory and
> answered every scan `202 ignored: album not synced` while Preview reported "Lights running".
>
> `serviceSpecs()` now pins **both** halves from one resolved data dir — `MARQUEE_DATA_DIR` on
> Curator and `ALBUM_ASSETS_DIR` on Conductor — so the two services agree by construction rather than
> by both happening to compute the same default. The general rule this encodes: **anything the Pi
> deployment bridges with an out-of-band sync needs an explicit in-process equivalent on the desktop
> app**, because the desktop app is the deployment where that sync does not exist.
>
> The reporting half of the same bug (Curator treating a 2xx `action:"ignored"` as a successful leg)
> is recorded in [curator-spec §Preview and verification](../specs/curator-spec.md).

> **Update (2026-08-02, issue #229):** decision 1's adoption rule is **narrowed** by
> [ADR 0050](0050-the-desktop-health-gate-checks-identity-not-liveness.md).
>
> "Adopts an already-running instance" was decided against a gate that could only tell whether
> _something_ answered `/healthz` — so it also adopted a stale Curator from another checkout, on a
> different data dir, and drove it with no warning and no curator child of its own. The pins added by
> the #164 update above are exactly what an adopted foreign service ignores.
>
> The shell now generates a per-launch instance token, both services report it (plus their resolved
> directory) from `/healthz`, and the shell **adopts only a matching service** — right kind, same
> directory. Anything else fails the boot with the port and both directories named, as does a child
> that exits before it is healthy. Adoption itself is unchanged where it was always safe, and is now
> logged.

> **Update (2026-08-13, [#306](https://github.com/dylanleatham/Marquee/issues/306) /
> [ADR 0079](0079-the-asset-push-has-more-than-one-target.md)):** decision 3's pin was **too wide**,
> in the opposite direction to the #164 update above.
>
> Setting `CONDUCTOR_URL` aimed the Demo Room at the co-located Conductor — correct, and still the
> behaviour — but that variable is _also_ where the album-assets push takes its target, and
> `loadEnvFile` will not override an already-set var, so the `.env`'s real runtime became invisible
> to Curator entirely. A mixed deployment (shell for the lights, Pi for video and audio) therefore
> pushed the store only to the machine it was already on, and the Pi — where **Amp** reads the
> directory Conductor writes — had no writer at all, while `POST /api/runtime/sync` reported
> `pushed: 478, failures: []`.
>
> The shell now sets `MARQUEE_COLOCATED_CONDUCTOR_URL` and leaves `CONDUCTOR_URL` alone. Curator aims
> the Demo Room at the co-located Conductor exactly as before, and pushes the store to **every**
> configured target. Two facts that were sharing one variable now have one each.
