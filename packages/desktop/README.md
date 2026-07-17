# Marquee Desktop

The one-click app: launches **Curator** + **Hue Conductor** and shows Curator's UI in a native
window — no terminals, no `localhost:` URLs. Spec/ADR:
[../../docs/adrs/0008-desktop-app-supervises-services.md](../../docs/adrs/0008-desktop-app-supervises-services.md).

## What it does

On launch the Electron main process ([src/main.ts](src/main.ts)):

1. Starts Conductor (4737) and Curator (4739) as child processes — forked with Electron's own Node
   (`ELECTRON_RUN_AS_NODE`), so a packaged app needs no separate Node install.
2. Adopts an already-running instance instead of forking a duplicate (so a hand-started `pnpm
--filter @marquee/hue-conductor dev` is reused, not fought over its port).
3. Waits for both `/healthz`, then opens the window on `http://localhost:4739`.
4. Tears both services down on quit. A second launch focuses the existing window (single-instance).

Curator is pinned at the **local** Conductor (`CONDUCTOR_URL=http://localhost:4737`) so the repo
`.env`'s `conductor.local` (the Pi's hostname, for real deployment) doesn't make the Demo Room read
"offline" on one box. Node's `loadEnvFile` won't override an already-set var, so the `.env` Spotify
credentials still load.

## Run (dev)

```bash
pnpm app          # from the repo root — builds the services + UI, then launches the window
```

or `pnpm --filter @marquee/desktop start`. First run builds Curator's UI (a few seconds); the
window opens on the queue with both services live behind it.

## Build the installer

```bash
pnpm --filter @marquee/desktop dist   # → packages/desktop/release/ (Windows NSIS installer)
```

The installer drops a **Desktop + Start-Menu shortcut**. It's **unsigned**, so Windows SmartScreen
warns on first run — choose "More info → Run anyway" (personal use; code-signing is a later step).

## Notes

- **Data** lives in `~/marquee` (album-assets + media), the same as running Curator directly — it is
  outside the app bundle, so reinstalling the app never touches your collection.
- **ffmpeg** (for video attach) is a system dependency: install it on PATH, or set `FFMPEG_PATH` /
  `FFPROBE_PATH`. Bundling it is a future nicety.
- **Lights**: the Demo Room drives real Hue lights via the local Conductor. The bridge pairing lives
  in `packages/hue-conductor/data/conductor.json`; pick your listening room in the Demo Room's
  first-run picker.
- The services remain independently runnable (`pnpm --filter … start`) for the Pi and CI — the
  desktop app is purely an additive launcher.

```

```
