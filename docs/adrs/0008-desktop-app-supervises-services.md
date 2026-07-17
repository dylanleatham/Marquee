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
