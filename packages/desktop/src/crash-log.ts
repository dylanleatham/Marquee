// Renderer-failure diagnostics for the Curator window (issue #63). The shell already surfaces
// *service* failures (child-process error/exit → dialogs) but was blind to *renderer* failures — a
// React crash or a failed page load blanked the window with nothing logged. These handlers make the
// next occurrence self-reporting.
//
// Kept free of any Electron runtime import so it unit-tests without booting Electron — main.ts
// passes the real webContents, which structurally satisfies WebContentsLike.

/**
 * Messages carry no source prefix of their own: main.ts passes `logger.scoped("renderer")`, and the
 * logger stamps source and level onto every record (issue #141). The bare-`console` default is for
 * standalone use and tests, where the surrounding context is already obvious.
 */
export interface CrashLogger {
  warn(msg: string): void;
  error(msg: string): void;
}

/** The subset of Electron's WebContents this module listens on. */
export interface WebContentsLike {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
}

/** Electron console-message levels: 0 = verbose, 1 = info, 2 = warning, 3 = error. */
const CONSOLE_ERROR_LEVEL = 3;
/** ERR_ABORTED — fired for in-page redirects and cancelled loads; not a real failure. */
const ERR_ABORTED = -3;

/**
 * Register renderer-crash / load-failure / console-error / unresponsive logging on a webContents.
 * Returns nothing; side-effect is the handlers. Defaults to the console logger.
 */
export function registerRendererDiagnostics(
  wc: WebContentsLike,
  log: CrashLogger = console,
): void {
  wc.on("render-process-gone", (...args: unknown[]) => {
    const details = args[1] as
      { reason?: string; exitCode?: number } | undefined;
    log.error(
      `process gone: reason=${details?.reason ?? "unknown"} exitCode=${
        details?.exitCode ?? "?"
      }`,
    );
  });

  wc.on("did-fail-load", (...args: unknown[]) => {
    const errorCode = args[1] as number;
    if (errorCode === ERR_ABORTED) return;
    const errorDescription = args[2] as string;
    const validatedURL = args[3] as string;
    log.error(
      `page failed to load (${errorCode} ${errorDescription}) ${validatedURL}`,
    );
  });

  wc.on("console-message", (...args: unknown[]) => {
    const level = args[1] as number;
    if (level < CONSOLE_ERROR_LEVEL) return; // only surface renderer console.error
    const message = args[2] as string;
    const line = args[3] as number;
    const sourceId = args[4] as string;
    log.error(`console: ${message} (${sourceId}:${line})`);
  });

  wc.on("unresponsive", () => {
    log.warn("window became unresponsive");
  });
}
