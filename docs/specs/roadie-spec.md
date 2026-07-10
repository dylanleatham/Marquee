# Roadie — Curator's Background Agent

_Does the setup work behind the scenes before you take the stage. Lives inside Curator; not a separate service._

## 1. Purpose

A background worker inside Curator that picks up newly-added albums and runs them through every step it can complete autonomously — fetching metadata, downloading art, generating palettes, and drafting the video and card art prompts. When it hits a step that requires a human (subjective review, running the external art or video tools, physical actions), it parks the album in a specific queue state and stops.

Roadie also keeps Backdrop in sync with Curator's committed state, triggering the video file rsync when an album's video is attached, and doing a final sync verification when the album reaches `verified`. This closes the loop: by the time the human confirms an album is done, the runtime Pi has everything it needs.

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
- Pattern selection driven by audio features (Spotify Audio Features deprecated; static defaults fine)
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
                            │           │         │  │  verified         │
                            │           ▼         │  │  (done)           │
                            │  awaiting_video     │  │                   │
                            │           │ ★sync   │  │  needs_manual     │
                            │           ▼         │  │  (Roadie gave up, │
                            │  awaiting_preview   │  │   labeled clearly)│
                            │           │         │  │                   │
                            │           ▼         │  └───────────────────┘
                            │  awaiting_tag_write │
                            │           │         │
                            │           ▼         │
                            │  awaiting_verify    │
                            │           │ ★verify │
                            │           ▼         │
                            └─────────────────────┘

  ★ = Roadie sync triggers on human-driven transitions (see §6):
      ★sync   = rsync video file to Backdrop's SD card
      ★verify = call verify-sync endpoint, log any discrepancies
```

Two important properties:

- **Roadie only _forward_-transitions.** It never moves an album backward. If a human explicitly resets a step (regenerate palette, replace video), that's a human action; Roadie doesn't second-guess. Sync failures at the ★ triggers also don't move backward — they're logged as issues on the album.
- **Roadie's own progress states (fetching_metadata, downloading_art, etc.) are fine-grained.** This is deliberate — when Roadie crashes or the process restarts, it should be able to resume from the last completed sub-step, not restart from `fresh`. Each sub-step is idempotent.

## 6. What Roadie does at each Roadie-driven state

### fetching_metadata

- Input: album's Spotify URI (from the Add screen)
- Action: call Spotify `/albums/{id}` for title, artist, year, art URL, genres (via artist), track list
- Success: store metadata in asset file, transition to `downloading_art`
- Failure modes:
  - 404: Album genuinely doesn't exist on Spotify → transition to `needs_manual` with reason `album_not_on_spotify`
  - 429 rate limit: retry with backoff
  - Auth error: transition to `errored` (config problem, needs admin attention)

### downloading_art

- Input: art URL from previous step (or manually provided art via `override_art_url` in asset file)
- Action: fetch art bytes, hash for cache invalidation, save to `media/artwork/{curatorId}.jpg`
- Success: transition to `generating_palette`
- Failure: retry with backoff; after 3 fails, `errored` with reason

### generating_palette

- Input: album art bytes
- Action: call Palette Press library synchronously; apply post-processing
- Success: save palette to asset file, transition to `drafting_prompts`
- Special case: post-processor returns fewer than 2 usable colors (monochrome art, etc.) → save whatever was extracted, transition to `awaiting_review` with a flag `palette_insufficient: true`. Human decides — either accept or hand-craft a palette. Not an error; a real album can genuinely be monochrome.

### drafting_prompts

- Input: album metadata (title, artist, year, genres) + generated palette + user-selected style templates per prompt type
- Action: run the prompt-drafting logic (see §7) for both `video` and `cardArt` prompt types, save both to `promptDrafts` in the asset file
- Success: transition to `awaiting_review`
- Failure modes: prompt-drafting is deterministic and should not fail. If it does, log verbosely, transition to `errored`.

### Backdrop sync triggers

In addition to the sub-states above, Roadie observes two transitions in the human-driven part of the lifecycle and triggers Backdrop synchronization:

**On video attach** (`awaiting_video` → `awaiting_preview`): Roadie initiates an rsync of the newly attached video file from Curator's media store to Backdrop's SD card. Video files are large; syncing eagerly at attach time means the preview and simulate-scan flows have the real file available on the Pi when the user tries them. The metadata push to Backdrop's `library.json` already happened via Curator's post-save hook — Roadie doesn't duplicate that work, only the file sync.

**On verified** (any → `verified`): Roadie runs a final sync verification by calling Curator's `POST /api/backdrop/verify-sync` endpoint. Any discrepancies (missing files, stale metadata) are logged as issues on the album — the album stays `verified` because the human confirmed it works physically, but the sync warning surfaces on the album's detail view so it can be resolved before the next play.

Sync failures never move albums backward through the state machine. They're recorded as issues; the human decides whether to retry, investigate, or ignore. This preserves the invariant that "Roadie only forward-transitions" — sync is a side effect, not a state.

## 7. Prompt drafting

Roadie drafts two prompts per album: one for the visualizer video that plays on Backdrop, and one for the business-card art that gets printed and stuck onto the physical card. Both use the same inputs — album metadata + palette — but have different templates suited to their output medium.

### Video prompt structure

```
[Video style template preamble — user-selectable]
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

