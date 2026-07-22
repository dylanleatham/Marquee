import { describe, it, expect } from "vitest";
import {
  registerRendererDiagnostics,
  type WebContentsLike,
} from "../src/crash-log";

// A structural stand-in for Electron's webContents: records handlers so the test can fire the
// events without booting Electron (mirrors how services.test.ts avoids the real runtime).
class FakeWebContents implements WebContentsLike {
  private handlers = new Map<string, (...args: unknown[]) => void>();
  on(event: string, listener: (...args: unknown[]) => void): unknown {
    this.handlers.set(event, listener);
    return this;
  }
  emit(event: string, ...args: unknown[]): void {
    this.handlers.get(event)?.(...args);
  }
}

const collector = () => {
  const warns: string[] = [];
  const errors: string[] = [];
  return {
    log: {
      warn: (m: string) => warns.push(m),
      error: (m: string) => errors.push(m),
    },
    warns,
    errors,
  };
};

describe("registerRendererDiagnostics", () => {
  it("logs a renderer process crash as an error with the reason", () => {
    const wc = new FakeWebContents();
    const { log, errors } = collector();
    registerRendererDiagnostics(wc, log);
    wc.emit("render-process-gone", {}, { reason: "crashed", exitCode: 133 });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/process gone/);
    expect(errors[0]).toMatch(/crashed/);
    expect(errors[0]).toMatch(/133/);
  });

  it("logs a real page load failure but ignores ERR_ABORTED (-3)", () => {
    const wc = new FakeWebContents();
    const { log, errors } = collector();
    registerRendererDiagnostics(wc, log);

    wc.emit("did-fail-load", {}, -3, "ERR_ABORTED", "http://localhost:4739/");
    expect(errors).toHaveLength(0); // in-page redirect / cancelled load is not a failure

    wc.emit(
      "did-fail-load",
      {},
      -105,
      "ERR_NAME_NOT_RESOLVED",
      "http://localhost:4739/",
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/failed to load/);
    expect(errors[0]).toMatch(/-105/);
  });

  it("surfaces renderer console errors (level 3) but not lower levels", () => {
    const wc = new FakeWebContents();
    const { log, errors } = collector();
    registerRendererDiagnostics(wc, log);

    wc.emit("console-message", {}, 1, "just info", 10, "app.js"); // info — ignored
    wc.emit("console-message", {}, 2, "a warning", 11, "app.js"); // warning — ignored
    expect(errors).toHaveLength(0);

    wc.emit("console-message", {}, 3, "boom in render", 42, "App.tsx");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/boom in render/);
    expect(errors[0]).toMatch(/App\.tsx:42/);
  });

  it("warns when the renderer becomes unresponsive", () => {
    const wc = new FakeWebContents();
    const { log, warns } = collector();
    registerRendererDiagnostics(wc, log);
    wc.emit("unresponsive");
    expect(warns).toHaveLength(1);
    expect(warns[0]).toMatch(/unresponsive/);
  });
});
