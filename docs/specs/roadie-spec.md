# Roadie — Curator's Background Agent

_Does the setup work behind the scenes before you take the stage. Lives inside Curator; not a separate service._

## 1. Purpose

A background worker inside Curator that picks up newly-added albums and runs them through every step it can complete autonomously — fetching metadata, downloading art, generating palettes, and drafting the video and card art prompts. When it hits a step that requires a human (subjective review, running the external art or video tools, physical actions), it parks the album in a specific queue state and stops.

Roadie also keeps Backdrop in sync with Curator's committed state, getting the video file across when an album's video is attached — streamed over HTTP or copied locally by Curator, or left to an out-of-band rsync ([ADR 0038](../adrs/0038-curator-pushes-media-over-http.md); see §6) — and doing a final sync verification when the album reaches `verified`. This closes the loop: by the time the human confirms an album is done, the runtime Pi has everything it needs.

The result: you add 40 albums on Friday night; over the next several minutes, Roadie processes each one and leaves them in states like "awaiting your review" or "awaiting your prompt." When you sit down Saturday morning, you have a queue of albums ready for the parts only you can do.

## 2. Success criteria

**Add 10 albums via the Add screen. Come back 5 minutes later. Every album should be in an "awaiting-human" state with palette, art, video prompt, and card art prompt ready. No errors should have gone unlogged. No album should be silently stuck.**

Also: **an album that Roadie couldn't process for a legitimate reason (not on Spotify, monochrome art, etc.) should show up with a clear "here's what went wrong, here's what you can do" state — not just "errored."** Graceful degradation is the design goal, not just success.

## 3. Scope

### In scope

- Automated processing of newly-added albums through pre-handoff steps (metadata, art, palette, prompts)
- State machine driving album status transitions
- Backdrop sync propagation on video attach and verified transitions
- Retry logic with exponential backoff for transient failures
- Graceful degradation paths for known failure classes (album not on Spotify, art unusable, etc.)
- Queue view: albums grouped by "what they need from you"
- Observability: which album Roadie is working on, recent activity log
- Manual re-trigger for stuck or failed albums
- Runs as a background worker inside Curator's Node process

### Out of scope

- Multi-worker parallelism (single-threaded is fine for this workload)
- Video generation via API (external tool has no API; this stays manual)
- Automatic tag writing (human uses phone)
- Automatic physical verification (impossible; human confirms)
- **Automatic** audio-feature fetching for pattern selection (Spotify Audio Features deprecated). Palette Press picks patterns from palette energy instead ([ADR 0033](../adrs/0033-palette-derived-motion-energy.md)); hand-authored `audioFeatures` refine it when present
- Distributed execution / horizontal scale

## 4. Where Roadie fits

Roadie is a component inside Curator, not a separate service:

```
                    ┌────────────────────────────────────────────┐
                    │                Curator                     │
                    │                                            │
                    │  ┌──────────────┐        ┌──────────────┐  │
                    │  │  HTTP API    │───────▶│    Roadie    │  │
                    │  │  (Fastify)   │        │              │  │
                    │  │              │◀───────│  worker loop │  │
                    │  │              │        │              │  │
                    │  └──────┬───────┘        └──────┬───────┘  │
                    │         │                       │          │
                    │         ▼                       ▼          │
                    │  ┌────────────────────────────────────┐    │
                    │  │      album-assets store            │    │
                    │  │      (JSON files, source of truth) │    │
                    │  └────────────────────────────────────┘    │
                    │                                            │
                    └──────────────┬─────────────────────────────┘
                                   │
                    external calls │
                                   ▼
                    ┌──────────────────────────────┐
                    │  Spotify Web API             │
                    │  Palette Press (library)     │
                    │  (Video tool: NOT called by  │
                    │   Roadie — human runs it)    │
                    └──────────────────────────────┘
```

Roadie shares Curator's process, database (asset store), and configuration. The HTTP API adds enqueue/status endpoints but the runtime services (Conductor, Backdrop, Stylus) don't know Roadie exists. From their perspective, they read the same asset files as always.

## 5. Album state machine (unified view)

The album onboarding workflow already defined per-album states. Roadie doesn't invent new ones — it drives transitions between the states that already exist. Coloring the states by who advances them:

```
                            ┌────────────────────────────────┐
                            │       Roadie-driven states     │
                            │                                │
    ┌──────────┐            │  ┌────────────┐  ┌──────────┐  │
    │  fresh   │────────────┼─▶│ fetching   │─▶│downloading  │
    │ (added)  │            │  │ metadata   │  │ art       │  │
    └──────────┘            │  └────────────┘  └────┬──────┘  │
                            │                       │         │
                            │                       ▼         │
                            │  ┌────────────┐  ┌──────────┐   │
                            │  │  drafting  │◀─│generating│   │
                            │  │  prompts   │  │ palette  │   │
                            │  └─────┬──────┘  └──────────┘   │
                            │        │                        │
                            └────────┼────────────────────────┘
                                     │  Roadie has done all it can
                                     ▼
                            ┌─────────────────────┐
                            │  Human-driven states│  ┌───────────────────┐
                            │                     │  │  Terminal states  │
                            │  awaiting_review    │  │                   │
                            │        │  │         │  │  verified         │
                            │        │  ▼         │  │  (done)           │
                            │        │ awaiting_  │  │                   │
                            │        │  video     │  │  needs_manual     │
                            │        │  │ ★sync   │  │  (Roadie gave up, │
                            │        ▼  ▼         │  │   labeled clearly)│
                            │  awaiting_preview   │  │                   │
                            │           │         │  │                   │
                            │           ▼         │  └───────────────────┘
                            │  awaiting_tag_write │
                            │           │         │
                            │           ▼         │
                            │  awaiting_verify    │
                            │           │ ★verify │
                            │           ▼         │
                            └─────────────────────┘

  ★ = runtime sync triggers (see §6). ★sync and ★verify fire on human-driven
      transitions; ★announce fires on creation, which is not one:
      ★announce = the moment the album exists, before this diagram starts — put it
                in Backdrop's library as `usesDefault` so an unfinished record
                plays the default clip instead of nothing (ADR 0073, ADR 0094).
                Backdrop only: its projection is `{ uri, usesDefault }` and needs
                no metadata, while Conductor's is the whole asset, which at this
                point has no palette yet.
      ★sync   = push the album asset to Conductor — which Amp reads from the same
                directory (ADR 0045) — and get the video file onto Backdrop's SD
                card, pushed over HTTP, copied locally, or left to rsync, per
                media_transfer (§6, ADR 0038)
      ★verify = push the album to the whole runtime first (ADR 0045), then verify
                it is in Backdrop's library and log any discrepancies
```

