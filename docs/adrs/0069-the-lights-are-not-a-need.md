# ADR 0069 — The lights are not a need; they are a section you can visit

Status: accepted · Date: 2026-08-10 · Amends:
[curator-ui-ux.md](../specs/curator-ui-ux.md) (§5 the record page — three needs, two optional tabs),
[curator-spec.md](../specs/curator-spec.md) (§ scope — "the four things a record still needs"),
[roadie-spec.md](../specs/roadie-spec.md) (§ the human steps),
[design_handoff_curator_overhaul/README.md](../design_handoff_curator_overhaul/README.md) (§2, §the
record) ·
Supersedes the `lights` row of [ADR 0056](0056-need-labels-name-the-act-not-the-artifact.md) (the
label, now that the need it named is gone) ·
Narrows [ADR 0052](0052-curator-is-three-places-not-a-nine-state-queue.md) (four needs → three) ·
Relates: [ADR 0058](0058-a-demo-tag-plays-one-chosen-track.md) (the first tab that is not a need —
the precedent this follows), [ADR 0063](0063-the-machine-is-settled-from-the-asset-not-driven-by-the-button.md)
(sign-off is settled from the asset), [ADR 0070](0070-the-collection-filters-by-what-a-record-owes.md)
(the chips that made the emptiness of this need obvious)

## Context

[ADR 0052](0052-curator-is-three-places-not-a-nine-state-queue.md) gave a record four needs — lights,
a visualizer, a card, tags — as independent predicates, so they could be done in any order. `lights`
was true when `previewApprovedAt` was set, which happens only when a human opens the room, watches
the palette wash a real wall, and presses **Looks right**.

[ADR 0056](0056-need-labels-name-the-act-not-the-artifact.md) already caught that this read wrong. On
a 482-record collection the label `NEEDS LIGHTS` sent the maintainer hunting a broken pipeline while
458 of those records held a full four-colour palette. The fix was to rename the label to
`NEEDS A LOOK` — name the act, not the artifact.

**That fixed the sentence and left the claim.** Renaming it made the tile honest about _what_ was
outstanding without asking whether it should be outstanding at all. It is outstanding on every record
nobody has individually sat and watched, which on a collection this size is very nearly all of them,
forever. A need that never clears is not a worklist item; it is a permanent decoration. It also made
NOT COMPLETE — the collection's headline number, and the thing you look at to decide what to do
next — mean "records I have not personally watched" rather than "records that are missing something".

The maintainer's own account of how the lights actually work settles it:

> Roadie sets lights and those get used by the system automatically without me having to sign off. I
> can modify them, but they'll only ever be empty when they are first added before Roadie gets to
> them.

That is the whole argument. The system does not wait for approval to use a palette, so approval
gates nothing. And the one genuinely lightless window — before Roadie reaches the record — is
already covered by a different state: such a record reads as **Roadie is on it**. A record whose
sleeve has too little colour to light a room fails to `palette_insufficient` and reads as **stuck**,
with a sentence telling you to pick the lights by hand. Both cases were already visible without the
need. The need was adding nothing but noise.

## Decision

**`lights` stops being a `Need` and becomes a `RecordSection` — exactly what
[ADR 0058](0058-a-demo-tag-plays-one-chosen-track.md) did for the demo cut.**

```ts
export type Need = "visualizer" | "card" | "tags";
export type RecordSection = Need | "lights" | "demo";
export const SECTION_ORDER: RecordSection[] = ["lights", ...NEED_ORDER, "demo"];
```

### 1. The tab stays, and leads the strip

You can still open the lights, see the palette, reorder it, pick a different source and edit hexes.
Nothing about the panel changes. It renders through the branch the demo cut already used: no `●`/`○`
glyph, screen-reader text "optional". It stays **first** because the lights are the first thing you
look at on a record — not because anything waits on them.

The two non-needs now bracket the strip. That is a coincidence of reading order, not a pattern; the
`Need` / `RecordSection` split is what carries the meaning, and it stays two types rather than one
type with a flag.

### 2. Sign-off survives, and clears nothing

**Looks right** stays in the room and still writes `verification.previewApprovedAt`. It is a record
that you watched this one and liked it — worth keeping, and the room is still the only place it can
honestly be pressed. It simply no longer holds a record back from READY.

The server is untouched. `settleNeeds` still reads `previewApprovedAt` to move the machine from
`awaiting_preview` to `awaiting_tag_write` ([ADR 0063](0063-the-machine-is-settled-from-the-asset-not-driven-by-the-button.md)),
which is the linear machine the UI deliberately does not show. `lightsDone` and
`NeedFacts.previewApprovedAt` are deleted from the UI derivation only.

### 3. The ready toast moves to the record page

It fired from the room's approve button, on the check "was that the last need?". With the lights not
a need, that check could only ever have passed on a record that was **already** complete — so it
would have thrown a "ready!" toast at a no-op and then navigated you off the screen.

The three remaining needs are all cleared by the record page's panels, and every one of those ends in
the same `refresh()`. So the toast now fires from a watcher on the record page's polled asset, on the
**transition** from some needs outstanding to none. Firing on the transition rather than the state is
what keeps it from celebrating a record that was finished when you opened it, or re-firing every
three seconds with the poll. It also catches a card attached in another tab, which the old
button-shaped trigger could not.

## Consequences

- **NOT COMPLETE now counts records that are actually missing an artifact.** On the maintainer's
  collection this is the difference between a number that was almost the size of the library and one
  that is a to-do list. This, not the tidiness, is the point.
- A record with a palette Roadie derived and nobody has watched now reads **READY**, and will go on
  the stand. That is the intended behaviour and the main thing to disagree with if this is ever
  revisited: the bet is that Roadie's palettes are good enough to use unwatched, which is already
  what the running system does — sign-off never gated the room.
- `needs.test.ts` keeps the boundary, not the membership: `isNeedSection("lights")` is false,
  `NEED_ORDER` does not contain `"lights"`, and a record with no sign-off and everything else done
  is `{ kind: "ready" }`. A future change that quietly makes it a need again fails.
- The `Record` page gains its first `useEffect` with a ref, for the toast watcher. It is covered both
  ways — fires on the transition, silent on a record that was already finished.
- ADR 0056's wider lesson survives its own example: **a label is a claim.** This ADR is the same
  lesson one level up — a _need_ is a claim too, and renaming one is not the same as checking whether
  it is true.

## What this does not change

The palette pipeline, the lights panel, the room, `previewApprovedAt`, or the machine's linear human
path. Roadie still derives a palette within seconds of a record landing, the room still washes with
it, and you can still sign one off. The only thing that changed is whether not having done so counts
against the record.
