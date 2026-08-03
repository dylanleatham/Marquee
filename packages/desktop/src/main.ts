// Marquee desktop shell: on launch, start Curator + Conductor as child processes, wait for both to
// report healthy, then show Curator's web UI in a native window. Quitting tears the services down.
// The services are unchanged — this is a launcher/supervisor, not a rewrite (ADR 0008).
import { app, BrowserWindow, Menu, dialog, shell } from "electron";
import { fork, type ChildProcess } from "node:child_process";
import { join, resolve } from "node:path";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  serviceSpecs,
  devEntries,
  resolveDataDir,
  newInstanceId,
  probeHealth,
  waitForOurs,
  planBoot,
  watchBootExit,
  CURATOR_PORT,
  type ServiceSpec,
  type FfmpegPaths,
} from "./services";
import { registerRendererDiagnostics } from "./crash-log";
import { openLogSink, type LogSink } from "./log-sink";
import { createShellLogger, type ShellLogger } from "./logging";

// Before anything reads a path off `app`. A packaged build gets "Marquee" from electron-builder's
// productName, but an unpackaged `electron dist/main.js` defaults to "Electron" — and Electron
// resolves userData (which `logs` hangs off) once, early, so calling this inside `whenReady` is too
// late: a dev run then writes to %APPDATA%\Electron\logs. Verified the hard way. Naming it here
// makes dev and packaged agree, so the README can name one path.
app.setName("Marquee");

const children: ChildProcess[] = [];
let mainWindow: BrowserWindow | null = null;
let shuttingDown = false;
// Until boot finishes, a child's death is boot's failure to report (`watchBootExit`) — the generic
// "service stopped" handlers below would otherwise raise a second, vaguer dialog for the same event.
let booted = false;

// Logging is initialised before anything else can fail, so a boot failure is itself logged. Until it
// runs, records go to the console only; if no directory will take a sink at all, `initLogging` says so
// in a dialog rather than to a console a Start-menu launch doesn't have.
let logSink: LogSink | null = null;
let logDir = "";
let log: ShellLogger = createShellLogger({ sink: { write: () => {} } });
/** Line writers for the child streams, flushed on shutdown so a last partial line isn't lost. */
const streams: { flush(): void }[] = [];

function initLogging(): void {
  // Two candidates, because the preferred one can be unavailable for reasons the app can't fix (an
  // offline roaming profile, locked-down permissions, a stale handle) and the temp dir almost never
  // is. Previously a failure here meant console-only — which from a Start-menu launch is no
  // destination at all, so the app ran happily and logged nothing.
  const candidates = [app.getPath("logs"), join(tmpdir(), "marquee-logs")];
  try {
    const opened = openLogSink(candidates);
    logDir = opened.dir;
    logSink = opened.sink;
    log = createShellLogger({ sink: logSink });
    log.info("shell", `logging to ${logSink.file}`);
    // Say so loudly: "Open log folder" now points somewhere unexpected, and the reason belongs in the
    // log the reader is holding.
    for (const f of opened.failures)
      log.warn("shell", `could not log to ${f.dir} (${f.error}) — fell back`);
  } catch (err) {
    // Nowhere to write at all. This is the one logging failure that has to be *shown*: the symptom
    // is an empty log folder, which is indistinguishable from a quiet evening, and the record saying
    // why would go to a console that a Start-menu launch doesn't have.
    const message = (err as Error).message;
    log.error("shell", `could not open a log file anywhere: ${message}`);
    dialog.showErrorBox(
      "Marquee can't write a log file",
      `${message}\n\nThe app will keep running, but nothing will be recorded — ` +
        `so if something goes wrong there will be no trace of it.`,
    );
  }
}

/**
 * Log a failure *and* show it. `dialog.showErrorBox` is ephemeral — dismissing it was previously the
 * end of the evidence (issue #141), which is exactly the case the log file exists for.
 */
function reportFailure(title: string, message: string): void {
  log.error("shell", `${title}: ${message}`);
  dialog.showErrorBox(title, message);
}

/** dist/main.js → packages/desktop/dist → up three levels is the monorepo root (dev run). */
const repoRoot = (): string => resolve(__dirname, "..", "..", "..");

