/**
 * Every class a component asks for exists in the stylesheet ([#301]).
 *
 * `styles.css` is the UI's only stylesheet, so a `className` with no matching rule is an element
 * that renders with no styling at all — and nothing caught it. Not `pnpm test` (jsdom links no
 * stylesheet and computes no geometry, so an unstyled node renders and asserts exactly like a
 * styled one), not `pnpm run review` (the components are correct in isolation; the defect is the
 * *relationship* between two files), not type-check (class names are strings). The first one found
 * was two invented classes in [#300], which fixed those two on its way past; the sweep that found
 * them turned up 51 in all, and [#301] closed the remaining 49.
 *
 * Most of them came from one commit. `b22cd38` (2026-08-06) deleted the ~1070-line legacy block as
 * the overhaul's last four screens landed, and left a comment saying "Nothing references `.page`,
 * `.btn`, `.rail` or `--amber` any more." Five components still used `.btn`; TagHelp was still
 * entirely on `.page`. Deleting rules is a *diff against the components*, and nobody had one.
 *
 * **What this does not catch.** It would not have caught the bug that prompted it. In [#300] the
 * class was `viz__video`, which is defined — it was simply the wrong class for the page it had been
 * borrowed into, and the element got styled, just wrongly. This gate answers "does every class
 * exist"; it cannot answer "is this the right class here", which needs a rendered browser (see
 * `render-ui-before-claiming-done`). Undefined classes only.
 *
 * [#300]: https://github.com/dylanleatham/Marquee/issues/300
 * [#301]: https://github.com/dylanleatham/Marquee/issues/301
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const SRC = dirname(fileURLToPath(import.meta.url));

/**
 * Classes that are deliberately never styled. Each one is a hook something *else* reads — a test
 * query, a JS selector — so an audit that re-flags it is wasting its time. Anything added here owes
 * a reason; "I couldn't be bothered to write the CSS" is not one.
 */
const UNSTYLED_HOOKS: Record<string, string> = {
  // Nothing yet. Kept so the next intentional hook has an obvious home, and so the failure message
  // below can point at a real place rather than describing one.
};

function tsxFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) tsxFiles(path, out);
    else if (path.endsWith(".tsx") && !path.endsWith(".test.tsx"))
      out.push(path);
  }
  return out;
}

/**
 * Every `className=` value in a file, as raw source text: a quoted string (re-quoted so the literal
 * scanner below sees it), or the balanced `{…}` expression. Brace-counting rather than a regex
 * because the expressions nest — `` `a${cond ? "b" : ""}` `` defeats anything non-recursive.
 */
function classNameExpressions(text: string): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(/className=/g)) {
    let i = match.index + match[0].length;
    const ch = text[i];
    if (ch === '"' || ch === "'") {
      out.push(JSON.stringify(text.slice(i + 1, text.indexOf(ch, i + 1))));
    } else if (ch === "{") {
      let depth = 0;
      let j = i;
      for (; j < text.length; j++) {
        if (text[j] === "{") depth++;
        else if (text[j] === "}" && --depth === 0) break;
      }
      out.push(text.slice(i + 1, j));
    }
  }
  return out;
}

const ANY_LITERAL = String.raw`("[^"]*"|'[^']*'|\`[^\`]*\`)`;

/**
 * The string literals inside a `className` expression that actually reach the DOM.
 *
 * Comparison operands do not: `` `svc${state === "up" ? "" : ` svc--${state}`}` `` mentions "up" as
 * a *test*, never as a class, and counting it would have this test demand a `.up` rule forever.
 * Both operand positions are dropped before scanning.
 */
