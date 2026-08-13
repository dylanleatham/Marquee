// The rule table is the deployer's judgement, so it gets tested the way judgement should be: every
// row of docs/runbook.md's "What actually needs what" table, asserted against the rule that claims
// to implement it, plus the escalation that catches everything the table doesn't cover.
import { describe, it, expect } from "vitest";
import {
  RULES,
  buildOrder,
  effectsFor,
  fullEffects,
  isEmpty,
  noEffects,
  ruleFor,
} from "../src/changes.js";

const ids = (s: Set<string>) => [...s].sort();

describe("the runbook's table, row by row", () => {
  it("backdrop/src rebuilds and restarts Backdrop, and nothing else", () => {
    const e = effectsFor(["packages/backdrop/src/server.ts"]);
    expect(ids(e.build)).toEqual(["backdrop"]);
    expect(ids(e.restart)).toEqual(["backdrop"]);
    expect(e.kioskReload).toBe(false);
  });

  it("backdrop/public reloads the kiosk and builds nothing", () => {
    // "No build — it's vanilla JS/CSS loaded as file:// straight from the working tree… But
    // Chromium already has the old copy in memory: reload the browser."
    const e = effectsFor(["packages/backdrop/public/index.html"]);
    expect(e.kioskReload).toBe(true);
    expect(ids(e.build)).toEqual([]);
    expect(ids(e.restart)).toEqual([]);
  });

  it("hue-conductor/src rebuilds and restarts Conductor", () => {
    const e = effectsFor(["packages/hue-conductor/src/server.ts"]);
    expect(ids(e.build)).toEqual(["conductor"]);
    expect(ids(e.restart)).toEqual(["conductor"]);
  });

  it("stylus needs a pip install and a restart, but never a build", () => {
    // The core is stdlib-only Python (ADR 0016), so there is nothing to compile — but the install is
    // non-editable, so the checkout is not what runs (issue #201).
    const e = effectsFor(["packages/stylus/stylus/state_machine.py"]);
    expect(e.pipInstall).toBe(true);
    expect(ids(e.restart)).toEqual(["stylus"]);
    expect(ids(e.build)).toEqual([]);
  });

  it("contracts rebuilds every Node service, including ones with no source change", () => {
    // The fan-out the runbook warns about in bold: "Rebuild all three even when only one has source
    // changes." Each service's `tsc -b` follows a project reference to contracts and no other path
    // carries the change.
    const e = effectsFor(["packages/contracts/schemas/scan-event.schema.json"]);
    expect(ids(e.build)).toEqual(["amp", "backdrop", "conductor", "curator"]);
  });

  it("contracts also reinstalls Stylus, which the runbook's table omits", () => {
    // Stylus compiles nothing, so the table's "rebuild every Node service" leaves it out — but it
    // hand-builds payloads to match these schemas, and a new scan-URI kind is exactly the case where
    // a stale reader emits a shape the freshly-built services reject.
    const e = effectsFor(["packages/contracts/schemas/scan-event.schema.json"]);
    expect(e.pipInstall).toBe(true);
    expect(e.restart.has("stylus")).toBe(true);
  });

  it("a lockfile change installs and rebuilds everything", () => {
    // "Any package.json / lockfile → pnpm install before building, or the build fails on a missing dep"
    const e = effectsFor(["pnpm-lock.yaml"]);
    expect(e.pnpmInstall).toBe(true);
    expect(ids(e.build)).toEqual(["amp", "backdrop", "conductor", "curator"]);
  });

  it("Curator-side changes touch nothing on the Pi", () => {
    // "Curator-side only (palette, prompts, video ingest, the UI) → Nothing on the Pi."
    const e = effectsFor([
      "packages/curator/src/server.ts",
      "packages/palette-press/src/extract.ts",
    ]);
    expect(ids(e.build)).toEqual(["curator"]);
    expect(ids(e.restart)).toEqual(["curator"]);
    expect(e.kioskReload).toBe(false);
    expect(e.pipInstall).toBe(false);
  });

  it("the desktop shell counts as Curator, because it serves Curator's UI", () => {
    expect(ids(effectsFor(["packages/desktop/src/main.ts"]).build)).toEqual([
      "curator",
    ]);
  });
});