/** Packaged builds fork esbuild-bundled servers shipped in resources; dev forks the built ESM. */
function resolveEntries(): { curator: string; conductor: string } {
  if (app.isPackaged) {
    const servers = join(process.resourcesPath, "servers");
    return {
      curator: join(servers, "curator-server.mjs"),
      conductor: join(servers, "conductor-server.mjs"),
    };
  }
  return devEntries(repoRoot());
}

/**
 * ffmpeg/ffprobe for Curator's video ingest. Packaged: the binaries shipped in resources/ffmpeg.
 * Dev: the ffmpeg-static / ffprobe-static packages. Either missing → undefined, and Curator falls
 * back to a system ffmpeg on PATH.
 */
function resolveFfmpeg(): FfmpegPaths | undefined {
  try {
    const paths: FfmpegPaths = app.isPackaged
      ? {
          ffmpeg: join(process.resourcesPath, "ffmpeg", "ffmpeg.exe"),
          ffprobe: join(process.resourcesPath, "ffmpeg", "ffprobe.exe"),
        }
      : {
          ffmpeg: require("ffmpeg-static") as string,
          ffprobe: (require("ffprobe-static") as { path: string }).path,
        };
    if (existsSync(paths.ffmpeg) && existsSync(paths.ffprobe)) return paths;
  } catch {
    // static packages not installed / resources missing — fall back to PATH
  }
  return undefined;
}

function startService(spec: ServiceSpec): ChildProcess {
  // fork uses Electron's own binary; ELECTRON_RUN_AS_NODE makes it behave as plain Node, so a
  // packaged app needs no system Node install.
  const child = fork(spec.entry, [], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", ...spec.env },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  // Each service's output is framed into whole lines and logged under its own name, so per-service
  // attribution survives into the file (the old `[name] ` prefix, now the record's source field).
  const out = log.stream("info", spec.name);
  const err = log.stream("error", spec.name);
  streams.push(out, err);
  child.stdout?.on("data", (d: Buffer) => out.push(d.toString()));
  child.stderr?.on("data", (d: Buffer) => err.push(d.toString()));
  // A spawn failure (e.g. a missing bundled server) emits 'error'; without this listener it would
  // throw unhandled and crash the main process instead of showing the dialog + quitting.
  child.on("error", (spawnErr) => {
    if (shuttingDown || !booted) return;
    reportFailure(
      "Marquee failed to start",
      `Could not start ${spec.name}: ${spawnErr.message}`,
    );
    shutdown();
    app.quit();
  });
  child.on("exit", (code) => {
    out.flush();
    err.flush();
    if (code && code !== 0 && !shuttingDown && booted)
      reportFailure(
        "Marquee service stopped",
        `${spec.name} exited with code ${code}. Restart the app.`,
      );
  });
  children.push(child);
  return child;
}

function shutdown(): void {
  shuttingDown = true;
  for (const child of children) {
    try {
      child.kill();
    } catch {
      // already gone
    }
  }
  // Flush partial lines, then release the handle. Ordering matters: a flush after close is dropped.
  for (const stream of streams) stream.flush();
  logSink?.close();
  logSink = null;
}

async function boot(): Promise<void> {
  const entries = resolveEntries();
  if (
    !app.isPackaged &&
    (!existsSync(entries.curator) || !existsSync(entries.conductor))
  )
    throw new Error(
      "Built servers not found. Run `pnpm --filter @marquee/desktop run build:services` first.",
    );
  // One token per launch, handed to each child and required back from /healthz, so the gate can tell
  // the services it started from whatever else happens to hold the ports (issue #229).
  const instanceId = newInstanceId();
  const specs = serviceSpecs(
    entries,
    resolveFfmpeg(),
    resolveDataDir(),
    instanceId,
  );
  const verdicts = await Promise.all(
    specs.map((s) => probeHealth(s, instanceId)),
  );
  const plan = planBoot(specs, verdicts);

  // A stranger on one of our ports is where this used to go quiet: the poll saw a 200, the shell
  // adopted it, and the window opened on another checkout's collection with no service child of its
  // own. Refusing to boot is the only honest answer — we cannot make that process into ours.
  if (plan.conflicts.length)
    throw new Error(
      plan.conflicts
        .map(({ spec, reason }) => `${spec.healthUrl} — ${reason}.`)
        .join("\n") + `\n\nClose that program, then start Marquee again.`,
    );

  // Adopting a matching instance (e.g. a Conductor started by hand on the same store) stays the
  // documented behaviour, ADR 0008 — but it goes in the log now, because "the app didn't start this"
  // is the first thing you want to know when the services misbehave.
  for (const spec of plan.adopt)
    log.warn(
      "shell",
      `adopting the ${spec.name} already running at ${spec.healthUrl} — this launch did not start it`,
    );

  const started = plan.start.map((spec) => ({
    spec,
    child: startService(spec),
  }));
  const watches = started.map(({ spec, child }) => watchBootExit(spec, child));
  try {
    await Promise.race([
      Promise.all(started.map(({ spec }) => waitForOurs(spec, instanceId))),
      ...watches.map((w) => w.rejected),
    ]);
  } finally {
    for (const watch of watches) watch.dispose();
  }
  booted = true;
}

/**
 * A real application menu (curator-ui-ux §9.2). `autoHideMenuBar` with no menu defined left the app
 * with no discoverable command surface and no standard accelerators — the shell looked native but
 * behaved like a page in a frame. The accelerators here mirror the in-app shortcuts so the two
 * agree; the menu is the discoverable half of the keyboard path.
 */
function buildMenu(): void {
  // Navigate by loading the path: Curator serves an SPA fallback for any non-/api GET, so this
  // lands on the right route. `webContents.send` would need a preload to be heard — the window runs
  // with contextIsolation and no bridge, and a menu item is not worth opening one.
  const go = (path: string) => () =>
    void mainWindow?.loadURL(`http://localhost:${CURATOR_PORT}${path}`);
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: "File",
        submenu: [
          {
            label: "Add album…",
            accelerator: "CmdOrCtrl+N",
            click: go("/add"),
          },
          { type: "separator" },
          { role: "quit" },
        ],
      },
      {
        label: "View",
        submenu: [
          { label: "Queue", accelerator: "CmdOrCtrl+1", click: go("/") },
          {
            label: "Settings",
            accelerator: "CmdOrCtrl+,",
            click: go("/settings"),
          },
          { type: "separator" },
          { role: "reload" },
          { role: "forceReload" },
          { role: "toggleDevTools" },
          { type: "separator" },
          { role: "resetZoom" },
          { role: "zoomIn" },
          { role: "zoomOut" },
          { type: "separator" },
          { role: "togglefullscreen" },
        ],
      },
      {
        label: "Help",
        submenu: [
          {
            label: "Writing NFC tags…",
            click: go("/help/tags"),
          },
          { type: "separator" },
          // A log you can't find is nearly as useless as one that was never written (issue #141).
          // Opening the folder rather than the file lets you grab the rotated siblings too.
          {
            label: "Open log folder",
            enabled: logDir !== "",
            click: () => void shell.openPath(logDir),
          },
          { type: "separator" },
          {
            label: "Marquee docs on GitHub",
            click: () =>
              void shell.openExternal(
                "https://github.com/dylanleatham/Marquee/tree/main/docs",
              ),
          },
        ],
      },
    ]),
  );
}

