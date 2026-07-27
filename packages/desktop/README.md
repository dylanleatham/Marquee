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
5. Writes everything it and the services log to a rotating file (see [Logs](#logs)).

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

**Prerequisite (one-time): turn on Windows Developer Mode** — Settings → Privacy & security → For
developers → _Developer Mode: On_. electron-builder extracts its `winCodeSign` tool, which contains
symlinks; creating those needs the symlink privilege Developer Mode grants (otherwise the build fails
with "Cannot create symbolic link : A required privilege is not held by the client"). Running the
build from an **admin** terminal also works.

```bash
pnpm --filter @marquee/desktop dist   # → packages/desktop/release/ (Windows NSIS installer)
```

This bundles each server with esbuild (`scripts/bundle-servers.mjs` → `staged/`), then packages with
[electron-builder.yml](electron-builder.yml). The installer drops a **Desktop + Start-Menu shortcut**.
It's **unsigned**, so Windows SmartScreen warns on first run — choose "More info → Run anyway"
(personal use; code-signing is a later step).

## Logs

**Help → Open log folder** in the app menu. On Windows that's
`%APPDATA%\Marquee\logs\`; the live file is `marquee.log`, with up to four rotated siblings
(`marquee.1.log` … `marquee.4.log`, 5 MiB each).

Launched from the Start menu there is no terminal, so before this the whole stream went nowhere and
an error left no trace once its dialog was dismissed ([issue #141](https://github.com/dylanleatham/Marquee/issues/141)).
One file now carries all of it, each record stamped with time, level, and source:

```
2026-07-27T12:00:00.000Z INFO  [curator] Curator listening on http://localhost:4739
2026-07-27T12:00:01.412Z ERROR [renderer] console: Cannot read properties of null (App.tsx:214)
2026-07-27T12:00:01.980Z ERROR [shell] Marquee service stopped: curator exited with code 1
```

Sources are `shell` (the Electron main process, including anything that raised an error dialog),
`renderer` (the Curator window — crashes, failed loads, `console.error`, unresponsive hangs), and one
per supervised service (`curator`, `hue-conductor`). Writes are synchronous, so a crash doesn't take
the tail of the log with it.

Two things to expect when you open it. The services log **pino JSON**, which passes through verbatim
inside the record — so a service line is a stamped envelope around a JSON object until
[#142](https://github.com/dylanleatham/Marquee/issues/142) unifies the two. And Curator logs **every
HTTP request**, so an active session fills the file fast; that's what the rotation is for, but it does
mean the interesting lines are outnumbered. Grep for `ERROR` first.

**Not covered:** the Pi services. Stylus and Backdrop run on other machines and log to journald —
`journalctl -u marquee-<service> -f`, per [the runbook](../../docs/runbook.md). Nothing here collects
them; that's a separate answer.

Structured records with stable error fingerprints ([#142](https://github.com/dylanleatham/Marquee/issues/142))
build on this file — it is stage 1 of the error-observability pipeline
([#144](https://github.com/dylanleatham/Marquee/issues/144)).

## Notes

- **Data** lives in `~/marquee` (album-assets + media), the same as running Curator directly — it is
  outside the app bundle, so reinstalling the app never touches your collection.
- **Spotify** search / add-by-URL: the packaged app has no repo `.env`, so enter your Spotify API
  credentials once in the app's **Settings** screen. They're saved to `~/marquee/settings.json` and
  apply on the next launch. (Manual album add works without them.)
- **ffmpeg** (for video attach) is **bundled** — `ffmpeg-static` + `ffprobe-static` ship in the app
  (`resources/ffmpeg/*` when packaged; the static packages in dev), and the desktop main points
  Curator's `FFMPEG_PATH`/`FFPROBE_PATH` at them. No system ffmpeg needed. (~145 MB of the installer.)
- **Lights**: the Demo Room drives real Hue lights via the local Conductor. The bridge pairing lives
  in `packages/hue-conductor/data/conductor.json`; pick your listening room in the Demo Room's
  first-run picker.
- The services remain independently runnable (`pnpm --filter … start`) for the Pi and CI — the
  desktop app is purely an additive launcher.
