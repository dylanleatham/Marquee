import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// The idle audit (issue #137) measured what Marquee costs at zero traffic and concluded that two
// things must stay true of the desktop shell. Both are one-line changes that look harmless in a
// diff, cost nothing in a test run, and are only visible as "the laptop is warm" hours later — the
// exact shape of defect the audit exists to make detectable. So they are asserted rather than
// merely written down. See docs/specs/idle-cost-baseline.md and ADR 0049.

const mainTs = readFileSync(resolve(__dirname, "..", "src", "main.ts"), "utf8");

describe("desktop shell holds no power-hostile settings (issue #137)", () => {
  it("leaves backgroundThrottling at Electron's default", () => {
    // Default is `true`: Chromium throttles timers and stops rAF in a window that is hidden,
    // minimized or fully occluded. The window here loads Curator — a workbench you leave open and
    // walk away from, *not* the kiosk (that is Backdrop, Chromium on a Pi, a different codebase).
    // So throttling is free savings whenever it applies. Setting it to `false` is the plausible
    // wrong move: it reads like "keep the UI responsive" and actually means "keep burning CPU
    // behind a minimized window".
    expect(mainTs).not.toMatch(/backgroundThrottling/);
  });

  it("holds no powerSaveBlocker", () => {
    // Nothing in the desktop app should stop the workstation sleeping. Backdrop's kiosk.sh does
    // disable DPMS, deliberately and on the Pi, where a display that blanks looks like a crash;
    // that is scoped to that machine's X session and is not this.
    expect(mainTs).not.toMatch(/powerSaveBlocker/);
  });
});
