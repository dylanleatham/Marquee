# ADR 0032 — A refused card-art generation retries once without the cover reference

Status: accepted · Date: 2026-07-27 · Amends: [curator-spec §Card art](../specs/curator-spec.md),
[ADR 0031](0031-card-art-cover-reference-image.md) (the reference is now conditional on Gemini
accepting it) · Closes: [#152](https://github.com/dylanleatham/Marquee/issues/152)

## Context

[ADR 0021](0021-card-art-five-option-prompt-strategy.md) makes Option 1 "The Cover Reimagining" a
**direct** landscape adaptation of the front cover, "emphasizing its exact color palette, key
subject, and authentic visual medium". [ADR 0031](0031-card-art-cover-reference-image.md) then
attaches the **real cover image** to exactly that variant, so the model re-renders the sleeve instead
of reconstructing it from the album's name.

Together they ask a model to closely reproduce a specific, real, copyrighted album cover while
handing it that cover. Observed on the first real album run:

```
Gemini blocked the image request (IMAGE_RECITATION)
```

`IMAGE_RECITATION` is a **recitation** refusal — the model declining to reproduce memorized or
copyrighted material — not a safety refusal. (It was only legible as a refusal at all because of
[#149](https://github.com/dylanleatham/Marquee/issues/149); before that it surfaced as "Gemini
returned no image data", which reads like an API fault.)

Two things were wrong beyond the refusal itself:

1. **It was terminal.** No recovery, despite an obvious lever.
2. **It was silent.** `generateCardArtSet` inspected rejected results only when _every_ variant
   failed, and the all-failed branch returned before any save — so a partial run left unexplained
   gaps in the gallery, and a total failure recorded nothing at all.

## Decision

**On a refusal, retry the generation once with the cover reference removed** — and only when a
reference was actually sent.

- **Exactly one retry.** Not a loop, not a backoff schedule. There is one lever; pull it once.
- **Only when there is a lever.** A variant that carried no reference would produce an identical
  second request, so we don't spend the call.
- **Only for refusals.** A 5xx, a timeout, or a cancellation rethrows untouched — those are not
  evidence that the reference was the problem. The distinction rides on the typed
  `GeminiError.refusal` field from #149, not on matching an error message.
- **Record both outcomes.** A candidate that succeeded only after the drop is marked
  `coverReferenceDropped`; a variant refused on both attempts becomes a `CardArtRefusal` carrying
  index, nudge, and Gemini's verbatim reason. Both surface in the UI.

## Consequences

- ADR 0031's reference attachment becomes **best-effort**: the cover is offered, and a refusal
  degrades that variant to text-only rather than losing it. Option 1 then produces an image in the
  album's visual language that does not closely re-render the sleeve — which is why the candidate is
  marked rather than silently swapped.
- A refused variant is now visible with its reason, including the all-refused case.
- **ADR 0021's Option 1 stands as written.** Softening "direct adaptation… exact color palette" was
  considered and declined by the repo owner: the refusal is **intermittent**, not systematic — most
  albums generate the anchored option fine — so weakening the prompt for every album to avoid a
  refusal that affects some of them trades a real loss for an occasional one. The retry is therefore
  the settled answer here, not a stopgap pending a prompt rewrite.
- This also covers the case that motivated [PR #82](https://github.com/dylanleatham/Marquee/pull/82)
  (a portrait cover tripping a person-safety refusal): dropping the reference is the same correct
  move, since the reference is what carries a face. #82's blanket no-people guardrail stays parked —
  the refusal we can actually observe is about copyright, not people.

## Alternatives considered

- **Never attach the cover.** Throws away ADR 0031 for every album to fix the minority that get
  refused.
- **Retry with a reworded prompt.** A guess. Recitation is specifically about reproducing the
  reference; removing it is the targeted change.
- **Retry with backoff, several times.** A refusal is deterministic — the same request refused twice
  will refuse a third time. Retrying an unchanged request would only burn quota.

## Note on numbering

Taken as 0032, the next free number at the time of writing.
[#151](https://github.com/dylanleatham/Marquee/issues/151) proposes renumbering the duplicate
0022/0023 ADRs into 0032/0033; those targets shift to 0033/0034.
