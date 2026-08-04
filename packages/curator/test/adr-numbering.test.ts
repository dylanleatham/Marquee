import { describe, it, expect, afterAll } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

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
// The checks are extracted as functions rather than inlined so they can be run against fixture
// directories below. A gate whose whole job is to fail loudly should be shown failing: every
// assertion here is `toEqual([])`, which passes just as happily if the detection is broken and
// silently returns nothing. "It's green" and "it works" are different claims.
const adrDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "docs",
  "adrs",
);

interface Adr {
  file: string;
  number: string;
  heading: string | undefined;
}

/** The ADRs in `dir` — numbered filenames only, sorted, each paired with its heading number. */
function collectAdrs(dir: string): Adr[] {
  return readdirSync(dir)
    .filter((f) => /^\d{4}-.*\.md$/.test(f))
    .sort()
    .map((file) => ({
      file,
      number: file.slice(0, 4),
      heading: readFileSync(join(dir, file), "utf8")
        .split("\n")
        .find((l) => l.startsWith("# "))
        ?.match(/^# ADR (\d{4})\b/)?.[1],
    }));
}

/** Numbers claimed by more than one ADR. Empty = each number names exactly one decision. */
function collisionsIn(adrs: Adr[]): string[] {
  const byNumber = new Map<string, string[]>();
  for (const adr of adrs) {
    byNumber.set(adr.number, [...(byNumber.get(adr.number) ?? []), adr.file]);
  }
  // Name both files: the fix is a rename plus a citation sweep, and you need to know which two.
  return [...byNumber.entries()]
    .filter(([, files]) => files.length > 1)
    .map(([number, files]) => `${number}: ${files.join(" and ")}`);
}

/** ADRs whose `# ADR NNNN` heading disagrees with their filename — a half-finished renumber. */
function headingMismatchesIn(adrs: Adr[]): string[] {
  return adrs
    .filter((a) => a.heading !== a.number)
    .map((a) => `${a.file} → heading says ${a.heading ?? "(none)"}`);
}

/** ADR links in `files` whose target doesn't exist, relative to the linking file. */
function brokenAdrLinksIn(files: string[], root: string): string[] {
  const broken: string[] = [];
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    for (const [, href] of text.matchAll(
      /\]\(([^)]*adrs\/\d{4}-[^)]+\.md)\)/g,
    )) {
      if (!existsSync(join(dirname(file), href))) {
        broken.push(`${file.slice(root.length + 1)} → ${href}`);
      }
    }
  }
  return broken;
}

/**
 * ADR links in `files` whose label names a different ADR than the file it points at.
 *
 * The other half of the citability problem, and the one a resolving link hides: issue #233 found
 * thirteen Discogs comments citing "ADR 0016" (Stylus) when they meant 0017 — both accepted the same
 * day. Converting those to links is what puts them under `brokenAdrLinksIn`, but a link is only as
 * honest as its label: `[ADR 0016](…/0017-*.md)` resolves perfectly and still tells the reader the
 * wrong thing. A bare number can't be checked at all; a link can, so check it.
 */
function labelHrefMismatchesIn(files: string[], root: string): string[] {
  const mismatched: string[] = [];
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    for (const [, label, href] of text.matchAll(
      /\[ADR (\d{4})\]\(([^)]*adrs\/(\d{4})-[^)]+\.md)\)/g,
    )) {
      const target = href.match(/adrs\/(\d{4})-/)?.[1];
      if (label !== target) {
        mismatched.push(
          `${file.slice(root.length + 1)} → [ADR ${label}](${href})`,
        );
      }
    }
  }
  return mismatched;
}

/** Every source the citation checks scan: docs, TS/TSX under packages, and the working agreement. */
function citingSources(repoRoot: string): string[] {
  return [
    ...walk(join(repoRoot, "docs"), [".md"]),
    ...walk(join(repoRoot, "packages"), [".ts", ".tsx"]),
    join(repoRoot, "CLAUDE.md"),
  ];
}

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
});

// --- proof that the checks above actually fail -------------------------------------------------
//
// Each case is the real thing that happened (or nearly did): 0022/0023/0026 allocated twice, a
// rename that left the heading behind, and a link left pointing at the old filename.

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
 * `brokenAdrLinksIn`'s own regex when it walks `packages/**` — this file would fail its own check,
 * the same self-scan problem `scripts/check-conflict-markers.mjs` solves by building its markers
 * from `repeat()` rather than typing them out.
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

/** Every file under `dir` with one of `exts`, skipping build output and dependencies. */
function walk(dir: string, exts: string[]): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith("dist"))
      continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, exts));
    else if (exts.some((e) => entry.name.endsWith(e))) out.push(full);
  }
  return out;
}
