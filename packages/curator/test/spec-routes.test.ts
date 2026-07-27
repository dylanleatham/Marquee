import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Issue #106's "done when", made executable: every route in Curator's spec exists, and every route
// that exists is documented.
//
// That property held once, drifted, and was reconciled by hand twice — the 2026-07-25 audit and
// again here. Hand-auditing 86 routes doesn't scale and doesn't repeat, and the drift is silent:
// a spec row for a route nobody implemented reads exactly like one for a route that works. The
// audit that found this round's drift is the test.
//
// Curator only. Each service owns the contract with its own spec, so if Conductor or Backdrop want
// this, it belongs in their test dirs, not in a cross-service checker here.
const repoRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
);
const SERVER = join(repoRoot, "packages", "curator", "src", "server.ts");
const SPEC = join(repoRoot, "docs", "specs", "curator-spec.md");

const VERBS = ["get", "post", "put", "delete", "patch"] as const;

/** Drop a query string and any trailing slash, so `/api/jobs?kind=x` and `/api/jobs` compare equal. */
const normalize = (path: string): string =>
  path.split("?")[0]!.replace(/\/+$/, "") || "/";

/**
 * Routes Fastify actually serves.
 *
 * The generic-parameter form matters: `app.delete<{ Params: { uri: string } }>("/x", …)` is a real
 * registration, and a regex that misses it reports a documented route as a phantom. An earlier
 * draft of this audit did exactly that and produced two false findings.
 */
function implementedRoutes(): Set<string> {
  const src = readFileSync(SERVER, "utf8");
  const pattern = new RegExp(
    String.raw`\.(${VERBS.join("|")})\s*(?:<[^>]*>)?\s*\(\s*"([^"]+)"`,
    "g",
  );
  const routes = new Set<string>();
  for (const [, verb, path] of src.matchAll(pattern)) {
    routes.add(`${verb!.toUpperCase()} ${normalize(path!)}`);
  }
  return routes;
}

interface SpecRoutes {
  /** Rows presented as live API. */
  live: Set<string>;
  /** Rows struck through — a documented decision *not* to have the route. */
  retired: Set<string>;
}

/** Routes the spec's markdown tables claim, split by whether the row is struck through. */
function specRoutes(): SpecRoutes {
  const live = new Set<string>();
  const retired = new Set<string>();
  for (const line of readFileSync(SPEC, "utf8").split("\n")) {
    if (!line.trim().startsWith("|")) continue;
    const cells = line
      .trim()
      .replace(/^\||\|$/g, "")
      .split("|");
    if (cells.length < 2) continue;
    const rawVerb = cells[0]!.trim();
    const rawPath = cells[1]!.trim();
    const verb = rawVerb.replace(/~~/g, "").trim().toUpperCase();
    if (!VERBS.some((v) => v.toUpperCase() === verb)) continue; // header/separator/prose rows
    const path = normalize(rawPath.replace(/~~/g, "").trim().replace(/`/g, ""));
    const entry = `${verb} ${path}`;
    if (rawVerb.includes("~~") || rawPath.includes("~~")) retired.add(entry);
    else live.add(entry);
  }
  return { live, retired };
}

describe("curator-spec.md route tables match the server", () => {
  const implemented = implementedRoutes();
  const { live, retired } = specRoutes();

  it("parses both sides (so a broken regex can't make this vacuously pass)", () => {
    expect(implemented.size).toBeGreaterThan(50);
    expect(live.size).toBeGreaterThan(50);
  });

  it("documents no route that doesn't exist", () => {
    // A bare promise in a table is the worse half of drift: it reads as a working endpoint. Either
    // build it, or strike the row through with the reason — `~~GET~~ | ~~`/x`~~` is the house style
    // and this test treats a struck row as a deliberate decision rather than a lie.
    expect([...live].filter((r) => !implemented.has(r)).sort()).toEqual([]);
  });

  it("documents every route that does exist", () => {
    expect([...implemented].filter((r) => !live.has(r)).sort()).toEqual([]);
  });

  it("has no struck-through row for a route that is in fact implemented", () => {
    // The reverse rot: a route gets built and the "never implemented" note is left behind.
    expect([...retired].filter((r) => implemented.has(r)).sort()).toEqual([]);
  });
});
