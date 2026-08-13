import { describe, it, expect, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  brokenAdrLinksIn,
  citingSources,
  collectAdrs,
  collisionsIn,
  driftFromBaseIn,
  headingMismatchesIn,
  labelHrefMismatchesIn,
  nextFreeNumber,
} from "../../../scripts/check-adr-numbers.mjs";

// Repo-wide invariant, hosted here for the same reason metaprompts.test.ts is: this is the leg CI
// runs (`test:unit`), and the docs have no package of their own.
//
// Issue #151: two branches each allocated "the next ADR number" in parallel and both merged, so
// 0022 and 0023 each named two unrelated decisions — and ~74 citations of the form "ADR 0022"
// silently became ambiguous. Renaming the files was cheap; disambiguating the citations was not.
// Nothing prevented a third collision, and PR #82 was already queued with one. The convention is
// "numbered, immutable, citable" — citability is the half that breaks, and it breaks quietly, so
// it needs a check that turns a silent merge into a red one.
//
// The checks themselves now live in `scripts/check-adr-numbers.mjs` (issue #317). This file was
// the only place they ran, and it runs in exactly one CI leg — which `CI_ENABLED=false` skips, and
// which `pre-push`'s affected-only filter cannot select for a docs-only change. Four collisions
// shipped through that gap (#151's 0022/0023, then 0064, 0075/0076, and #316's 0077/0078). The hook
// runs the script on every push; this file is where the script is *proven*, which a hook can't do.
//
// A gate whose whole job is to fail loudly should be shown failing: every assertion in the first
// suite is `toEqual([])`, which passes just as happily if the detection is broken and silently
// returns nothing. "It's green" and "it works" are different claims — hence the fixtures below.
const adrDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "docs",
  "adrs",
);

describe("ADR numbering", () => {
  const adrs = collectAdrs(adrDir);

  it("finds the ADRs (so a bad path can't make this suite vacuously pass)", () => {
    expect(adrs.length).toBeGreaterThan(30);
  });

  it("allocates each number to exactly one decision", () => {
    expect(collisionsIn(adrs)).toEqual([]);
  });

  it("gives every ADR a `# ADR NNNN` heading that matches its filename", () => {
    expect(headingMismatchesIn(adrs)).toEqual([]);
  });

  // The other half of "citable": a link that names the right ADR but can't be followed is no better
  // than an ambiguous number. Renaming a file is exactly what breaks these, so it belongs next to
  // the uniqueness check. It found one already-broken relative path the first time it ran.
  it("resolves every link that points at an ADR file", () => {
    const repoRoot = join(adrDir, "..", "..");
    expect(brokenAdrLinksIn(citingSources(repoRoot), repoRoot)).toEqual([]);
  });

  // Issue #233: a link that resolves can still name the wrong decision. See labelHrefMismatchesIn.
  it("gives every ADR link a label that agrees with the file it points at", () => {
    const repoRoot = join(adrDir, "..", "..");
    expect(labelHrefMismatchesIn(citingSources(repoRoot), repoRoot)).toEqual(
      [],
    );
  });

  // The scope of the two link checks above, asserted rather than assumed. It used to be three globs
  // — `docs` markdown, `packages` TS/TSX, `CLAUDE.md` — and eighteen ADR-citing files sat outside
  // it. #316's renumber broke a citation in `dispatch.py`; nothing said so, and the hand sweep had
  // been written to the same three globs, because that is what the guard looked like it covered.
  it("scans every tracked text file, not the three globs that let a .py citation break", () => {
    const repoRoot = join(adrDir, "..", "..");
    const scanned = new Set(citingSources(repoRoot));
    for (const outsideTheOldScope of [
      join(repoRoot, "packages", "stylus", "stylus", "dispatch.py"),
      join(repoRoot, "packages", "stylus", "README.md"),
      join(repoRoot, "contract-tests", "schemas.test.mjs"),
      join(repoRoot, "packages", "backdrop", "public", "styles.css"),
    ]) {
      expect(scanned).toContain(outsideTheOldScope);
    }
    // …but not the 9MB logo, and not anything git doesn't track.
    expect(scanned).not.toContain(
      join(
        repoRoot,
        "docs",
        "design_handoff_curator_overhaul",
        "marquee-logo.jpeg",
      ),
    );
    expect([...scanned].some((f) => f.includes("node_modules"))).toBe(false);
  });

  // `driftFromBaseIn` is deliberately *not* run against the real origin/main here. CI checks out at
  // depth 1 and has no such ref, so this suite could only skip the check — and a gate that skips
  // itself is the failure mode #316 was. The hook runs it where the ref exists by construction (you
  // are pushing to it); the fixtures below are where it's proven.
});

