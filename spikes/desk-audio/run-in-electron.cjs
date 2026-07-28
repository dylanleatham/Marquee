/**
 * Marquee spike — run widevine.html inside Electron and print the verdict (issue #93).
 *
 * Route C (Spotify Web Playback SDK) hinges on one fact: does the Electron the
 * desktop app is built on ship the Widevine CDM? Answer it against the REAL
 * binary rather than the docs. Uses the electron already installed for
 * @marquee/desktop — no new dependency, nothing to install.
 *
 *   node ../../packages/desktop/node_modules/electron/cli.js run-in-electron.cjs
 *
 * Exit code 0 = Widevine present, 2 = probe ran and Widevine is absent, 1 = failed.
 */

const path = require("path");
const { app, BrowserWindow } = require("electron");

const TIMEOUT_MS = 30_000;

// The probe never needs a visible window, and a hung load must not leave an
// Electron process parked on the user's desktop.
const timer = setTimeout(() => {
  console.error(`✖ Timed out after ${TIMEOUT_MS}ms`);
  app.exit(1);
}, TIMEOUT_MS);

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false });
  try {
    await win.loadFile(path.join(__dirname, "widevine.html"));
    const result = await win.webContents.executeJavaScript(
      "window.widevineProbe",
    );
    console.log(result.report);
    console.log("");
    console.log(result.text);
    clearTimeout(timer);
    app.exit(result.widevine ? 0 : 2); // 2 = ran fine, Widevine absent
  } catch (err) {
    console.error(`✖ ${err.message}`);
    clearTimeout(timer);
    app.exit(1);
  }
});