Two important properties:

- **Roadie only _forward_-transitions.** It never moves an album backward. If a human explicitly resets a step (regenerate palette, replace video), that's a human action; Roadie doesn't second-guess. Sync failures at the ★ triggers also don't move backward — they're logged as issues on the album.
- **Roadie's own progress states (fetching_metadata, downloading_art, etc.) are fine-grained.** This is deliberate — when Roadie crashes or the process restarts, it should be able to resume from the last completed sub-step, not restart from `fresh`. Each sub-step is idempotent.

> **The human-driven line is not the whole record of human work (2026-08-08,
> [ADR 0062](../adrs/0062-the-tag-step-is-recorded-on-the-asset-not-on-the-machine.md); extended the
> same day by [ADR 0063](../adrs/0063-the-machine-is-settled-from-the-asset-not-driven-by-the-button.md)).**
> The record page presents its needs done in any order, and **both** human steps are now recorded on
> the asset whatever state the album is in — `tag.*.written` / `verification.physicallyVerifiedAt` for
> the tag step, `verification.previewApprovedAt` for the lights sign-off. The transitions above are
> unchanged: no new edges, and nothing skips a state.
>
> _Since 2026-08-10 the lights sign-off is no longer one of the record page's needs
> ([ADR 0069](../adrs/0069-the-lights-are-not-a-need.md)) — but it is still offered in the room and
> still writes `previewApprovedAt`, so **nothing here changes**: `settleNeeds` reads the same evidence
> and walks the same line._
>
> What changed is that **no control drives an edge of its own**. One settler (`settleNeeds`) walks the
> line, and each step is gated on the evidence on the asset rather than on which button was pressed:
> `awaiting_preview → awaiting_tag_write` needs `previewApprovedAt`, and `awaiting_tag_write →
awaiting_verify → verified` needs `physicallyVerifiedAt`. `preview/approve`, `tags-verified` and
> **video attach** all run it, so whichever need lands last carries the album on to `verified` and
> out-of-order work always terminates. An album can therefore carry a checked tag step and signed-off
> lights while still sitting at `awaiting_review`, because it genuinely still has no visualizer.
>
> Read `roadie.state` as a summary that can lag the asset, not as the source of truth for what the
> human has done.

## 6. What Roadie does at each Roadie-driven state

