# ADR 0084 — Your own cover is a palette control, so it goes back on the Lights panel

Status: accepted · Date: 2026-08-13 · Amends:
[curator-ui-ux.md](../specs/curator-ui-ux.md) (§5.0 the Lights panel — the actions row, and the
"not to be reinstated" list) ·
Reverses one item of [ADR 0052](0052-curator-is-three-places-not-a-nine-state-queue.md) (the artwork
override's removal from the Look station; everything else it dropped stays dropped) ·
Relates: [ADR 0030](0030-palette-from-album-feeling.md) (the other place a palette can come from),
[ADR 0081](0081-an-edit-that-changes-what-the-room-plays-pushes-it.md) (this route already ★syncs to
the runtime), [ADR 0038](0038-curator-pushes-media-over-http.md) (the strip idiom the upload borrows)

## Context

The server has been able to take a cover of your own since 2026-07-25
([#100](https://github.com/dylanleatham/Marquee/issues/100)):
`POST /api/albums/:curatorId/artwork/override` writes the file, makes it the album's **active**
cover, and re-derives the palette from it. It is fully specified in curator-spec §API, fully tested
in `artwork-override.test.ts`, it honours curator-spec §12's hand-edit rule, and
[ADR 0081](0081-an-edit-that-changes-what-the-room-plays-pushes-it.md) later taught it to push the
result to the runtime. `DELETE` on the same route reverts it.

Nothing has been able to call it since 2026-08-06. The overhaul replaced the five-station rail with
three places, and the Look station's leftovers were listed for removal in one line:

> Dropped from the old Look station and **not** to be reinstated: the artwork override, the source
> badge, the genre tags, and the raw `{"transitionMs":…,"holdMs":…}` JSON.

**Three of those four belong together and the fourth does not.** The source badge, the genre tags and
the raw JSON are all ways of _displaying_ a palette — chrome that told you about colours you could
already see. The cover is not a display of anything. It is the palette's **input**: Palette Press
reads it, and card art and video generation reference it. Grouping it with the chrome was a
classification error, and the consequence is a screen that offers two answers to "these colours are
wrong" — re-extract, or pick the feeling palette — while the third and most direct one, _the picture
it extracted from is a bad scan_, has no control at all.

The route being live the whole time is what makes this a gap rather than a feature request. A
maintainer with a muddy Discogs scan can fix it with `curl` and cannot fix it in Curator.

## Decision

**`UPLOAD A DIFFERENT COVER` goes in the Lights panel's actions row, immediately right of
`BACK TO ROADIE'S ORIGINAL`.** Not a tab, not the sidebar, not the Card panel: beside the two
controls that re-derive a palette, because standing in front of the colours is where you find out
the sleeve they came from is wrong.

### 1. The dialog curator-spec §12 already specified

§12 has said since the override was built that the app asks — "You have a hand-edited palette.
Regenerate with new art?" — and the server's POST default encodes the same rule (regenerate, _unless_
the palette is hand-edited). The panel now asks it, with both answers going through with the cover
change: `PULL NEW COLOURS` / `KEEP MY COLOURS`. There is no Cancel, because there is no version of
this where the cover does not change; the question is only what happens to the colours.

Dismissals — Escape, the scrim — resolve to **keep**. That is the side that loses nothing, and a safe
default you have to remember to choose is not a default.

A palette nobody has touched skips the dialog entirely. Re-deriving is the whole reason you uploaded
a cover, and a confirmation that protects nothing just teaches people to click through confirmations.

### 2. The way back ships in the same change

`USE THE COVER ROADIE FOUND` appears **only** while an override is in force, and calls the `DELETE`
that has been sitting there unused. Shipping the upload without it would make a one-way door out of a
reversible operation — the fetched cover is never deleted, so the only thing standing between the
user and their original state would have been a missing button.

It asks the same §12 question, and this is where the two routes differ in a way the caller has to
carry: **`DELETE` re-derives whether or not the palette was hand-edited.** The POST protects the
hand-edit server-side; the DELETE takes `?regeneratePalette=false` and otherwise regenerates. Rather
than change a shipped route's default, the client passes the answer explicitly on both paths, and
`api.removeArtworkOverride` says so where the next caller will read it.

### 3. Two sentences stop claiming "the sleeve"

With an override in force, `FROM THE SLEEVE` is naming a cover the record is not using, and
`BACK TO ROADIE'S ORIGINAL` — which re-extracts from the _active_ cover — becomes the only thing on
screen still promising the one Roadie found. So the source card reads `FROM YOUR COVER`, and a second
reassurance line says the override is in force and that Roadie's cover was never deleted.

This is the panel's existing rule applied to a new state, not a new rule: it is the same reason the
feeling palette's card says `· IN USE` rather than leaving you to infer it, and the same reason
`+ ADD A LIGHT` disables itself with a sentence instead of failing at eight.

### 4. The upload gets the strip, not a spinner

`api.uploadArtworkOverride` moves from `fetch` to `postForm`, so the panel can show the `UploadStrip`
the card and the visualizer show ([#284](https://github.com/dylanleatham/Marquee/issues/284)). A
cover is a small file and the transfer is rarely the wait — Palette Press re-extracting on the far
side is — which is exactly what the strip's second state ("Adding <name> to the record…") is for. The
card panel already made this call for the same reason: one answer for "a file is going up" beats two.

## Consequences

- **The Lights panel now has four actions and the row wraps.** `.lights__actions` gains
  `flex-wrap` and a tighter row gap. Four labels this long overflow the panel's 820px on a narrow
  window, and a control pushed off the edge is a control that is not there.
- **A cover swap cancels the debounced autosave.** This is the one genuine race the change
  introduces: an edit still inside the 700ms window would otherwise `PUT` the old colours on top of
  the palette the server has just derived from the new cover — an edit that looks saved and a cover
  swap that looks ignored, from one timer. `uploadCover` and `dropCover` clear it exactly as `choose`
  does, and a test holds it.
- **The "not to be reinstated" list is now three items, and stays a list.** The other three were
  correctly cut and this ADR does not reopen them. What it retires is the reasoning that put a
  palette input in a bin labelled "palette chrome" — worth stating, because the same slip is
  available on any screen where an artifact's _source_ sits next to its presentation.
- **No new server surface** — no route, no schema, no migration. But building the screen is what
  finally exercised the routes, and it found them broken:
  [#319](https://github.com/dylanleatham/Marquee/issues/319), where `buildServer` never gave
  `actionDeps` a palette generator, so the re-derive step of both artwork-override routes — along
  with BACK TO ROADIE'S ORIGINAL and the library sweep — answered "palette generator isn't
  available" in the shipped app. Fixed in the same branch. That is the real lesson of the four
  months this route spent uncallable: **an endpoint with no caller is not a working endpoint**, and
  the tests that covered it all injected the dependency production forgot to.
- The ★sync [ADR 0081](0081-an-edit-that-changes-what-the-room-plays-pushes-it.md) added to both
  routes now runs on a path a human can actually reach, which is the first time that has been true.
- **The dialog will be seen often.** `handEdited` is set by any hex edit, any reorder, and by
  choosing a non-cover palette — so on a record you have touched at all, uploading a cover asks. That
  is the intended trade and the thing to revisit if it grates: §12's rule is that a hand-edit is
  never discarded without user action, and the alternative to asking is guessing.

## What this does not change

Palette Press, the extraction itself, the feeling palette, the card and visualizer panels, or what
the room plays. Roadie still fetches a cover on ingest and still extracts from it; this only lets a
human replace the picture it reads.