describe("out-of-tree assets", () => {
  it("a kiosk launcher change converges assets and reloads the kiosk", () => {
    // ~/kiosk.sh is a *copy*; `git pull` never updates it, and the change only takes effect when the
    // session restarts.
    const e = effectsFor(["packages/backdrop/deploy/kiosk.sh"]);
    expect(e.assets).toBe(true);
    expect(e.kioskReload).toBe(true);
    expect(ids(e.build)).toEqual([]);
  });

  it("a unit-file change converges assets and restarts that one service", () => {
    const e = effectsFor(["packages/amp/deploy/marquee-amp.service"]);
    expect(e.assets).toBe(true);
    expect(ids(e.restart)).toEqual(["amp"]);
    expect(ids(e.build)).toEqual([]);
  });

  it("a Backdrop unit change restarts Backdrop instead of rebooting the Pi", () => {
    // Backdrop's deploy/ holds two unrelated kinds of file. The unit sits beside kiosk.sh, so the
    // directory-wide rule alone would reboot the Pi for a unit edit and — worse — never restart
    // Backdrop onto the unit that just changed.
    const e = effectsFor(["packages/backdrop/deploy/marquee-backdrop.service"]);
    expect(e.assets).toBe(true);
    expect(ids(e.restart)).toEqual(["backdrop"]);
    expect(e.kioskReload).toBe(false);
  });

  it("the Stylus unit is matched at its package root, where DEPLOY.md has always pointed", () => {
    const e = effectsFor(["packages/stylus/marquee-stylus.service"]);
    expect(e.assets).toBe(true);
    expect(ids(e.restart)).toEqual(["stylus"]);
    // Specifically *not* a pip install: the unit is not part of the Python package.
    expect(e.pipInstall).toBe(false);
  });
});

describe("changes that must do nothing", () => {
  it.each([
    ["docs/runbook.md", "documentation"],
    ["packages/backdrop/DEPLOY.md", "a doc inside a service package"],
    ["packages/amp/test/store.test.ts", "tests"],
    ["packages/stylus/tests/test_state_machine.py", "Python tests"],
    [".github/workflows/ci.yml", "CI config"],
    ["review-agents/orchestrator.mjs", "the review harness"],
    ["packages/fakes/fake-spotify/src/index.ts", "a test double"],
    ["packages/deploy/src/run.ts", "the deployer itself"],
    ["packages/curator/config.example.toml", "an example config"],
    ["spikes/desk-audio/notes.md", "a spike"],
  ])("%s (%s) is a no-op", (path) => {
    expect(isEmpty(effectsFor([path]))).toBe(true);
  });

  it("an empty change set is empty", () => {
    expect(isEmpty(effectsFor([]))).toBe(true);
  });

  it("a package's own DEPLOY.md doesn't trip that package's rule", () => {
    // Ordering: the markdown rule has to come before the per-package rules, or a doc edit rebuilds
    // and restarts a service for nothing. This is the assertion that pins that ordering.
    expect(isEmpty(effectsFor(["packages/backdrop/DEPLOY.md"]))).toBe(true);
    expect(isEmpty(effectsFor(["packages/stylus/DEPLOY.md"]))).toBe(true);
  });
});

