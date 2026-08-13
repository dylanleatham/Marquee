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
