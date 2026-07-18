// Marquee desktop shell: on launch, start Curator + Conductor as child processes, wait for both to
// report healthy, then show Curator's web UI in a native window. Quitting tears the services down.
// The services are unchanged — this is a launcher/supervisor, not a rewrite (ADR 0008).
import { app, BrowserWindow, dialog, shell } from "electron";
import { fork, type ChildProcess } from "node:child_process";
import { join, resolve } from "node:path";
import { existsSync } from "node:fs";
import {
  serviceSpecs,
  devEntries,
  waitForHealth,
  isHealthy,
  servicesToStart,
  CURATOR_PORT,
  type ServiceSpec,
} from "./services";

const children: ChildProcess[] = [];
let mainWindow: BrowserWindow | null = null;
let shuttingDown = false;

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

function startService(spec: ServiceSpec): void {
  // fork uses Electron's own binary; ELECTRON_RUN_AS_NODE makes it behave as plain Node, so a
  // packaged app needs no system Node install.
  const child = fork(spec.entry, [], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", ...spec.env },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  child.stdout?.on("data", (d) => process.stdout.write(`[${spec.name}] ${d}`));
  child.stderr?.on("data", (d) => process.stderr.write(`[${spec.name}] ${d}`));
  // A spawn failure (e.g. a missing bundled server) emits 'error'; without this listener it would
  // throw unhandled and crash the main process instead of showing the dialog + quitting.
  child.on("error", (err) => {
    if (shuttingDown) return;
    dialog.showErrorBox(
      "Marquee failed to start",
      `Could not start ${spec.name}: ${err.message}`,
    );
    shutdown();
    app.quit();
  });
  child.on("exit", (code) => {
    if (code && code !== 0 && !shuttingDown)
      dialog.showErrorBox(
        "Marquee service stopped",
        `${spec.name} exited with code ${code}. Restart the app.`,
      );
  });
  children.push(child);
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
  const specs = serviceSpecs(entries);
  // Adopt an already-running instance (e.g. a Conductor started by hand) rather than forking a
  // duplicate onto a taken port; start only the ones that aren't already answering.
  const health = await Promise.all(specs.map((s) => isHealthy(s.healthUrl)));
  servicesToStart(specs, health).forEach(startService);
  await Promise.all(specs.map((s) => waitForHealth(s.healthUrl)));
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
  // External links (Spotify, GitHub) open in the system browser, not inside the app shell.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });
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
    try {
      await boot();
      createWindow();
    } catch (err) {
      dialog.showErrorBox("Marquee failed to start", (err as Error).message);
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