// --- proof that the checks above actually fail -------------------------------------------------
//
// Each case is the real thing that happened (or nearly did): 0022/0023/0026 allocated twice, a
// rename that left the heading behind, a link left pointing at the old filename, and — #316 — a
// renumber that was clean in its own tree and landed on top of main's.

const fixtures: string[] = [];
afterAll(() => {
  for (const dir of fixtures) rmSync(dir, { recursive: true, force: true });
});

/**
 * A throwaway directory, so a deliberately-broken ADR never has to be committed to the repo.
 * Names may include a subdirectory (`adrs/0033-x.md`) — the link check resolves hrefs relative to
 * the linking file, so proving it needs a real directory shape.
 */
function fixture(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "adr-fixture-"));
  fixtures.push(dir);
  for (const [name, body] of Object.entries(files)) {
    const path = join(dir, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body);
  }
  return dir;
}

/**
 * Compose a markdown ADR link at runtime. Written literally, the fixtures below would be matched by
 * `brokenAdrLinksIn`'s own regex when it reaches this file — which it now certainly does, since the
 * scan covers every tracked text file — and this file would fail its own check. Same self-scan
 * problem `scripts/check-conflict-markers.mjs` solves by building its markers from `repeat()`
 * rather than typing them out.
 */
const mdLink = (label: string, href: string) => `[${label}](${href})`;

