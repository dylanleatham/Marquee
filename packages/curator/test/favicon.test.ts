// The favicon is generated from the Marquee mark (ADR 0091), and generated files rot: change the
// mark, forget to re-run the generator, and the icon quietly stays the old one. Nothing in CI runs
// the generator, so the freshness check has to be a test.
//
// Scope, so this is not read as contradicting curator-ui-ux §2: the packaged app has no browser
// tab and takes its window icon from Electron. This file serves the dev server on :4738 and :4739
// opened directly in a browser.
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";

// Imported via a variable so tsc doesn't try to type the plain-JS .mjs generator script.
const modPath = "../scripts/make-favicon.mjs";

const load = async () =>
  (await import(modPath)) as {
    buildFavicon: (markSource?: string) => string;
    assertXmlComments: (svg: string) => string;
    MARK_SVG: string;
    FAVICON_SVG: string;
  };

describe("favicon", () => {
  it("is committed, and matches what the generator produces from the mark", async () => {
    const { buildFavicon, FAVICON_SVG } = await load();
    expect(existsSync(FAVICON_SVG)).toBe(true);
    // If this fails, the mark changed and the favicon didn't:
    //   pnpm --filter @marquee/curator favicon
    expect(readFileSync(FAVICON_SVG, "utf8")).toBe(buildFavicon());
  });

  it("is well-formed XML, which an SVG served as a file has to be", async () => {
    // Structural check: unclosed tags, stray angle brackets, a bad root element.
    const { buildFavicon } = await load();
    const { JSDOM } = await import("jsdom");
    const { DOMParser } = new JSDOM().window;

    const doc = new DOMParser().parseFromString(
      buildFavicon(),
      "image/svg+xml",
    );
    expect(doc.querySelector("parsererror")?.textContent ?? null).toBeNull();
    expect(doc.documentElement.tagName).toBe("svg");
  });

  it("rejects an XML comment the browser would choke on", async () => {
    // Regression, found by opening the file in a browser rather than by reading it: the generated
    // header once said "pnpm --filter …", and XML forbids `--` inside a comment. Chromium rendered
    // the parser error where the icon should have been. Every string assertion still passed, and
    // jsdom's DOMParser above is too lenient to see it — so the rule is asserted directly, and the
    // generator runs the same guard over its own output.
    const { assertXmlComments, buildFavicon } = await load();

    expect(() =>
      assertXmlComments("<svg><!-- pnpm --filter x --></svg>"),
    ).toThrow(/must not contain "--"/);
    // `<!-- trailing--->` — the body ends with `-` butted against the close, which XML also bans.
    expect(() => assertXmlComments("<svg><!-- trailing---></svg>")).toThrow(
      /must not end with "-"/,
    );
    expect(() => assertXmlComments("<svg><!-- fine --></svg>")).not.toThrow();
    // A hyphen mid-body, and one with whitespace before the close, are both legal.
    expect(() =>
      assertXmlComments("<svg><!-- well-formed enough --></svg>"),
    ).not.toThrow();
    // And the real thing passes its own guard.
    expect(() => buildFavicon()).not.toThrow();
  });

  it("reuses the mark's path data rather than restating it", async () => {
    const { buildFavicon, MARK_SVG } = await load();
    // The point of generating it: the shapes are the mark's, verbatim. A favicon that merely looked
    // similar would be a second logo to maintain.
    const mark = readFileSync(MARK_SVG, "utf8");
    const markPaths = [...mark.matchAll(/<path[^>]*\sd="([^"]+)"/g)].map(
      (m) => m[1],
    );
    const favicon = buildFavicon();

    expect(markPaths.length).toBeGreaterThan(0);
    for (const d of markPaths) expect(favicon).toContain(`d="${d}"`);
  });

  it("carries its own colours, because a standalone icon inherits nothing", async () => {
    const { buildFavicon } = await load();
    const favicon = buildFavicon();
    expect(favicon).toContain('fill="#17150f"'); // the tile — --pp-ink
    expect(favicon).toContain('fill="#f2efe8"'); // the mark — --pp-paper
    expect(favicon).not.toContain("currentColor");
  });

  it("is referenced by the page that needs it", async () => {
    const { fileURLToPath } = await import("node:url");
    const { resolve, dirname } = await import("node:path");
    const html = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), "../ui/index.html"),
      "utf8",
    );
    // Vite copies ui/public/* to the root of dist-ui, so the served path is /favicon.svg.
    expect(html).toMatch(
      /<link rel="icon" type="image\/svg\+xml" href="\/favicon\.svg" ?\/>/,
    );
  });

  it("refuses a mark it cannot read, rather than emitting a bare tile", async () => {
    const { buildFavicon } = await load();
    // Both failures would otherwise yield a perfectly valid SVG of an empty ink square — a favicon
    // that looks deliberate and says nothing.
    expect(() => buildFavicon('<svg><path d="M0,0Z"/></svg>')).toThrow(
      /no viewBox/,
    );
    expect(() => buildFavicon('<svg viewBox="0 0 10 10"></svg>')).toThrow(
      /no paths/,
    );
  });
});