describe("an unrecognized path escalates rather than being skipped", () => {
  // The property that makes it safe to skip work at all. Adding a package, renaming a directory or
  // introducing a file nobody anticipated must over-build, never silently leave a service stale.
  it("forces a full deploy and names what caused it", () => {
    const e = effectsFor(["packages/brand-new-service/src/index.ts"]);
    expect(e.unrecognized).toEqual(["packages/brand-new-service/src/index.ts"]);
    expect(ids(e.build)).toEqual(["amp", "backdrop", "conductor", "curator"]);
    expect(e.pipInstall).toBe(true);
    expect(e.assets).toBe(true);
    expect(e.kioskReload).toBe(true);
  });

  it("escalates even when every other path in the set was recognised", () => {
    const e = effectsFor(["docs/runbook.md", "some/unknown/thing.bin"]);
    expect(e.unrecognized).toEqual(["some/unknown/thing.bin"]);
    expect(isEmpty(e)).toBe(false);
  });

  it("a recognised set leaves `unrecognized` empty", () => {
    expect(effectsFor(["packages/amp/src/server.ts"]).unrecognized).toEqual([]);
  });
});

describe("the rule table itself", () => {
  it("has no rule that can never match, because an earlier one shadows it", () => {
    // A shadowed rule is dead code that reads as coverage — the failure mode where the table looks
    // complete and one of its rows has never once been applied. A rule is shadowed when no path in
    // SAMPLES resolves to it, so SAMPLES has to carry a discriminating path for every rule; a new
    // rule with no sample fails here, which is the prompt to add one.
    const shadowed = RULES.filter(
      (_rule, i) =>
        !SAMPLES.some((s) => RULES.findIndex((r) => r.test.test(s)) === i),
    ).map((r) => String(r.test));
    expect(shadowed).toEqual([]);
  });

  it("matches paths against forward slashes, the way git reports them on every platform", () => {
    // `git diff --name-only` emits forward slashes on Windows too. A rule written with a backslash
    // would pass a Windows-authored test and never match in production.
    for (const rule of RULES) {
      expect(String(rule.test)).not.toContain("\\\\");
    }
  });

  it("gives every rule a reason", () => {
    for (const rule of RULES) expect(rule.why.length).toBeGreaterThan(0);
  });
});

/** One discriminating path per rule, for the shadowing check above. */
const SAMPLES = [
  "docs/x.md",
  "packages/amp/README.md",
  ".github/workflows/ci.yml",
  "packages/fakes/fake-spotify/src/i.ts",
  "packages/deploy/src/run.ts",
  "packages/amp/test/x.test.ts",
  "packages/stylus/tests/x.py",
  "packages/amp/config.example.toml",
  ".gitignore",
  "pnpm-lock.yaml",
  "packages/amp/package.json",
  "packages/contracts/src/i.ts",
  "packages/observability/src/i.ts",
  "packages/palette-press/src/i.ts",
  "packages/backdrop/public/i.html",
  "packages/backdrop/deploy/marquee-backdrop.service",
  "packages/backdrop/deploy/kiosk.sh",
  "packages/backdrop/src/server.ts",
  "packages/hue-conductor/deploy/marquee-conductor.service",
  "packages/hue-conductor/src/server.ts",
  "packages/amp/deploy/marquee-amp.service",
  "packages/amp/src/server.ts",
  "packages/stylus/marquee-stylus.service",
  "packages/stylus/stylus/x.py",
  "packages/curator/src/server.ts",
];

describe("helpers", () => {
  it("fullEffects does everything", () => {
    const e = fullEffects();
    expect(isEmpty(e)).toBe(false);
    expect(e.pnpmInstall && e.pipInstall && e.kioskReload && e.assets).toBe(
      true,
    );
  });

  it("noEffects does nothing", () => {
    expect(isEmpty(noEffects())).toBe(true);
  });

  it("ruleFor returns the first matching rule", () => {
    expect(ruleFor("packages/backdrop/DEPLOY.md")?.outcome).toBe("ignore");
    expect(ruleFor("nothing/claims/this")).toBeUndefined();
  });

  it("buildOrder is stable and drops what wasn't asked for", () => {
    expect(buildOrder(new Set(["curator", "conductor"]))).toEqual([
      "conductor",
      "curator",
    ]);
    expect(buildOrder(new Set())).toEqual([]);
  });
});