describe("ADR numbering — the checks detect what they claim to", () => {
  it("collisionsIn names both files when a number is used twice", () => {
    const dir = fixture({
      "0001-first.md": "# ADR 0001 — First\n",
      "0002-second.md": "# ADR 0002 — Second\n",
      "0002-also-second.md": "# ADR 0002 — Also second\n",
    });
    const collisions = collisionsIn(collectAdrs(dir));
    expect(collisions).toHaveLength(1);
    // Both names, because the fix is a rename plus a citation sweep and you need to know which two.
    expect(collisions[0]).toContain("0002-also-second.md");
    expect(collisions[0]).toContain("0002-second.md");
  });

  it("collisionsIn stays quiet when every number is unique", () => {
    const dir = fixture({
      "0001-first.md": "# ADR 0001 — First\n",
      "0002-second.md": "# ADR 0002 — Second\n",
    });
    expect(collisionsIn(collectAdrs(dir))).toEqual([]);
  });

  it("headingMismatchesIn catches a rename that left the heading behind", () => {
    const dir = fixture({
      "0007-renamed.md": "# ADR 0003 — Renamed but not retitled\n",
    });
    expect(headingMismatchesIn(collectAdrs(dir))).toEqual([
      "0007-renamed.md → heading says 0003",
    ]);
  });

  it("headingMismatchesIn catches a missing heading, and says so rather than crashing", () => {
    const dir = fixture({ "0001-x.md": "Status: accepted\n\nNo heading.\n" });
    expect(headingMismatchesIn(collectAdrs(dir))).toEqual([
      "0001-x.md → heading says (none)",
    ]);
  });

  it("collectAdrs ignores files that aren't numbered ADRs", () => {
    const dir = fixture({
      "0001-real.md": "# ADR 0001 — Real\n",
      "README.md": "# Not an ADR\n",
      "notes.txt": "scratch\n",
    });
    expect(collectAdrs(dir).map((a) => a.file)).toEqual(["0001-real.md"]);
  });

  // The failure #151 actually produced: files renamed, a citation left pointing at the old name.
  it("brokenAdrLinksIn catches a link left pointing at a renamed file", () => {
    const dir = fixture({
      "adrs/0033-renamed.md": "# ADR 0033 — Renamed\n",
      "cites.md": `See ${mdLink("ADR 0033", "adrs/0022-old-name.md")} for why.\n`,
    });
    expect(brokenAdrLinksIn([join(dir, "cites.md")], dir)).toEqual([
      "cites.md → adrs/0022-old-name.md",
    ]);
  });

  it("brokenAdrLinksIn accepts a link that resolves", () => {
    const dir = fixture({
      "adrs/0033-here.md": "# ADR 0033 — Here\n",
      "cites.md": `See ${mdLink("ADR 0033", "adrs/0033-here.md")}.\n`,
    });
    expect(brokenAdrLinksIn([join(dir, "cites.md")], dir)).toEqual([]);
  });

  // Issue #233's failure, in the shape it would have landed in: the citations converted to links by
  // a mechanical sweep that carried the wrong number along. Every one of these resolves.
  it("labelHrefMismatchesIn catches a link whose label names a different ADR than its target", () => {
    const dir = fixture({
      "adrs/0016-stylus.md": "# ADR 0016 — Stylus\n",
      "adrs/0017-discogs.md": "# ADR 0017 — Discogs\n",
      "cites.md": `Personal token (${mdLink("ADR 0016", "adrs/0017-discogs.md")}).\n`,
    });
    // It resolves — which is the point. Only the label check can see anything wrong here.
    expect(brokenAdrLinksIn([join(dir, "cites.md")], dir)).toEqual([]);
    expect(labelHrefMismatchesIn([join(dir, "cites.md")], dir)).toEqual([
      `cites.md → ${mdLink("ADR 0016", "adrs/0017-discogs.md")}`,
    ]);
  });

  it("labelHrefMismatchesIn stays quiet when the label and the target agree", () => {
    const dir = fixture({
      "adrs/0017-discogs.md": "# ADR 0017 — Discogs\n",
      "cites.md": `Personal token (${mdLink("ADR 0017", "adrs/0017-discogs.md")}).\n`,
    });
    expect(labelHrefMismatchesIn([join(dir, "cites.md")], dir)).toEqual([]);
  });

  it("labelHrefMismatchesIn checks relative links too, whatever the depth", () => {
    const dir = fixture({
      "adrs/0017-discogs.md": "# ADR 0017 — Discogs\n",
      "src/pages/cites.tsx": `// ${mdLink("ADR 0016", "../../adrs/0017-discogs.md")}\n`,
    });
    expect(
      labelHrefMismatchesIn([join(dir, "src", "pages", "cites.tsx")], dir),
    ).toEqual([
      `${join("src", "pages", "cites.tsx")} → ${mdLink("ADR 0016", "../../adrs/0017-discogs.md")}`,
    ]);
  });

  it("brokenAdrLinksIn resolves relative to the linking file, not the repo root", () => {
    // A spec in docs/specs/ cites ../adrs/… — the same href from a different depth is a different
    // file, which is exactly how a correct-looking link ends up broken.
    const dir = fixture({
      "adrs/0033-here.md": "# ADR 0033 — Here\n",
      "specs/cites.md": `See ${mdLink("ADR 0033", "../adrs/0033-here.md")}.\n`,
      "cites.md": `See ${mdLink("ADR 0033", "../adrs/0033-here.md")}.\n`,
    });
    expect(brokenAdrLinksIn([join(dir, "specs", "cites.md")], dir)).toEqual([]);
    expect(brokenAdrLinksIn([join(dir, "cites.md")], dir)).toEqual([
      "cites.md → ../adrs/0033-here.md",
    ]);
  });
});