function createWindow(): void {
  // Dev-run taskbar/window icon (packaged builds get the exe icon from electron-builder). The PNG
  // lives in the build resources, absent from the packaged asar — pass it only when present.
  const iconPath = join(__dirname, "..", "build", "icon.png");
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: "Marquee",
    ...(existsSync(iconPath) ? { icon: iconPath } : {}),
    backgroundColor: "#14110f", // matches the UI's warm near-black, so no white flash on load
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true },
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
  // The shell surfaces service failures but was blind to renderer crashes — a React exception or a
  // failed load blanked the window with nothing logged (issue #63). Log those to the same sink.
  registerRendererDiagnostics(mainWindow.webContents, log.scoped("renderer"));
  // External links (Spotify, GitHub) open in the system browser, not inside the app shell.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });
  buildMenu();
  void mainWindow.loadURL(`http://localhost:${CURATOR_PORT}`);
}

// Single-instance: a second launch focuses the existing window instead of starting a second copy of
// the services on the same ports.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(async () => {
    initLogging();
    try {
      await boot();
      createWindow();
    } catch (err) {
      reportFailure("Marquee failed to start", (err as Error).message);
      shutdown();
      app.quit();
    }
  });

  app.on("window-all-closed", () => {
    shutdown();
    app.quit();
  });
  app.on("before-quit", shutdown);
}