function classLiterals(expression: string): string[] {
  const expr = expression
    .replace(
      new RegExp(String.raw`(?:===|!==|==|!=)\s*${ANY_LITERAL}`, "g"),
      " ",
    )
    .replace(new RegExp(`${ANY_LITERAL}\\s*(?:===|!==|==|!=)`, "g"), " ");
  return [
    ...[...expr.matchAll(/"([^"]*)"/g)],
    ...[...expr.matchAll(/'([^']*)'/g)],
    ...[...expr.matchAll(/`([^`]*)`/g)],
  ].map((m) => m[1] ?? "");
}

/** Class names used by components, each mapped to the files that use it. */
export function usedClasses(): Map<string, Set<string>> {
  const used = new Map<string, Set<string>>();
  for (const file of tsxFiles(SRC)) {
    const text = readFileSync(file, "utf8");
    const where = relative(SRC, file).replace(/\\/g, "/");
    for (const expression of classNameExpressions(text)) {
      for (const literal of classLiterals(expression)) {
        // A hole becomes whitespace, so `batch__row--${tone}` yields the fragment `batch__row--`
        // rather than a class. Those trailing fragments are the interpolation showing through; the
        // real names are `batch__row--ok` and friends, which only the stylesheet knows in full.
        for (const token of literal.replace(/\$\{[^}]*\}/g, " ").split(/\s+/)) {
          if (!/^[a-zA-Z][\w-]*$/.test(token) || /[-_]$/.test(token)) continue;
          used.set(token, (used.get(token) ?? new Set()).add(where));
        }
      }
    }
  }
  return used;
}

/** Class names the stylesheet defines. Comments are stripped first — `b22cd38`'s epitaph for the
 * legacy block names `.page` and `.btn` in prose, which would otherwise read as definitions and
 * hide the two worst offenders. */
export function definedClasses(): Set<string> {
  const css = readFileSync(join(SRC, "styles.css"), "utf8").replace(
    /\/\*[\s\S]*?\*\//g,
    " ",
  );
  return new Set(
    [...css.matchAll(/\.([a-zA-Z][\w-]*)/g)].map((m) => m[1] ?? ""),
  );
}

/** Every declaration block in the stylesheet, as `{ selector, body }`. Comments stripped first. */
export function cssRules(): Array<{ selector: string; body: string }> {
  const css = readFileSync(join(SRC, "styles.css"), "utf8").replace(
    /\/\*[\s\S]*?\*\//g,
    " ",
  );
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
    selector: (m[1] ?? "").trim().replace(/\s+/g, " "),
    body: m[2] ?? "",
  }));
}

/**
 * A flex item that has given up its `min-width` has to be able to break its own text ([#339]).
 *
 * `min-width: 0` is how a flex item is allowed to be narrower than its content — it is what makes
 * the stat band's six genre columns equal, and what stops one long service name from shoving a
 * whole row sideways. It is also the removal of the *only* thing keeping text inside the box.
 * Past that point a single unbreakable word does not widen its cell, does not clip, and does not
 * scroll: it paints straight over whatever is next to it.
 *
 * That is what shipped in the genre chart. "Electronic" spilled 16.3px out of a 34.7px column and
 * printed 4.2px of itself on top of "Rock". Sweeping the stylesheet for the same shape turned up
 * ten more, each measured spilling onto its neighbour in headless Chrome before the fix:
 * `.unmatched__what` by 199px at 300px wide, `.inflight__what` by 206px, `.batch__head h2` by 181px.
 * All eleven hold text from outside this codebase — album titles, track names, Spotify account
 * details, LLM draft text, Hue room names — so "our own strings are short" was never the guard.
 *
 * jsdom computes no geometry, so `pnpm test` renders every one of those overlaps and asserts clean
 * (see `render-ui-before-claiming-done`). What *is* checkable from here is the declaration that
 * prevents it, and this list is exhaustive by construction: every rule that says `min-width: 0`
 * either declares a break, or is named below as something that holds no text of its own.
 *
 * [#339]: https://github.com/dylanleatham/Marquee/issues/339
 */
const NO_TEXT_OF_ITS_OWN: Record<string, string> = {
  // Layout boxes. Each one's text lives in child elements with their own rules, and those children
  // are where the break belongs — declaring it here would be inherited, but it would also be a
  // claim about text this rule does not own.
  ".statband__cell": "wraps a label, a count and a caption",
  ".statband__rotator":
    "the rotating stat's button — head and body are children",
  ".tile": "an album tile: sleeve, title and byline are children",
  ".stuck__body": "wraps .stuck__title and .stuck__why",
  ".record__main": "the record page's right-hand column",
  ".lights__source": "a panel holding a label, a bar and a caption",
  ".viz__main": "the visualizer panel's stage column",
  ".tagobj": "a tag card: art plus .tagobj__body",
  ".tagobj__body": "wraps the card's own heading and lines",
  ".toast__body": "wraps .toast__title and .toast__sub",
  ".addgrid__cell": "a search result: art plus its own text children",
  ".arrival": "a row of children, none of them loose text",
  ".svc": "a service row: dot plus .svc__body",
  ".svc__body": "wraps the service name and its detail line",

  // Not text at all.
  ".statband__bar": "a bar in the chart — a coloured box, no content",
  ".record__strip span": "a colour swatch, aria-hidden",
  ".lights__source-bar span": "a colour swatch, aria-hidden",

  // The one real exception: a single-line <input> scrolls its value rather than painting outside
  // itself, so `overflow-wrap` would do nothing. Measured at 300px and 420px wide with a full
  // Spotify URL in it: 0px spill, both times.
  ".demo__uri-input":
    "an <input> — a single-line field scrolls, it never overflows",
};

const GAVE_UP_MIN_WIDTH = /min-width:\s*0/;

/**
 * Whether a rule actually keeps its text inside its own box. Values matter, not property names:
 * `word-break: keep-all` *forbids* the break, and `text-overflow: ellipsis` is a no-op unless
 * something clips, so either would sail past a check that only asked whether the property appeared.
 * There are exactly two ways out — break the line, or clip it.
 */
const canBreak = (body: string): boolean =>
  /overflow-wrap:\s*(anywhere|break-word)/.test(body) ||
  /word-break:\s*(break-all|break-word)/.test(body) ||
  /overflow:\s*hidden/.test(body);

describe("text cannot escape a flex item that gave up its min-width", () => {
  it("gives every min-width: 0 rule either a break or a reason", () => {
    const naked = cssRules()
      .filter(
        (r) =>
          GAVE_UP_MIN_WIDTH.test(r.body) &&
          !canBreak(r.body) &&
          !(r.selector in NO_TEXT_OF_ITS_OWN),
      )
      .map((r) => r.selector);

    expect(
      naked,
      "`min-width: 0` lets this item be narrower than its content, and nothing else here stops " +
        "the content painting over its neighbour. Add `overflow-wrap: anywhere` if it holds text (or " +
        "clip it with `overflow: hidden`) — or, if it only holds child elements, add it to " +
        "NO_TEXT_OF_ITS_OWN with the reason.",
    ).toEqual([]);
  });

  it("keeps the list honest — an entry that grew a break rule is no longer text-free", () => {
    const contradicted = cssRules()
      .filter((r) => r.selector in NO_TEXT_OF_ITS_OWN && canBreak(r.body))
      .map((r) => r.selector);
    expect(contradicted).toEqual([]);
  });

  it("keeps the list honest — an entry no rule declares is dead", () => {
    const selectors = new Set(cssRules().map((r) => r.selector));
    expect(
      Object.keys(NO_TEXT_OF_ITS_OWN).filter((s) => !selectors.has(s)),
    ).toEqual([]);
  });

  it("still recognises the shape it is guarding — the genre chart's labels", () => {
    const label = cssRules().find((r) => r.selector === ".statband__bar-label");
    expect(label, ".statband__bar-label is gone or renamed").toBeDefined();
    expect(GAVE_UP_MIN_WIDTH.test(label!.body)).toBe(true);
    expect(canBreak(label!.body)).toBe(true);
  });
});

describe("styles.css covers the classes components use", () => {
  it("defines every class name reached from a .tsx", () => {
    const defined = definedClasses();
    const orphans = [...usedClasses()]
      .filter(([cls]) => !defined.has(cls) && !(cls in UNSTYLED_HOOKS))
      .map(
        ([cls, files]) => `.${cls} — used by ${[...files].sort().join(", ")}`,
      )
      .sort();

    expect(
      orphans,
      "These classes render nothing. Either write the rule in styles.css, drop the class from the " +
        "component, or — if it is a hook for a test or a JS selector — add it to UNSTYLED_HOOKS " +
        "with the reason.",
    ).toEqual([]);
  });

  it("keeps the allowlist honest — an entry that gained a rule is no longer a hook", () => {
    const defined = definedClasses();
    expect(
      Object.keys(UNSTYLED_HOOKS).filter((cls) => defined.has(cls)),
    ).toEqual([]);
  });

  it("keeps the allowlist honest — an entry nothing uses is dead", () => {
    const used = usedClasses();
    expect(Object.keys(UNSTYLED_HOOKS).filter((cls) => !used.has(cls))).toEqual(
      [],
    );
  });
});
