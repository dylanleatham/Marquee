import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
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

const adrs: Adr[] = readdirSync(adrDir)
  .filter((f) => /^\d{4}-.*\.md$/.test(f))
  .sort()
  .map((file) => ({
    file,
    number: file.slice(0, 4),
    heading: readFileSync(join(adrDir, file), "utf8")
      .split("\n")
      .find((l) => l.startsWith("# "))
      ?.match(/^# ADR (\d{4})\b/)?.[1],
  }));

describe("ADR numbering", () => {
  it("finds the ADRs (so a bad path can't make this suite vacuously pass)", () => {
    expect(adrs.length).toBeGreaterThan(30);
  });

  it("allocates each number to exactly one decision", () => {
    const byNumber = new Map<string, string[]>();
    for (const adr of adrs) {
      byNumber.set(adr.number, [...(byNumber.get(adr.number) ?? []), adr.file]);
    }
    // Name both files: the fix is a rename plus a citation sweep, and you need to know which two.
    const collisions = [...byNumber.entries()]
      .filter(([, files]) => files.length > 1)
      .map(([number, files]) => `${number}: ${files.join(" and ")}`);
    expect(collisions).toEqual([]);
  });

  it("gives every ADR a `# ADR NNNN` heading that matches its filename", () => {
    const mismatched = adrs
      .filter((a) => a.heading !== a.number)
      .map((a) => `${a.file} → heading says ${a.heading ?? "(none)"}`);
    expect(mismatched).toEqual([]);
  });

  // The other half of "citable": a link that names the right ADR but can't be followed is no better
  // than an ambiguous number. Renaming a file is exactly what breaks these, so it belongs next to
  // the uniqueness check. It found one already-broken relative path the first time it ran.
  it("resolves every link that points at an ADR file", () => {
    const repoRoot = join(adrDir, "..", "..");
    const sources = [
      ...walk(join(repoRoot, "docs"), [".md"]),
      ...walk(join(repoRoot, "packages"), [".ts", ".tsx"]),
      join(repoRoot, "CLAUDE.md"),
    ];
    const broken: string[] = [];
    for (const file of sources) {
      const text = readFileSync(file, "utf8");
      for (const [, href] of text.matchAll(
        /\]\(([^)]*adrs\/\d{4}-[^)]+\.md)\)/g,
      )) {
        if (!existsSync(join(dirname(file), href))) {
          broken.push(`${file.slice(repoRoot.length + 1)} → ${href}`);
        }
      }
    }
    expect(broken).toEqual([]);
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