// --- the check `collisionsIn` cannot make (#316) ------------------------------------------------
//
// Every fixture here is clean under `collisionsIn`. That is the whole point: the branch that broke
// 0077 was green on its own tree, because main's 0077 wasn't in it.

describe("ADR numbering — a number that means something else on origin/main", () => {
  it("catches a renumber that lands on an ADR main already published", () => {
    // Commit 6f85a8e, exactly: the curator ADR moved off a colliding 0075 and onto 0077, which
    // Stylus had taken in e11fab0. Nothing in the branch's own tree said so.
    const dir = fixture({
      "0077-an-edit-that-changes-what-the-room-plays-pushes-it.md":
        "# ADR 0077 — An edit pushes it\n",
    });
    const local = collectAdrs(dir);
    expect(collisionsIn(local)).toEqual([]); // clean here — and broken on merge
    expect(
      driftFromBaseIn(local, ["0077-the-poll-loop-proves-it-is-alive.md"]),
    ).toEqual([
      "0077: origin/main has 0077-the-poll-loop-proves-it-is-alive.md, this tree has 0077-an-edit-that-changes-what-the-room-plays-pushes-it.md",
    ]);
  });

  it("stays quiet when a new ADR takes a number main has never allocated", () => {
    const dir = fixture({
      "0077-the-poll-loop-proves-it-is-alive.md": "# ADR 0077 — Poll loop\n",
      "0081-brand-new.md": "# ADR 0081 — Brand new\n",
    });
    expect(
      driftFromBaseIn(collectAdrs(dir), [
        "0077-the-poll-loop-proves-it-is-alive.md",
      ]),
    ).toEqual([]);
  });

  it("catches a published ADR that was re-slugged or deleted, not only one that was displaced", () => {
    // ADRs are "numbered, immutable, citable". A published number that names nothing here is a
    // citation break too — and the ones outside this repo (PR bodies, review threads) no sweep
    // can reach.
    const dir = fixture({ "0002-kept.md": "# ADR 0002 — Kept\n" });
    expect(
      driftFromBaseIn(collectAdrs(dir), ["0001-gone.md", "0002-kept.md"]),
    ).toEqual(["0001: origin/main has 0001-gone.md, this tree has (nothing)"]);
  });

  it("lets a branch move an ADR off a number that is already colliding on main", () => {
    // This branch, exactly. Main has 0077 twice; there is no allocation to preserve, and the only
    // fix is to move one of them. A gate that blocks its own remedy would just be turned off.
    const dir = fixture({
      "0077-the-poll-loop-proves-it-is-alive.md": "# ADR 0077 — Poll loop\n",
      "0081-an-edit-that-changes-what-the-room-plays-pushes-it.md":
        "# ADR 0081 — An edit pushes it\n",
    });
    const local = collectAdrs(dir);
    expect(
      driftFromBaseIn(local, [
        "0077-an-edit-that-changes-what-the-room-plays-pushes-it.md",
        "0077-the-poll-loop-proves-it-is-alive.md",
      ]),
    ).toEqual([]);
    // …and the escape hatch can't hide a tree that's still broken: this is what still has to pass.
    expect(collisionsIn(local)).toEqual([]);
  });

  it("names the next free number across both trees, not just this one", () => {
    // The renumber that caused #316 took "the next number I can see". 0080 was already on main.
    const dir = fixture({ "0077-mine.md": "# ADR 0077 — Mine\n" });
    expect(
      nextFreeNumber(collectAdrs(dir), [
        "0079-the-asset-push-has-more-than-one-target.md",
        "0080-deployment-is-one-pinned-commit-verified-on-every-host.md",
      ]),
    ).toBe("0081");
  });
});