> **Source routing (issue #24 / [ADR 0017](../adrs/0017-discogs-personal-token-and-direct-images.md)):**
> `fresh` routes on `metadata.source` — **`manual` → `generating_palette`** (metadata + art already
> on disk), everything else (`spotify`, `discogs`) → **`fetching_metadata`**. The `fetching_metadata`
> and `downloading_art` steps below dispatch on the source: Spotify albums hit the Spotify Web API,
> Discogs albums hit the Discogs API. Both end at `generating_palette`, so everything downstream is
> source-agnostic.

### fetching_metadata

- Input: album's Spotify URI **or** Discogs release id (from the Add screen)
- Action (spotify): call Spotify `/albums/{id}` for title, artist, year, art URL, genres (via artist), track list
- Action (discogs): call Discogs `/releases/{id}` for title, artist, year, genres (merged genres + styles), and the primary cover-image URL
- Success: store metadata in asset file, transition to `downloading_art`
- Failure modes:
  - 404: Album genuinely doesn't exist at the source → transition to `needs_manual` with reason `album_not_on_spotify` (spotify) / `release_not_on_discogs` (discogs)
  - 429 rate limit: retry with backoff
  - Auth error: transition to `errored` (config problem, needs admin attention)

### downloading_art

- Input: art URL from previous step (Spotify art URL, or the Discogs release's primary image URL; or manually provided art via `override_art_url` in asset file)
- Action: fetch art bytes, hash for cache invalidation, save to `media/artwork/{curatorId}.jpg`, and stamp `artwork.source`. For a Discogs album the metadata step attempts a conservative fuzzy match to a Spotify album (issue #58): on a confident hit it downloads the **Spotify** cover (richer/consistent, `source: "spotify"`), otherwise the **Discogs** release image (`source: "discogs"`) — best-effort, so a miss/error never blocks the add. Discogs image hosts require the same token + `User-Agent` as the API (ADR 0017).

> **That match decides more than the cover now (2026-08-08, [ADR 0059](../adrs/0059-a-matched-album-plays-only-on-an-exact-match.md)).** The metadata step keeps the matched album's **identity**, not just its art URL, and the confidence decides how far it is trusted: an **exact** match (artist and title agree outright once normalized — the year ranks candidates but no longer gates them, [ADR 0060](../adrs/0060-the-year-is-a-tiebreak-not-a-gate.md)) sets `metadata.spotifyUri`, which is what lets Amp stream the record on a card or demo scan; a **close** match sets `spotifyArtUrl` only and leaves the album deliberately unplayable. Either way `metadata.spotifyMatch` records what was matched, so a guess is inspectable rather than silently authoritative.
>
> Previously the step returned `bestSpotifyMatch(...)?.artUrl` and discarded the rest — so a Discogs-swept library held hundreds of albums Curator had identified and nothing could play. Albums already on disk are fixed by `POST /api/albums/spotify-backfill`, which applies this identical rule through the same shared helper.
>
> **A third verdict, reachable from this step (2026-08-11, [ADR 0068](../adrs/0068-ambiguous-is-a-third-answer-not-a-missing-one.md) / [#289](https://github.com/dylanleatham/Marquee/issues/289)).** The match now answers `matched`, `ambiguous`, or `none`. **`ambiguous`** means the artist has several albums under this title and [ADR 0067](../adrs/0067-the-year-may-only-break-a-tie-by-hitting-it.md) refused to let a repress's year choose between them — so onboarding a Discogs add, not only the backfill sweep, can leave a record with `metadata.spotifyAmbiguous` (the count of same-titled albums; never the albums themselves). It sets no `spotifyUri` and no `spotifyArtUrl`, so this step falls through to the **Discogs** image exactly as a miss does — which is the right cover, since it came off the pressing that was added. The difference is what the record page then says: a miss may become a hit on a later sweep, an ambiguous record never will, so it is sent to the picker rather than back to the sweep.
>
> A Spotify **error** here is `none`, never `ambiguous` — "look again later" is true of an outage and false of an ambiguity.

> **A cover already in force short-circuits this step (2026-08-16, [#345](https://github.com/dylanleatham/Marquee/issues/345)).** When `artwork.overrideActive` is set and the override file is on
> disk, the step returns `generating_palette` without asking either source for a URL. Two reasons,
> both load-bearing: a re-download would re-point `artwork` at the fetched slot and silently discard
> the human's cover, which is the loss [ADR 0084](../adrs/0084-your-own-cover-is-a-palette-control.md)'s
> override exists to prevent; and without it the **manual retry** promised in §8 could never clear an
> `art_unavailable` park, because the retry re-entered this step and failed on the same missing URL
> forever. `albums/artwork.ts` states the rule for readers — the active cover is the override when
> there is one — and this is the writer's half of it.
>
> The file check is not ceremony. `applyArtworkOverride` writes the flag and the file together, so a
> set flag with no file means a half-written override; proceeding there would trade this step's
> honest failure for a more confusing one in `generating_palette`.

- Success: transition to `generating_palette`
- Failure: retry with backoff; after 3 fails, `errored` with reason

### generating_palette

- Input: album art bytes
- Action: call Palette Press library synchronously; apply post-processing
- Success: save palette to asset file, transition to `awaiting_review` _(2026-07-25, [ADR 0027](../adrs/0027-generation-is-invoked-not-pipelined.md): this previously transitioned to `drafting_prompts`, which is no longer a pipeline state — prompts are drafted on request)_
- Special case: post-processor returns fewer than 2 usable colors (monochrome art, etc.) → save whatever was extracted, transition to `awaiting_review` with a flag `palette_insufficient: true`. Human decides — either accept or hand-craft a palette. Not an error; a real album can genuinely be monochrome.

### drafting_prompts

> **No longer a pipeline state (2026-07-25, [ADR 0027](../adrs/0027-generation-is-invoked-not-pipelined.md)).**
> Roadie transitions `generating_palette → awaiting_review` directly. Prompt drafting is **invoked by
> the human** from the Video or Card workstation, because it costs two Gemini calls per album and was
> being spent unconditionally — including on albums whose visualizer and card art the user already
> had, where the ten drafted prompts are never opened.
>
> The state value is retained for `history` entries on albums that already passed through it, and as
> the label for the on-demand action. Everything below describes that action; only its **trigger**
> moved. `awaiting_review` now means "palette ready; prompts available on request" rather than
> "palette and prompts ready."

- Input: album metadata (title, artist, year, genres) + generated palette; a Gemini key if the LLM path is configured
- Trigger: the user opens the Video or Card workstation and presses **Draft prompts**. Never fired automatically, and never offered as the primary action for a section whose artifact is already attached (ADR 0027)
- Action: run the prompt-drafting logic (see §7) for the requested prompt type, save to `promptDrafts` in the asset file
- Success: prompts available in the workstation. No state transition (the album is already at `awaiting_review` or beyond)
- Failure modes: the drafting itself **cannot fail** (ADR 0009). The LLM path is attempted first; on a missing key or any Gemini error it falls back to the deterministic templates (logging the fallback), so the request always returns prompts. Only an unexpected bug in the fallback itself would surface an error — log verbosely if so. Because this is now a foreground user action rather than a pipeline step, a failure is reported in place rather than moving the album to `errored`.

### Backdrop sync triggers

> **Implementation note (2026-07-13, build step 5):** the sync triggers below (★ in §5) were
> deferred until Backdrop existed (step 8): there was no downstream to sync to. Superseded — see the
> update below.
>
> **Update (2026-07-20, build step 9, [ADR 0015](../adrs/0015-backdrop-sync-triggered-at-projection-changes.md)):**
> **★sync is implemented.** Curator now pushes its URI → filePath projection to Backdrop's
> `/api/library/*` API at the points the projection changes — video attach (upsert), video detach /
> album delete (remove) — plus a manual full-reconcile (`POST /api/backdrop/sync`) and drift check
> (`POST /api/backdrop/verify-sync`). Per ADR 0015 the trigger lives at Curator's action/route layer, not a
> literal every-save hook (an album with no video has nothing to project). Sync failures record on the
> album as `roadie.syncIssues` and never move it backward. **★verify-on-`verified` is now wired**
> (issue #55): the `verified`-transition endpoint (`POST /api/albums/:id/verify-physical`) fires a
> single-album verify (`syncAlbum`'s counterpart `verifyAlbum`) that records any drift as
> `syncIssues`; the manual full-library `POST /api/backdrop/verify-sync` remains for recovery.
>
> **Update (2026-08-05, [ADR 0052](../adrs/0052-curator-is-three-places-not-a-nine-state-queue.md)):
> there are now two endpoints that reach `verified`, and both fire this.** The record page's tags
> panel presses `POST /api/albums/:curatorId/tags-verified`, which records both stickers written and
> the physical check in one action and then runs the identical push-then-★verify tail — the claim
> being made ("I put the sleeve on the stand and it worked") is the same one, so the trigger must be
> too. `verify-physical` is unchanged and remains the per-step route. See curator-spec §Tag writing.
>
> **Update (2026-08-12, [ADR 0073](../adrs/0073-a-record-with-no-visualizer-plays-the-default.md)):
> a video **detach** is now an upsert, not a remove, and "an album with no video has nothing to
> project" above is no longer true.** Every album Curator holds projects an entry; one with no
> visualizer projects as `{ uri, usesDefault: true }`, and Backdrop plays its default clip for it.
> Removal is reserved for the album ceasing to exist (delete, merge). The trigger points themselves
> are unchanged. What changed is why: while a video-less album projected `null`, Backdrop could not
> tell a record that simply wasn't finished from a tag it had never heard of, and answered both with
> `video not in library` and a dead screen.
>
> **Update (2026-08-01, [ADR 0045](../adrs/0045-curator-pushes-album-assets-to-conductor.md)): ★ now
> covers the whole runtime, not just Backdrop.** The **album-assets store** Conductor reads at scan
> time — and Amp reads from the same directory — is pushed over HTTP too
> (`PUT /api/album-assets/:curatorId`), at the same triggers plus **verify**, which now pushes before
> it verifies. Two new controls sit alongside the Backdrop ones: `POST /api/albums/:curatorId/push`
> (one album, available at any state, since `verified` is terminal and so cannot be the only way to
> re-push) and `POST /api/runtime/sync` (the whole library, as a cancellable background job).
> `POST /api/runtime/verify` is the cross-service drift check. Because two services now write
> `roadie.syncIssues`, each entry is namespaced by the service that raised it so they cannot erase
> each other's findings.
>
> **Update (2026-08-12, [ADR 0081](../adrs/0081-an-edit-that-changes-what-the-room-plays-pushes-it.md)): ★ also fires on an edit, not only on a
> milestone.** Every route that changes a field the runtime reads at scan time — the demo cut, the
> hand-named Spotify URI, the palette, the motion override, the chosen or re-derived palette, the
> cover override — pushes the asset to Conductor before it answers. The triggers above are all
> milestones on the way to `verified`, which is terminal, so an edit made to a finished record
> reached the room only via **Sync everything**; that is [#304](https://github.com/dylanleatham/Marquee/issues/304), where every demo tag played its
> album from track 1. These pushes are Conductor-only and skip Backdrop deliberately (its projection
> carries none of those fields, and the Backdrop path cancels in-flight media transfers). Library
> sweeps still do not push per album — see ADR 0075 for the boundary and the exclusions.
>
> **Update (2026-08-16, [ADR 0094](../adrs/0094-adding-an-album-is-a-projection-change.md)): ★ fires
> on **album creation** too, and "the trigger points themselves are unchanged" in the ADR 0073 note
> above is what turned out to be wrong.** Once every album projects an entry, the entry has to appear
> when the album does; leaving the list starting at _video attach_ meant a record added since the last
> full reconcile was absent from Backdrop, so putting it on the stand played nothing under
> `video not in library` — the indicator ADR 0073 had just finished disambiguating
> ([#343](https://github.com/dylanleatham/Marquee/issues/343): four albums from one Discogs sweep).
> Every creation path — manual, Spotify, Discogs, the pasted batch, the collection sweep — now runs
> through `albums/publish.ts`, which saves, enqueues with Roadie, and announces to Backdrop. The
> announce is a **required** field of `NewAlbumDeps` rather than an optional one, so a new creation
> path cannot be written without deciding what announcing means: this list going stale is the failure
> being designed out, so the trigger is a type rather than another entry here. **Backdrop only** —
> Conductor's projection is the whole asset, which at creation is a palette-less shell.

Curator synchronizes Backdrop at two human-driven transitions. _(Original step-5 design below; the
mechanism was revised by [ADR 0015](../adrs/0015-backdrop-sync-triggered-at-projection-changes.md) —
the two triggers stand, but the sync fires at the action/route layer, not via a separate "post-save
hook", and there is one push per change carrying both the metadata and, on a single workstation, the
file. The file rsync to a Pi stays out-of-band.)_

> **Superseded in part (2026-07-29, [ADR 0038](../adrs/0038-curator-pushes-media-over-http.md)):** the
> file transfer to a Pi no longer has to be out-of-band. With `media_transfer = "push"` Curator
> streams it to Backdrop over HTTP. Since 2026-07-29 (issue #177) that runs as a background
> `mediaTransfer` job rather than on the request path, so attaching a video returns immediately; a
> failed transfer fails that job and records a `syncIssue` rather than being invisible. `rsync` remains supported (`media_transfer = "none"`, still the
> default) for bulk or offline moves.

**On video attach** (→ `awaiting_preview`, from either `awaiting_video` or — when you already had
the video — `awaiting_review`; [ADR 0005](../adrs/0005-video-attach-does-not-require-copying-the-prompt.md);
and then straight on through `settleNeeds` when the lights were already signed off and the tags
already checked, [ADR 0063](../adrs/0063-the-machine-is-settled-from-the-asset-not-driven-by-the-button.md)):
the newly attached video's entry is upserted into Backdrop's `library.json` (metadata), and the file
is made available under Backdrop's media dir — streamed to Backdrop over HTTP (`media_transfer =
"push"`), copied in-process on a single workstation (`"local"`), or left to an out-of-band rsync
(`"none"`, the default). Syncing eagerly at attach time means the preview and
simulate-scan flows have the real file available when the user tries them.

**On verified** (any → `verified`): a final sync verification (`POST /api/backdrop/verify-sync`)
compares Curator's expected projection against Backdrop's live library; discrepancies (missing
entries, filePath drift) are logged as issues on the album — it stays `verified` because the human
confirmed it works physically, but the warning surfaces so it can be resolved before the next play.
_(Per ADR 0015 the automatic firing of this on the `verified` transition **now happens** (issue #55):
`POST /api/albums/:id/verify-physical` runs a single-album `verifyAlbum` after the transition. The
manual full-library `POST /api/backdrop/verify-sync` route remains for recovery.)_

Sync failures never move albums backward through the state machine. They're recorded as issues; the human decides whether to retry, investigate, or ignore. This preserves the invariant that "Roadie only forward-transitions" — sync is a side effect, not a state.

## 7. Prompt drafting

> **Amended 2026-07-18 by [ADR 0009](../adrs/0009-llm-authored-grounded-prompts-via-gemini.md).**
> Roadie now drafts prompts with **Gemini by default** — a grounded two-pass flow that references
> real, album-specific detail and returns a **set of variants** per type — and falls back to the
> deterministic templates below only when Gemini is unavailable. The "no external dependencies /
> pure function" property described in this section now holds for the **template fallback only**,
> not the primary path. See the ADR for the two-pass design and the LLM/fallback split; the sections
> below describe the deterministic templates, which remain the fallback **only** (the on-demand
> style `redraft` was removed — see the 2026-07-28 amendment under "Common properties").

Roadie drafts two prompts per album: one for the visualizer video that plays on Backdrop, and one for the business-card art that gets printed and stuck onto the physical card. Both use the same inputs — album metadata + palette — but have different templates suited to their output medium.

**LLM path (default, ADR 0009).** When a Gemini key is configured, drafting runs
the grounded two-pass drafter (invoked on request rather than in the pipeline since
[ADR 0027](../adrs/0027-generation-is-invoked-not-pipelined.md) — the mechanism below is unchanged): pass 1 researches the album's real visual identity (cover subjects,
booklet/music-video motifs, era aesthetic) with Google Search grounding; pass 2 turns that research
plus the matching metaprompt (`docs/prompts/`, bundled at `gemini/metaprompts.ts`) into
`PROMPT_VARIANTS` (5) variants, surfaced individually (each copyable). For **card art** these are the
metaprompt's five fixed options in order (Cover Reimagining, Signature Motif, Visual Artist
Provenance, Live Performance Era, Album Lore — ADR 0021). For **video** the default `narrative` style
ports those same five angles into motion (Cover in Motion, Signature Motif, Visual Artist Provenance,
Live Performance Era, Album Lore — [ADR 0022](../adrs/0022-video-prompt-parity-narrative-and-per-prompt.md));
the two earlier styles, `photo` (animate the cover) and `abstract` (motion-design), remain as
`videoStyle`-selectable alternates and use generic variance angles. Each drafted prompt records
provenance (`generator: "gemini" | "template"`). Grounding and structured JSON can't share one Gemini
call, hence the two passes.

### Video prompt structure

> **Amended 2026-07-23 by [ADR 0022](../adrs/0022-video-prompt-parity-narrative-and-per-prompt.md).**
> On the **LLM path** the default video style is now `narrative` — the card-art five fixed angles
> ported into motion — with `photo` and `abstract` kept as the two `videoStyle` alternates. The detail
> UI surfaces all five prompts, each individually copyable and generatable (per-prompt "Generate
> clip", a background job keyed on the prompt index). The deterministic **template** shape below
> remains the fallback **only** (see the 2026-07-28 amendment under "Common properties").

The **template fallback** emits this shape (its "3 minutes" line is the template's text, not a
system guarantee). The **LLM path** (ADR 0009) authors the prompt from the metaprompt + research
instead. And per [ADR 0011](../adrs/0011-auto-generate-visualizer-clips.md), when the visualizer is
**generated** it's produced as short (~8–10s) image-to-video clips off the cover that the human
splices into the loop — so the visualizer is a short spliced loop, not a single 3-minute render.

```
[Video style template preamble — fallback default; not user-selectable since #140]
For the album "{title}" by {artist} ({year}).
Genre context: {genres}.
Color palette to draw from:
  - {hex1} ({role1})
  - {hex2} ({role2})
  - ...
[Video style template body — motion, mood, composition]
Duration: 3 minutes, seamlessly loopable.
Aspect ratio: 16:9.
```

Video style templates (motion-oriented):

- `abstract_flow` — "Abstract flowing shapes with soft edges..." _(default)_
- `particle_drift` — "Slow-moving particles suspended in a gradient field..."
- `geometric_pulse` — "Sharp geometric shapes pulsing to an implicit rhythm..."
- `analog_film` — "Grainy analog film textures with slow color shifts..."
- `psychedelic` — "Kaleidoscopic patterns..."
- `minimal_gradient` — "Nothing but a slowly shifting color gradient..."

### Card art prompt structure

> **Amended 2026-07-23 by [ADR 0021](../adrs/0021-card-art-five-option-prompt-strategy.md).** On the
> **LLM path** the card-art metaprompt now defines **five fixed-angle options** — Cover Reimagining,
> Signature Motif, Visual Artist Provenance, Live Performance Era, Album Lore & Narrative Artifact —
> and the drafter asks for those in order (each labelled by its option title), not generic variance
> nudges. The detail UI surfaces all five prompts, each individually copyable and generatable
> (per-prompt "Generate art"). The deterministic **template** shape below remains the fallback
> **only** (see the 2026-07-28 amendment under "Common properties").
>
> **Amended 2026-07-26 by [ADR 0031](../adrs/0031-card-art-cover-reference-image.md).** Each drafted
> variant also carries **`coverAnchored`** (boolean): true for the options that directly re-render the
> album's real front cover (Option 1, Cover Reimagining), false for those that deliberately depart from
> it. Card-art generation sends the cover as a **reference image** only for anchored prompts — see
> [curator-spec §Card art](curator-spec.md). The flag is optional: absent on template drafts and on
> drafts persisted before ADR 0031, and absence means "not anchored".
>
> **Amended 2026-07-27 by [ADR 0032](../adrs/0032-card-art-refusal-drops-the-cover-reference.md):**
> anchoring is a _request_, not a guarantee. Gemini refused an anchored prompt with
> `IMAGE_RECITATION` (declining to reproduce the copyrighted sleeve), so generation retries once
> without the reference and marks the resulting candidate — an anchored variant can therefore end up
> text-only. See [curator-spec §Card art](curator-spec.md).

```
[Card art style template preamble — fallback default; not user-selectable since #140]
Business-card sized art for the album "{title}" by {artist} ({year}).
Genre context: {genres}.
Color palette to draw from:
  - {hex1} ({role1})
  - {hex2} ({role2})
  - ...
[Card art style template body — composition, subject, mood]
Dimensions: 1050x600 pixels (business-card landscape at 300 DPI).
Style: iconic, evocative, reads clearly at small size.
```

Card art style templates (static, emblem-oriented):

- `iconic_emblem` — "A single evocative image that reads at business-card scale..." _(default)_
- `abstract_scene` — "An abstract composition that captures the album's mood..."
- `typographic` — "Bold typography incorporating the album title, playing with palette colors..."
- `photograph_style` — "A photorealistic scene evocative of the album's themes..."
- `collage` — "A layered collage of textures, shapes, and small motifs..."

### Common properties

Roadie's defaults when unspecified: `abstract_flow` for video, `iconic_emblem` for card art.

> **Amended 2026-07-28 ([issue #140](https://github.com/dylanleatham/Marquee/issues/140)): templates
> are the fallback only — they are no longer user-selectable.** The detail page's template style
> `<select>`, and the `POST /api/albums/:curatorId/prompts/:type/redraft` route behind it, are both
> removed. The picker listed five _template_ names beside five _metaprompt angle_ prompts — same
> count, unrelated vocabulary, no correspondence — and changing it silently replaced the grounded AI
> prompts with a template draft, immediately beside the "AI · grounded" badge.
>
> Templates are unchanged and still reached two ways: Roadie's pipeline fallback, and
> `POST /api/albums/:curatorId/prompts/:type/draft`, which re-runs on demand and falls back — so a
> run with no Gemini key still gets prompts. The provenance badge stays, so a template draft remains
> identifiable after the fact. What's gone is _choosing a style_, which nothing in the workflow
> wanted.

The **template path** has no external dependencies — pure function of album metadata + palette + template, fast and deterministic given inputs (goldens cover it). The **LLM path** (ADR 0009, the default) is an external, non-deterministic Gemini call; it's tested structurally (variant count, provenance, grounded/structured call shape) against `@marquee/fake-gemini`, not by golden-exact text.

**Why this matters even without a video API.** The prompt is the seam. Today, human copies each prompt, pastes into the respective tool, generates the output. If either service ever gets an API, the same prompts drive automated calls. Same output, different consumer. No rearchitecture.

## 8. Failure modes and retry policy

Failure classes:

| Class            | Example                                    | Response                                                                        |
| ---------------- | ------------------------------------------ | ------------------------------------------------------------------------------- |
| **Transient**    | Network hiccup, Spotify 429                | Retry with exponential backoff (1s, 4s, 15s, 60s); max 4 tries; then `errored`  |
| **Permanent**    | Album not on Spotify, art URL 404          | No retry; transition to `needs_manual` with a clear `reason` field              |
| **Insufficient** | Palette Press finds only monochrome        | Not a failure; save what was found, transition to `awaiting_review` with a flag |
| **Config**       | Spotify auth broken, filesystem unwritable | No retry; transition to `errored`, surface prominently in UI as system problem  |
| **Unexpected**   | Truly unknown                              | Log the full context, transition to `errored`, do not retry automatically       |

**Manual retry**: any album in `errored` or `needs_manual` can be re-enqueued by the human via a UI button or `POST /api/agent/retry/:curatorId`. Retries reset the retry counter and start over from the current sub-step (idempotent).

> **The UI button is the Stuck row's `TRY AGAIN` (2026-08-16, [#345](https://github.com/dylanleatham/Marquee/issues/345)).** It went missing when [ADR 0052](../adrs/0052-curator-is-three-places-not-a-nine-state-queue.md) replaced the
> nine-state queue with the collection — `api.retry` survived the overhaul wired to nothing, so for
> two months this paragraph was false and a stuck record's only offered way out was a link to a page
> that could not un-stick it either. See [curator-ui-ux.md](curator-ui-ux.md) §10 for the row.

**Every `reason` owes the reader a sentence.** The permanent reasons are enumerated once, as
`ROADIE_FAILURE_REASONS` in `@marquee/contracts`, and the UI's `failureSentence` is a total `Record`
over that union — so a new reason does not compile until it has plain English to show. They were two
hand-maintained lists until 2026-08-16 and had drifted completely apart: the UI carried sentences for
four reasons no step has ever thrown, while four of the five real ones fell through to raw server
text. `art_unavailable` was among them, which is how a record spent two months telling its owner to
"provide art manually" from a screen with no way to provide it
([#345](https://github.com/dylanleatham/Marquee/issues/345)).

**Backoff shape**: exponential (1s, 4s, 15s, 60s) with jitter. Long tail so a Spotify outage doesn't hammer the API; short first-try so the common recoverable case (WiFi hiccup) resolves in seconds.

## 9. Data model additions to the asset file

The album-assets file (defined in the Curator spec) gets a small extension for Roadie's use:

```json
{
  "curatorId": "2k7bxq9m",
  "spotifyUri": "spotify:album:1C2h7mLntPSeVYciMRTF4a",
  ...existing fields...

  "roadie": {
    "state": "awaiting_review",
    "subState": null,
    "lastUpdatedAt": "2026-07-06T20:15:22Z",
    "flags": {
      "palette_insufficient": false,
      "album_not_on_spotify": false,
      "art_override_active": false
    },
    "history": [
      { "state": "fetching_metadata", "at": "2026-07-06T20:14:11Z" },
      { "state": "downloading_art",    "at": "2026-07-06T20:14:13Z" },
      { "state": "generating_palette", "at": "2026-07-06T20:14:14Z" },
      { "state": "drafting_prompts",   "at": "2026-07-06T20:14:16Z" },
      { "state": "awaiting_review",    "at": "2026-07-06T20:15:22Z" }
    ],
    "lastError": null,
    "retryCount": 0
  }
}
```

- `subState` is used during active sub-steps (`fetching_metadata`, etc.) so a mid-flight crash + restart can resume.
- `history` caps at some reasonable length (last 30 entries) — helpful for debugging without being a resource sink.
- `lastError` includes both message and structured cause when in `errored`, so the UI can show useful context.

## 10. HTTP API additions to Curator

All endpoints on Curator's existing host/port.

| Method | Path                          | Purpose                                                                                                                                   |
| ------ | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| POST   | `/api/albums`                 | Add an album (search or paste URI). Body: `{ spotifyUri? , searchQuery?, manualMetadata? }`. Returns `{ curatorId }`. Enqueues in Roadie. |
| GET    | `/api/agent/queue`            | Returns queue grouped by human-facing state (§11). Primary UI backing.                                                                    |
| GET    | `/api/agent/status`           | Returns Roadie's current activity: which album (if any), queue depth, recent activity log.                                                |
| POST   | `/api/agent/retry/:curatorId` | Manually re-trigger an album that's in `errored` or `needs_manual`.                                                                       |
| POST   | `/api/agent/pause`            | Stop processing new items (in-flight work completes). For maintenance.                                                                    |
| POST   | `/api/agent/resume`           | Resume processing.                                                                                                                        |

Note: the album detail page endpoints (from the Curator spec) don't change; they just now also render Roadie-derived state and history.

## 11. The queue view (the UI primary)

This is the screen you'll live on. Roadie's presence shifts Curator's main view from a raw collection browser to a task queue.

Sections, in order of user attention:

**Needs you right now.** Albums in any `awaiting_*` state, grouped by which step is next:

- Awaiting review (palette + prompt ready — approve and copy the prompt)
- Awaiting video (prompt copied, video generation in progress or pending)
- Awaiting preview (video attached, needs your sign-off)
- Awaiting tag write (approved, needs sticker)
- Awaiting verification (tag written, needs physical scan)

Each row: cover art thumbnail, title/artist, timestamp of when it entered this state, one big next-action button ("Review palette," "Attach video," etc.).

**Roadie is on it.** Albums Roadie is currently processing. Usually a very short list (1–3 items). Shows current sub-state and elapsed time.

**Needs your attention.** Albums in `errored` or `needs_manual`. Cause visible at a glance. Retry button.

**Done.** Albums in `verified`. Collapsed by default; expandable for spot-checks. Search-friendly.

Filters and search at the top: filter by state, search title/artist. Batch actions: retry all errored, pause Roadie, etc.

The number in the app header should be **the count of "needs you right now"** — because that's the number that tells you how much work is waiting. _(2026-07-25: was "the browser tab title"; Curator is a single-window Electron app with no tab — see [curator-ui-ux.md](curator-ui-ux.md) §8.)_

## 12. Observability

Roadie's activity should feel visible and legible.

**In the UI:**

- Recent activity log in the "Roadie is on it" section: last 20 state transitions with timestamps
- Current item shown prominently when active
- Queue depth surfaced as a number

**In logs (`journalctl -u curator`):**

- Every state transition logged at INFO with the album, from/to state, elapsed time
- Every retry logged at WARN with cause
- Every error logged at ERROR with full context
- No log noise from healthy idle (Roadie asleep waiting for work is silent)

**Metrics (deferred until real usage motivates them):**

- Median time per state
- Retry rates per state
- Distribution of "human input required" waits (helps calibrate the queue view UX)

## 13. Testing considerations

Roadie is one of the most testable components in the system because it's a state machine over data.

**Unit tests:**

- State transitions: given (state, event) → new state. Table-driven, exhaustive.
- Prompt drafting: deterministic function of inputs; test with fixture albums.
- Retry policy: given a sequence of failures, verify backoff timing and eventual give-up.

**Integration tests** (with `fake-spotify` and Palette Press library):

- Add an album via `POST /api/albums`, run Roadie synchronously, assert on final state.
- Add an album whose fake Spotify record 404s, verify `needs_manual` with correct reason.
- Add an album whose art fake returns garbage, verify graceful degradation.
- Add an album, kill Roadie mid-flight, restart, verify resumes from correct sub-state.

**Fake time is essential.** Retry backoff, queue polling — all use timers. Every Roadie test uses fake time; a full test run should complete in under a second.

**Property tests:**

- For any sequence of Roadie events on any album, the state must remain valid (no unreachable states, no self-loops that shouldn't exist).
- For any transient failure sequence within retry limits, Roadie eventually recovers or terminates cleanly.

**Golden tests:**

- Prompt drafting outputs for fixture albums — save as goldens, review diffs on change.

**What we don't test in unit/integration:**

- Actual Spotify API calls (use the fake)
- Actual video generation (out of Roadie's scope entirely)
- Physical NFC/lights/display (runtime services, not Roadie)

## 14. Development milestones

Roadie should be built after Curator's baseline exists (add-album, asset store, palette generation via library). Then:

1. **State machine skeleton.** Data model + transitions + persistence. No external calls yet — mock every step. Success: add an album via API, watch state advance through fake sub-steps to `awaiting_review` in tests.
2. **Real Palette Press integration.** Palette generation actually runs Palette Press. Success: add Purple Rain, palette generation transitions correctly with real output.
3. **Real Spotify integration** (with `fake-spotify` in tests). Metadata fetch and art download. Success: add a real album URI, end up with metadata + art on disk.
4. **Prompt drafting.** Template system, prompt generation. Success: adds an album, land at `awaiting_review` with a generated prompt visible.
5. **Retry logic + failure classes.** Backoff, classification, graceful degradation. Success: add a bogus URI, land at `needs_manual` with clear reason.
6. **Queue view UI.** The primary Curator screen becomes queue-shaped. Success: add 10 albums, watch them flow through the queue view.
7. **Observability polish.** Activity log, current-item display, retry UI. Success: from the UI alone, you can tell what Roadie is doing and diagnose failures.
8. **Pause/resume + manual retry.** Admin controls. Success: pause Roadie mid-processing, resume, verify no lost work.
9. **Crash resilience.** Kill the Curator process mid-flight, restart, verify Roadie resumes correctly. Success: no albums stuck in intermediate states after restart.

## 15. Known gotchas

- **Idempotency is table stakes.** Every sub-step must be safe to re-run. Palette Press is idempotent (same input, same output). Spotify metadata is idempotent as long as you overwrite. Art download must handle "file already exists" gracefully. If you skip this discipline for one sub-step, restarts will produce duplicates, corrupted files, or worse.
- **Retry storms.** A misconfigured backoff or a stuck retry loop can hammer Spotify. Cap total retry attempts _and_ time-in-retry-state. If an album has been retrying for more than 15 minutes, it's stuck for a reason humans need to see; transition to `errored`.
- **Concurrent Curator writes.** If a human edits an album's palette while Roadie is drafting a prompt, whose changes win? Roadie holds a per-album lock while working. If the lock is contested, human wins (Roadie retries later). Single-threaded Roadie keeps this simple — one album at a time. _(2026-07-24: "human wins" is implemented at step boundaries — the worker re-reads between sub-steps. Within the one racy sub-step (`drafting_prompts`), palette **editing** is instead rejected with 409 and the human retries at `awaiting_review`; see [ADR 0025](../adrs/0025-palette-edit-rejected-during-processing.md). **2026-07-25:** [ADR 0027](../adrs/0027-generation-is-invoked-not-pipelined.md) takes `drafting_prompts` out of the pipeline, so no processing state holds a palette and that 409 window closes — the guard is retained as defence in depth, not as a live path.)_
- **Spotify caching.** Spotify's API responses are cacheable but Roadie doesn't cache today. If you add many albums by the same artist in quick succession, the artist endpoint gets hit repeatedly. Fine at personal-collection scale (dozens of albums per session); worth adding caching if usage patterns change.
- **What "queued" means.** Adding an album puts it in the queue but doesn't immediately guarantee Roadie will pick it up (it's processing another one). The UI should distinguish "queued but not started" from "actively processing." Users have watched Roadie do nothing for 30 seconds and assumed it's broken more than once — the "waiting my turn" indicator is worth the small UI investment.
- **Prompt template drift.** If you change a style template's wording, past albums' saved prompts don't retroactively update. That's the right behavior (you don't want to invalidate a video you already generated), but the UI should make it clear when a saved prompt was drafted with a template version that's since changed.
- **The line between "errored" and "needs manual" matters.** `errored` = "something is broken, probably me, fix me." `needs_manual` = "this is a real album, but not a normal case; you should decide what to do." Both go in the same UI section but their language is different: errored says "retry?" while needs_manual says "add manually?" or "provide art?"

## 16. Future extensions

The agent design has natural growth paths:

- **Video service API** (if the tool ever supports one): a new Roadie sub-state `generating_video` that calls the API, waits for callback, downloads result, moves to `awaiting_preview_approval`. The `awaiting_video` human step disappears; humans only enter at preview.
- **Audio features return**: pattern selection is already energy-aware from the palette ([ADR 0033](../adrs/0033-palette-derived-motion-energy.md)); a returning audio-features source would refine it further — a truer energy read and tempo-locked motion — making pattern hand-edits rarer still.
- **Multi-source metadata**: Roadie could fall back to MusicBrainz for albums Spotify doesn't have. `album_not_on_spotify` stops being terminal; becomes just "moving to fallback source."
- **Auto-templating from artist history**: "for this artist, past albums used `abstract_flow` — recommend the same." Small ML/heuristic layer for template selection.
- **Batch-add intelligence**: "you just added 40 albums by the same artist — want to apply the same style template to all of them?" Contextual batch operations without a formal batch concept.

None of these need to be in the first release. They're all extensions of the state machine, not new architecture.
