// Renderer-failure diagnostics for the Curator window (issue #63). The shell already surfaces
// *service* failures (child-process error/exit → dialogs) but was blind to *renderer* failures — a
// React crash or a failed page load blanked the window with nothing logged. These handlers make the
// next occurrence self-reporting: they log to the same stdout/stderr stream the service logs use.
//
// Kept free of any Electron runtime import so it unit-tests without booting Electron — main.ts
// passes the real webContents, which structurally satisfies WebContentsLike.

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
      `[renderer] process gone: reason=${details?.reason ?? "unknown"} exitCode=${
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
      `[renderer] page failed to load (${errorCode} ${errorDescription}) ${validatedURL}`,
    );
  });

  wc.on("console-message", (...args: unknown[]) => {
    const level = args[1] as number;
    if (level < CONSOLE_ERROR_LEVEL) return; // only surface renderer console.error
    const message = args[2] as string;
    const line = args[3] as number;
    const sourceId = args[4] as string;
    log.error(`[renderer] console: ${message} (${sourceId}:${line})`);
  });

  wc.on("unresponsive", () => {
    log.warn("[renderer] window became unresponsive");
  });
}
