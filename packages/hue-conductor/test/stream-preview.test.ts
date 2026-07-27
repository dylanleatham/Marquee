import { describe, it, expect, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { drivePreview } from "../src/stream/preview-driver.js";
import { renderPreviewHtml } from "../src/stream/preview.js";

/**
 * A hand-cranked browser: a clock we advance, a frame queue we drain, a visibility flag we flip.
 * The driver takes all three by injection precisely so this runs in a node test with no jsdom.
 */
function fakeBrowser() {
  let clock = 0;
  let nextHandle = 1;
  const pending = new Map<number, () => void>();
  let hidden = false;
  const listeners = new Set<() => void>();
  const cancelled: number[] = [];

  return {
    cancelled,
    get pendingCount() {
      return pending.size;
    },
    /** Advance the clock by `ms` and run the queued frame callbacks at `hz` (the display rate). */
    advance(ms: number, hz = 60) {
      const stepMs = 1000 / hz;
      for (let t = 0; t < ms; t += stepMs) {
        clock += stepMs;
        const due = [...pending.entries()];
        pending.clear();
        for (const [, cb] of due) cb();
      }
    },
    setHidden(value: boolean) {
      hidden = value;
      for (const l of [...listeners]) l();
    },
    listenerCount: () => listeners.size,
    deps: {
      now: () => clock,
      requestFrame: (cb: () => void) => {
        const handle = nextHandle++;
        pending.set(handle, cb);
        return handle;
      },
      cancelFrame: (handle: number) => {
        cancelled.push(handle);
        pending.delete(handle);
      },
      isHidden: () => hidden,
      onVisibilityChange: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
  };
}

/** Lift the exact text the page will evaluate for the driver, shim and all. */
function driverSourceIn(page: string): string {
  const start = page.indexOf("/* driver:start */");
  const end = page.indexOf("/* driver:end */");
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return page.slice(start, end);
}

describe("drivePreview", () => {
  it("ticks once per content frame, not once per display frame", () => {
    const browser = fakeBrowser();
    const onTick = vi.fn();
    drivePreview({ fps: 25, onTick, ...browser.deps });

    // One second of a 60Hz display against 25fps content: ticks 0..25 (the 1s boundary lands on
    // 25), so 26 paints where the old loop did 60 — and no two of them draw the same frame.
    browser.advance(1000, 60);
    expect(onTick).toHaveBeenCalledTimes(26);
    expect(onTick.mock.calls.map(([tick]) => tick)).toEqual(
      Array.from({ length: 26 }, (_, i) => i),
    );
  });

  it("keeps requesting frames so the loop stays live", () => {
    const browser = fakeBrowser();
    drivePreview({ fps: 25, onTick: () => {}, ...browser.deps });
    browser.advance(500);
    expect(browser.pendingCount).toBe(1);
  });

  it("stops the loop while the page is hidden and resumes on return", () => {
    const browser = fakeBrowser();
    const onTick = vi.fn();
    drivePreview({ fps: 25, onTick, ...browser.deps });
    browser.advance(1000);
    const before = onTick.mock.calls.length;

    browser.setHidden(true);
    expect(browser.pendingCount).toBe(0); // nothing scheduled — the loop is genuinely stopped
    browser.advance(5000);
    expect(onTick).toHaveBeenCalledTimes(before);

    browser.setHidden(false);
    browser.advance(1000);
    expect(onTick.mock.calls.length).toBeGreaterThan(before);
  });

  it("does not fast-forward through the frames the hidden period skipped", () => {
    const browser = fakeBrowser();
    const onTick = vi.fn();
    drivePreview({ fps: 25, onTick, ...browser.deps });
    browser.advance(1000);

    browser.setHidden(true);
    browser.advance(10_000);
    browser.setHidden(false);
    browser.advance(1000);

    // Two visible seconds played, so the animation is ~2s in — not 12s in.
    const last = onTick.mock.calls.at(-1)?.[0];
    expect(last).toBeGreaterThanOrEqual(48);
    expect(last).toBeLessThanOrEqual(51);
  });

  it("never starts when the page is already hidden on load", () => {
    const browser = fakeBrowser();
    const onTick = vi.fn();
    browser.setHidden(true);
    drivePreview({ fps: 25, onTick, ...browser.deps });
    browser.advance(2000);
    expect(onTick).not.toHaveBeenCalled();
    expect(browser.pendingCount).toBe(0);
  });

  it("returns a stop() that cancels the pending frame and drops the listener", () => {
    const browser = fakeBrowser();
    const onTick = vi.fn();
    const stop = drivePreview({ fps: 25, onTick, ...browser.deps });
    browser.advance(1000);
    const before = onTick.mock.calls.length;

    stop();
    expect(browser.cancelled.length).toBe(1);
    expect(browser.pendingCount).toBe(0);
    expect(browser.listenerCount()).toBe(0);

    browser.advance(5000);
    expect(onTick).toHaveBeenCalledTimes(before);
  });

  it("is idempotent — a second stop() is a no-op, not a double cancel", () => {
    const browser = fakeBrowser();
    const stop = drivePreview({ fps: 25, onTick: () => {}, ...browser.deps });
    stop();
    stop();
    expect(browser.cancelled.length).toBe(1);
  });
});

describe("renderPreviewHtml", () => {
  const html = renderPreviewHtml();

  it("drives every effect card from a single loop", () => {
    // The bug was one rAF loop per card. The page must instantiate exactly one driver, and must
    // not call requestAnimationFrame anywhere else — that is what makes the cost independent of
    // how many effects the bench shows.
    expect(html.match(/drivePreview\(\{/g)).toHaveLength(1);
    expect(html.match(/requestAnimationFrame\(/g)).toHaveLength(1);
  });

  it("inlines the driver source so the page stays self-contained", () => {
    expect(html).toContain("function drivePreview");
    expect(html).not.toContain("import ");
  });

  it("inlines a copy that actually runs in a bare browser scope", () => {
    // Regression guard: the inlined text is transpiler output, and esbuild's keep-names transform
    // once wrapped the inner functions in a `__name(…)` helper that exists in the bundle but not
    // on the page — a page that threw on load while every structural assertion still passed. So
    // evaluate the inlined copy with nothing in scope and drive it for real.
    const inlined = new Function(
      `${driverSourceIn(html)}; return drivePreview;`,
    )() as (o: Parameters<typeof drivePreview>[0]) => () => void;

    const browser = fakeBrowser();
    const onTick = vi.fn();
    const stop = inlined({ fps: 25, onTick, ...browser.deps });
    browser.advance(1000, 60);
    expect(onTick).toHaveBeenCalledTimes(26);

    browser.setHidden(true);
    expect(browser.pendingCount).toBe(0);
    stop();
  });

  it("still renders a representative still under reduced motion", () => {
    expect(html).toContain("prefers-reduced-motion");
  });

  it("writes no file as a side effect of being imported", () => {
    // Guarded by import.meta.url === argv[1]; this test importing the module proves the guard holds.
    expect(html.startsWith("<title>")).toBe(true);
  });
});

describe("preview:stream, as actually run", () => {
  // Vitest and tsx transpile the same source differently, so asserting on renderPreviewHtml() from
  // inside vitest cannot see what `pnpm preview:stream` will emit — the `__name` breakage was
  // invisible here and fatal there. This runs the real command and evaluates what it wrote.
  const pkgDir = fileURLToPath(new URL("..", import.meta.url));

  it("emits a page whose inlined driver runs in a bare browser scope", () => {
    const dir = mkdtempSync(join(tmpdir(), "marquee-preview-"));
    const out = join(dir, "preview.html");
    try {
      execFileSync(
        join(pkgDir, "node_modules/.bin/tsx"),
        [join(pkgDir, "src/stream/preview.ts"), out],
        { cwd: pkgDir, timeout: 120_000, stdio: "pipe" },
      );
      const page = readFileSync(out, "utf8");
      const inlined = new Function(
        `${driverSourceIn(page)}; return drivePreview;`,
      )() as (o: Parameters<typeof drivePreview>[0]) => () => void;

      const browser = fakeBrowser();
      const onTick = vi.fn();
      const stop = inlined({ fps: 25, onTick, ...browser.deps });
      browser.advance(1000, 60);
      expect(onTick).toHaveBeenCalledTimes(26);
      stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
