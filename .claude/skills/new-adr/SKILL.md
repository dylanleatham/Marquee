---
name: new-adr
description: Write a new ADR in Marquee and take its number safely. Use when recording an architecture decision, when code needs to deviate from a spec, or whenever you are about to create a file under docs/adrs/.
user-invocable: true
---

# Writing an ADR

## Take the number from the guard, never from `ls`

**Four collisions have shipped in this repo** ([#151](https://github.com/dylanleatham/Marquee/issues/151),
[#316](https://github.com/dylanleatham/Marquee/issues/316), and two more), and the fourth was created
by the renumber that fixed the third. `ls docs/adrs/` shows **your branch**, and your branch is not
the allocation — `origin/main` is, and it moves while you work.

```bash
git fetch origin
node -e "import('./scripts/check-adr-numbers.mjs').then(m=>{const l=m.collectAdrs('docs/adrs');const b=m.baseAdrFiles(process.cwd())??[];console.log('next free:',m.nextFreeNumber(l,b))})"
```

That reads `origin/main` as well as your tree. `pnpm run check:adrs` reports collisions but prints
the next free number only when something is already wrong, which is why the call above exists.

If someone lands your number first, **you renumber, not them** — the number belongs to whichever
decision published it on `main` first. And never re-slug or delete an ADR `main` has published;
supersede it, because citations outside this repo cannot be swept.

## The file

`docs/adrs/NNNN-a-sentence-about-the-decision.md`, and the `# ADR NNNN` heading **must match the
filename** — a test enforces it.

```markdown
# ADR NNNN — What was decided

**Date:** YYYY-MM-DD
**Status:** Accepted
**Supersedes:** nothing, or a link. Name the specs this amends.
**Issues:** links, if any.

## Context

What was true that made this necessary. Include the measurement or the incident — an ADR whose
context is an opinion is not worth citing later.

## Decision

What was decided, in the present tense. Name the alternative you rejected and why; that is the part
future readers need and the part that is always missing.

## Consequences

What this costs, what it forecloses, and what is now load-bearing. Be honest about the weaknesses —
an ADR that only lists benefits reads as advocacy and gets ignored.
```

Cite other ADRs as a **link**, never a bare number: `[ADR 0085](0085-….md)`. Both the label and the
href are checked, and a label naming a different decision than the file it points at is a failure.

## In the same PR

- **Update the spec the decision amends.** `docs/specs/*.md` is the source of truth; a dated note
  pointing at the ADR is enough. A spec that lies is worse than no spec.
- **Grep for other copies of what you just changed.** Documentation fact-drift is the
  highest-frequency escaped defect class in this repo. `spec-adherence` reviews for it, but it
  detects about half the time, so do the grep.
- Run `node scripts/check-adr-numbers.mjs` before pushing. `pre-push` runs it unfiltered and will
  reject a collision against `origin/main`.
