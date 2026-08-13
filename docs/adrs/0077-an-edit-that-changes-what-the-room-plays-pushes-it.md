# ADR 0077 — An edit that changes what the room plays pushes it, rather than waiting for a milestone

Status: accepted · Date: 2026-08-12 · Amends:
[ADR 0045](0045-curator-pushes-album-assets-to-conductor.md) (widens the push triggers),
[runtime-overview.md](../specs/runtime-overview.md) (§8 sync table),
[roadie-spec.md](../specs/roadie-spec.md) (§6 ★sync triggers),
[curator-spec.md](../specs/curator-spec.md) (§Palettes, §Artwork, §The demo track, §Spotify matching) ·
Fixes [#304](https://github.com/dylanleatham/Marquee/issues/304) ·
Relates: [ADR 0058](0058-a-demo-tag-plays-one-chosen-track.md) (the demo cut, and the fallback that
hid this), [ADR 0059](0059-a-matched-album-plays-only-on-an-exact-match.md) (naming the album by
hand), [ADR 0030](0030-palette-from-album-feeling.md) / [ADR 0039](0039-one-motion-picker-clip-patterns-are-selectable.md)
(the light-side edits), [#306](https://github.com/dylanleatham/Marquee/issues/306) (the _transport_
gap this does not fix)

## Context

Every demo tag played its record from track one. The cut was chosen in Curator, written to
`asset.demoTrack` on the workstation, and never sent anywhere: `PUT /api/albums/:id/demo-track`
returned as soon as the store was saved. Amp reads the **runtime's** copy of the asset, found no
`demoTrack`, and did exactly what [ADR 0058](0058-a-demo-tag-plays-one-chosen-track.md) §3 says to do — play the whole album.

That fallback is why it stayed hidden for days. ADR 0058 chose "play the record" over "stay silent"
precisely because a wrong you can hear beats a silence you have to go read logs about. What it did
not foresee is that the fallback is also **correct behaviour for a record with no cut chosen**, so
from the room the two are indistinguishable. The failure was audible and unreadable at the same time.

[ADR 0045](0045-curator-pushes-album-assets-to-conductor.md) had set the push triggers a year of features ago: a video change, verify, the
per-album push, and the whole-library sync. Those are **milestones in getting a record onto the
shelf**. Every edit added since — the demo cut, naming the album on Spotify by hand, hand-editing a
palette, overriding the motion, choosing a feeling palette, replacing the cover — is something you
do to a record _already on the shelf_, long after its last milestone. Six routes had accumulated
behind the same gap; the demo cut was only the first one anybody stood in front of and noticed.

## Decision

**A route that edits a field the runtime reads at scan time pushes the asset before it answers.**

The trigger is the _edit_, not the milestone. `verified` is terminal, so any rule keyed on
transitions leaves everything after the last transition unsynced by construction.

### 1. What counts, and what deliberately does not

Push, because Conductor or Amp reads the field to decide what happens in the room:

| Route                                | The field, and who plays it                                                                        |
| ------------------------------------ | -------------------------------------------------------------------------------------------------- |
| `PUT .../demo-track`                 | `demoTrack` — Amp ([ADR 0058](0058-a-demo-tag-plays-one-chosen-track.md))                          |
| `PUT .../spotify-uri`                | `metadata.spotifyUri` — Amp ([ADR 0059](0059-a-matched-album-plays-only-on-an-exact-match.md))     |
| `PUT .../palette`                    | `palette.colors` — Conductor                                                                       |
| `PUT .../pattern-override`           | `patternOverride` — Conductor ([ADR 0039](0039-one-motion-picker-clip-patterns-are-selectable.md)) |
| `POST .../palette/choose`            | `palette.colors` + re-derived `pattern` ([ADR 0033](0033-palette-derived-motion-energy.md))        |
| `POST .../palette/generate`          | `palette.colors` + `pattern`                                                                       |
| `POST`/`DELETE .../artwork/override` | the cover the palette is derived from                                                              |

Do not push, each for a stated reason rather than by omission:

- **`POST .../palette/reset`** changes `palette.handEdited`, which is a fact about who last touched
  the colours. No service reads it; the colours themselves are untouched.
- **`POST .../palette/feeling`** stores candidates and applies nothing ([ADR 0030](0030-palette-from-album-feeling.md)). Nothing plays
  until one is chosen, and choosing is on the list above.
- **The prompt and card-art routes.** Card art is printed, not played; prompts are input to
  generation. Neither is read at scan time.
- **The library sweeps** (`/api/batch/regenerate-palettes`, `/api/albums/spotify-backfill`). A sweep
  that pushed per album would be a slower, less cancellable `POST /api/runtime/sync` inside a job
  that already reports what it changed. The boundary is **request-scoped edits push; library-scoped
  sweeps end in a report and the sync button.** This is the one place a person still has to press
  something, and it is recorded here so the next reader knows it was drawn, not forgotten.

### 2. Conductor only, and not through `syncAlbumToRuntime`

`syncPlaybackChange` calls `conductorSync.syncAlbum` and nothing else. The existing
`syncAlbumToRuntime` helper also syncs Backdrop **and cancels the album's in-flight media transfer** —
correct when a video changes, actively wrong here, where picking a demo cut would abandon an
unrelated upload that may be forty minutes in. Backdrop's projection carries none of these fields.

### 3. Best-effort, exactly like every other push

The result is recorded as the album's namespaced `syncIssue` and returned as `sync` on the response;
it is never raised over the edit. Choosing a demo cut in the kitchen with the stand unplugged still
saves the choice — the room is a side effect of the collection, never a gate on editing it
(roadie-spec §6).

## Consequences

- **Every route in the table above gained a push** — eight handlers across those seven rows, since
  the artwork override has an upload and a delete — through one shared helper, which is where the
  next one goes.
- **The rule is pinned by a table, not by prose.** `runtime-push.test.ts` enumerates every
  runtime-affecting edit and asserts, for each, that the runtime's copy is byte-identical to the
  workstation's afterwards — the identity claim ADR 0045 leans on to answer "is the runtime up to
  date" by comparing files. A new route that edits a played field is one table row away from covered;
  the deliberate exclusions above are listed in the same place, so an omission has to be argued
  rather than merely happen.
- **Latency**: one local HTTP PUT of a few KB per edit, on the palette autosave debounce too. Where
  the runtime is unreachable it is one connect-timeout on an action that already tolerates it.
- **This does not make the maintainer's own demo tags work.** [#306](https://github.com/dylanleatham/Marquee/issues/306) is a second, independent
  break in the same path: the desktop shell pins `CONDUCTOR_URL` at its bundled Conductor, whose
  asset directory _is_ Curator's own, so the push round-trips on the workstation and the Pi — where
  Amp actually runs — has had no writer since 2026-08-08. A correct push still needs somewhere real
  to go. Recorded here so this ADR is not read as having closed the whole path.
- **Not addressed**: pushing on a schedule, or a watcher on the store. Both were considered and both
  answer a different question (drift), which `POST /api/runtime/verify` already answers on demand.