```
[Card art style template preamble — user-selectable]
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

Users pick templates independently for each type on the album's detail page — you might want a `psychedelic` video paired with a `typographic` card. Roadie's defaults when unspecified: `abstract_flow` for video, `iconic_emblem` for card art.

Prompt drafting has no external dependencies — pure function of album metadata + palette + template. Fast, testable, deterministic given inputs. Same testing story for both prompt types.

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

The number in the browser tab title should be **the count of "needs you right now"** — because that's the number that tells you how much work is waiting.

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
- **Concurrent Curator writes.** If a human edits an album's palette while Roadie is drafting a prompt, whose changes win? Roadie holds a per-album lock while working. If the lock is contested, human wins (Roadie retries later). Single-threaded Roadie keeps this simple — one album at a time.
- **Spotify caching.** Spotify's API responses are cacheable but Roadie doesn't cache today. If you add many albums by the same artist in quick succession, the artist endpoint gets hit repeatedly. Fine at personal-collection scale (dozens of albums per session); worth adding caching if usage patterns change.
- **What "queued" means.** Adding an album puts it in the queue but doesn't immediately guarantee Roadie will pick it up (it's processing another one). The UI should distinguish "queued but not started" from "actively processing." Users have watched Roadie do nothing for 30 seconds and assumed it's broken more than once — the "waiting my turn" indicator is worth the small UI investment.
- **Prompt template drift.** If you change a style template's wording, past albums' saved prompts don't retroactively update. That's the right behavior (you don't want to invalidate a video you already generated), but the UI should make it clear when a saved prompt was drafted with a template version that's since changed.
- **The line between "errored" and "needs manual" matters.** `errored` = "something is broken, probably me, fix me." `needs_manual` = "this is a real album, but not a normal case; you should decide what to do." Both go in the same UI section but their language is different: errored says "retry?" while needs_manual says "add manually?" or "provide art?"

## 16. Future extensions

The agent design has natural growth paths:

- **Video service API** (if the tool ever supports one): a new Roadie sub-state `generating_video` that calls the API, waits for callback, downloads result, moves to `awaiting_preview_approval`. The `awaiting_video` human step disappears; humans only enter at preview.
- **Audio features return**: pattern selection becomes Roadie-driven instead of static, closing another human decision.
- **Multi-source metadata**: Roadie could fall back to MusicBrainz for albums Spotify doesn't have. `album_not_on_spotify` stops being terminal; becomes just "moving to fallback source."
- **Auto-templating from artist history**: "for this artist, past albums used `abstract_flow` — recommend the same." Small ML/heuristic layer for template selection.
- **Batch-add intelligence**: "you just added 40 albums by the same artist — want to apply the same style template to all of them?" Contextual batch operations without a formal batch concept.

None of these need to be in the first release. They're all extensions of the state machine, not new architecture.
