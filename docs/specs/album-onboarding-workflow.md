# Album Onboarding Workflow

_How an album goes from "you own it" to "it works in the experience." Written for the queue-pull model, with Roadie handling everything automatable. Informs Curator UI design._

## 1. Purpose

Describe the human experience of getting albums into the system. This doc is the UX companion to the Curator and Roadie specs — those two describe the machinery; this describes how it feels to use.

The primary shift from the earlier version of this doc: **the queue is the entry point, not the album picker.** With Roadie automating the pre-video work, humans don't pick "which album should I work on"; they pick "which of the albums that already need me should I do next." This changes what a session is and how the UI should shape itself.

## 2. Two ways to be in Curator

Only two, and they don't overlap:

**Adding albums** — sourcing new work. You paste URIs, search Spotify, or manually enter records not on Spotify. This _creates_ queue items but doesn't process them.

**Working the queue** — draining existing work. You open Curator, see what needs you, do the next thing. Roadie has already prepared everything it could; your job is the parts that require your judgment or your physical presence.

Both flows are Curator UI screens. Neither is "a session" in a meaningful sense — a session is whatever you happen to do in a sitting, and might mix both flows or contain just one small action.

## 3. The queue is the entry point

The **default screen when you open Curator is the queue view**, not a collection browser. What you see:

```
Curator                                           ● 4 need you

┌─────────────────────────────────────────────────────────────┐
│ Needs you right now (4)                                     │
│                                                              │
│   ▸ Awaiting review (2)                                     │
│     [art] Purple Rain      — Prince      — 3m ago  [Review] │
│     [art] Blue             — Joni Mitchell — 8m ago [Review]│
│                                                              │
│   ▸ Awaiting video (1)                                      │
│     [art] Kind of Blue     — Miles Davis — 12m ago [Attach] │
│                                                              │
│   ▸ Awaiting tag write (1)                                  │
│     [art] Ziggy Stardust   — Bowie       — yesterday [Write]│
│                                                              │
│ Roadie is on it (0)                                         │
│   (queue empty)                                              │
│                                                              │
│ Needs your attention (0)                                    │
│   (none)                                                     │
└─────────────────────────────────────────────────────────────┘
```

Two properties matter here:

**The number in the app header is "needs you right now"** — nothing else. Not total albums, not errors, not queue depth. That number answers "should I sit down now?" and if it's zero, you close the app guilt-free. _(2026-07-25: was "the tab title" — Curator is a single-window Electron app.)_

**Every row has a single next-action button** — "Review," "Attach," "Write," etc. — matched to that album's current state. Click, land on the album detail, do that one thing. No "what's supposed to happen here?" moments.

## 4. What a session looks like

Sessions are shorter and more varied than the earlier "album-at-a-time from scratch" model. A few common shapes:

**The 30-second session.** Coffee, phone open. Two albums in "awaiting review." Approve one palette, copy the prompt (which auto-launches your video tool in another tab or copies to clipboard), done. Come back in 10 minutes when the video's ready.

**The video-generation-loop session.** You open Curator, see three albums in awaiting-video. Their prompts were drafted when you opened each album's Video workstation and asked for them ([ADR 0027](../adrs/0027-generation-is-invoked-not-pipelined.md)). Copy prompt A, paste in video tool, start rendering. While A renders (~5 min), copy prompt B, start B rendering elsewhere. When A finishes, attach to Curator, do preview. Cycle. This is the productive-hour shape — actively driving parallel work.

**The tag-writing session.** Sit down with 8 albums in awaiting-tag-write, a stack of stickers, your phone with NFC Tools open. Pull up album 1, scan QR to phone, tap sticker on sleeve, mark done, auto-advance to album 2. Repeat. UI supports this via "next album at this state" affordance.

**The physical verification session.** In the listening room. 3 albums in awaiting-verify. Grab a sleeve, place it on the stand, watch the lights + display come alive, click "physically verified," next. Reasonable to combine with actual listening — verifying is basically "does this album feel right when I play it?"

**The bulk-add session.** No queue work at all. Paste 40 Spotify URIs, watch Roadie kick off in the background, close the tab. Come back tomorrow to a queue full of awaiting-review items.

None of these fit neatly into "one album at a time." The album-at-a-time framing was right for the pre-Roadie world where you had to do every step yourself. In the Roadie world, sessions are shaped by _state_, not by album.

## 5. The full pipeline (visualized)

An album's journey from added to verified, showing who's doing what at each step:

```
   YOU: Add album (Spotify, paste, or manual)
              │
              ▼
   ROADIE:  Fetching metadata
            Downloading art
            Generating palette
            Drafting prompt
              │
              │  ~30 seconds later, hands off to you
              ▼
   YOU:  Review palette                        (a) approve palette
                                               (b) copy prompt to clipboard
                                               (c) launch/switch to video tool
              │
              ▼
   ELSEWHERE: Generate video (your AI service, on your schedule)
              │
              ▼
   YOU:  Attach video to Curator               drag-and-drop or from /incoming/
              │
              ▼
   CURATOR: Validate format, generate thumbnail
              │
              ▼
   YOU:  Preview (palette + video together)    approve, or reject and iterate
              │
              ▼
   YOU:  Write NFC tag on sleeve               (a) copy URI from Curator
                                               (b) NFC Tools on phone
                                               (c) tap sticker
                                               (d) mark as written
              │
              ▼
   YOU:  Verify physically                     (a) place sleeve on stand
                                               (b) watch runtime react
                                               (c) mark as verified
              │
              ▼
   DONE. Album stays in "Done" section, retrievable anytime.
```

Every YOU step corresponds to a queue state. Each state is independent — you don't have to complete "review palette" and "attach video" in the same session. The album sits at whatever state it's in until you come back and advance it.

## 6. What Roadie does (briefly)

Roadie's job is captured in its own spec; here's the summary relevant to workflow:

Between "you added an album" and "you're reviewing it," Roadie has:

- Fetched Spotify metadata (title, artist, year, genres)
- Downloaded album art
- Run Palette Press to extract a Hue-safe palette
- Drafted a video generation prompt tailored to this album (using the palette, metadata, and the album's active style template)

For a well-behaved Spotify album, this takes about 30 seconds. You'll usually see the album transition from Roadie's queue into your queue while you're still deciding what to do next.

**When Roadie can't finish** — album not on Spotify, art unusable, palette monochrome — the album lands in "Needs your attention" instead of "Needs you right now." Same queue view; different section. Clear cause visible, retry button obvious.

## 7. Working through the human-driven states

Each state has a shape: what the album needs from you, what you do, how the UI supports batch-of-similar-state work.

### Awaiting review

**What it needs**: Approval of the auto-generated palette and pattern, plus the drafted prompts getting handed off to the appropriate generation tools.

**What you do**:

1. Land on album detail from the queue
2. Look at the palette next to the album art. Feels right? Great. Something off? Edit the colors, reorder them (the top swatch is the dominant/primary), tweak roles, or re-extract from the cover ("Reset to auto"). Hand-edits set `handEdited`, which protects them from batch regenerates. If you change the palette _after_ the prompts were drafted, Curator flags those prompts as stale — their embedded colors are now out of date — so you can redraft them to match.
3. Look at the drafted **video prompts** — five fixed-angle options in the default `narrative` style ([ADR 0022](../adrs/0022-video-prompt-parity-narrative-and-per-prompt.md)). Copy any of them to take to Google Flow (copying moves the album to Awaiting Video, no confirmation step), or hit a prompt's **Generate clip** to run just that one through Omni into the clip gallery below. Optionally regenerate with a different style template.
4. Look at the drafted **card art prompts** — five fixed-angle options ([ADR 0021](../adrs/0021-card-art-five-option-prompt-strategy.md)). Copy any/all to take to Google Flow (or hit a prompt's **Generate art** to run just that one through Nano Banana), or defer if you're not making a card. Same template picker + Regenerate.

**Or skip the prompt entirely.** If you already have the video — you made it by hand, it predates the album, you generated it somewhere Curator never saw — drag it onto the video drop zone right here. The album goes straight to Awaiting Preview, skipping Awaiting Video. Copying the prompt was never a precondition for having a video; it's just the usual way you get one ([ADR 0005](../adrs/0005-video-attach-does-not-require-copying-the-prompt.md)).

**Multi-item flow**: after copying, offer "Next album in Awaiting Review" — this is when you're in "review mode" and want to blast through several palettes in a row before switching gears.

**Time per album**: 30s–2min depending on how much palette editing you do.

### Awaiting video

**What it needs**: The video file, generated externally.

**How you get here**: by copying the video prompt — i.e. "I've sent this off to my video tool and
I'm waiting on it." It's not a mandatory checkpoint: an album whose video you already had skips
this state entirely and lands in Awaiting Preview ([ADR 0005](../adrs/0005-video-attach-does-not-require-copying-the-prompt.md)).
The state exists for the parallel flow below — it's how you see what you're waiting on.

**What you do** — two ways to get the video:

- **Generate clips in-app ([ADR 0011](../adrs/0011-auto-generate-visualizer-clips.md)):** hit
  **"Generate clips with AI"** in the Video section. Curator runs each drafted video prompt variant
  through Gemini Omni Flash image-to-video off the album cover and shows the results as a gallery
  of short (~8–10s) clips with per-clip download. Then **"Splice … into loop"** (issue #29): reorder
  or deselect the clips and Curator concatenates them into one looping MP4 and attaches it as the
  visualizer — no external editor needed. Downloading a clip to splice in your own editor and
  uploading the result on the drop zone stays available as the override. Needs a Gemini key (Omni
  Flash, [ADR 0013](../adrs/0013-video-uses-gemini-omni-flash-interactions.md)).
- **Bring your own:** if your video tool has already generated something for this album, drag it onto
  the drop zone (or drop it in `/incoming/` and Curator shows it as a candidate).

Either way, Curator validates format (H.264 MP4 required), generates a thumbnail, previews inline —
confirm to advance to Awaiting Preview.

**Multi-item flow**: this is where the "productive hour" shape lives. If you have 5 albums awaiting video, you're probably driving 2–3 in parallel through your video tool. Curator's awaiting-video section should show all of them so you can quickly click into whichever finishes first.

**Time per album (in Curator itself)**: 30 seconds. Time in the video tool: variable, that's where the actual clock goes.

**Non-happy path**: you generated a video and hate it. Regenerate the prompt (maybe try a different template), send back to the video tool, try again. No Curator state change — the album stays in awaiting-video until you attach something.

### Awaiting preview

**What it needs**: Your sign-off that the palette + video composition works together.

**What you do**:

1. Click into album detail, jump to the Preview workstation
2. Watch the video play alongside the sleeve and the palette animation (bench preview — nothing leaves the window)
3. Optionally arm the room and run the **room rehearsal** — the real lights, display and Sonos
4. Decide: **Looks good** (advance) or **Something's off** (jump back to Look or Video)

**Multi-item flow**: less common. Preview is subjective; usually done one at a time. But the queue supports "next album in awaiting preview" if you're in a flow.

**Time per album**: 30s–2min (depends on how carefully you're watching).

**This is the last checkpoint before physical action.** If preview doesn't feel right, it's much cheaper to iterate on palette/video/prompt now than to write a sticker, put it on a sleeve, and realize the composition was wrong.

### Awaiting tag write

**What it needs**: An NFC sticker written and stuck on the sleeve. If a card exists for this album, its sticker too.

**What you do**:

1. Click into album detail (or the dedicated tag-write flow view)
2. Grab a blank NTAG213 sticker
3. Open NFC Tools on your phone
4. Scan the QR code Curator shows — it fills in the URI (`curator:album:2k7bxq9m`)
5. Tap phone to sticker, write
6. Stick the sticker on the sleeve in your consistent placement location
7. Click **"Sleeve tag written"**
8. If a card exists: repeat with another sticker, stick on the card, click **"Card tag written"**

**Multi-item flow**: this is the big one. If you have 8 albums in awaiting-tag-write, you sit down with a stack of stickers, headphones on, and burn through them in 15 minutes. The UI should optimize for this — big QR, big cover art (so you don't confuse sleeves), auto-advance to next album, minimal chrome. Cards can share the sitting or be a separate session.

**Time per album**: 60–90 seconds per sticker if you're in the groove. Doubles if the album has a card.

### Awaiting verification

**What it needs**: Physical confirmation that the whole runtime chain works for this album.

**What you do**:

1. Be in the listening room, near the stand and the display
2. Grab the sleeve, place it on the stand
3. Watch: lights change to the palette, video plays on the display
4. If everything looks good, click **"Verified"** in Curator (from your phone probably)
5. If something's off, you get to diagnose — often it's tag placement or a Backdrop sync issue rather than the palette

**Multi-item flow**: naturally happens when you're setting up several albums for the first time. Verify a batch, then close Curator and just listen for the rest of the evening.

**Time per album**: 30 seconds to a couple minutes, depending on how much you want to listen.

**A shortcut for the desk**: the **room rehearsal** in Preview fires a fake scan event to Conductor, Backdrop and Amp. Useful for verifying the runtime accepts the album's URI without walking to the listening room. Doesn't replace physical verification (you still want to make sure the sticker's readable at the right position), but catches a lot of "does this play at all" issues without moving.

> **2026-07-25 ([ADR 0028](../adrs/0028-preview-bench-and-room-modes.md)):** this was a **Simulate scan** button filed under Verify, firing at two services. It is now Preview's room mode, fans out to three (Amp joins for audio), and requires the room-arm switch — because it changes the lights and starts music in a room that may have other people in it. Bench preview is the always-safe default.

## 8. The card art track (optional, parallel)

Card art is Curator-only — Backdrop and Conductor never see it. It's a physical convenience: instead of grabbing the record sleeve to trigger an album, you grab a printed business-card-sized card with the same NFC sticker on it. Same URI, same experience, less shelf shuffling.

Because it's optional and Curator-only, it doesn't fit into the queue-state model. It runs as a parallel track that touches only two of the primary states:

**During "Awaiting review"**: Roadie has drafted the video prompt and the five card-art prompts. You can copy any of them, or defer the card art entirely. Deferring doesn't hold up anything.

**During "Awaiting tag write"**: if a card exists (the card art file is attached), the tag write step covers both the sleeve sticker and the card sticker. Same URI on both.

**Between those**, generating and attaching the card art is asynchronous from everything else. Two
ways to get the image:

- **Generate in-app (default, [ADR 0010](../adrs/0010-auto-card-art-generation-candidate-set.md) /
  [ADR 0021](../adrs/0021-card-art-five-option-prompt-strategy.md)):** hit **"Generate options with
  AI"** to run all five prompts through Gemini (Nano Banana) at once, or a single prompt's **Generate
  art** to run just that angle. Either way the results land in a click-to-pick thumbnail gallery;
  click the one you like and it becomes the attached card art. Needs a Gemini key (Settings); without
  one the button's action just 400s and you use the manual path.
- **Bring your own:** copy any of the five card-art prompts, generate the image in whatever tool you
  like (e.g. Google Flow), and drop the PNG/JPEG on the same Card Art section. This override works
  with or without a Gemini key.

Then:

1. Print the card at your leisure (Curator has a print-optimized endpoint at `/api/albums/:curatorId/card-art/print`)
2. Once you have the physical card, write its NFC sticker as part of the tag write step (or later, whenever)

A card can be added long after the album is otherwise `verified`. An album can also be fully verified without a card, forever. The system doesn't care; the card just makes triggering the album more ergonomic.

## 9. Adding albums (feeding the queue)

Not really a session shape, but worth naming. Four modes on the Add screen:

**Spotify search** — for the "I know I want this album but don't remember the URI" case. Debounced autocomplete. Click to preview, click to add.

**Paste URI** — for the "I have a list of URIs ready" case. One per line, submit all at once. Fastest bulk-add path when your albums are all on Spotify.

**Discogs collection** — for the "I already catalog my records on Discogs" case. Browse your Discogs collection (art, title, artist, year), click "Send to Roadie" per album. The album carries `metadata.source: "discogs"`; Roadie fetches the release detail + cover image off the request path, then goes to palette generation like any other source ([ADR 0017](../adrs/0017-discogs-personal-token-and-direct-images.md)).

**Manual entry** — for the "this isn't on Spotify" case. Fill out title, artist, year, upload art. Roadie skips the metadata/art steps and goes straight to palette + prompt generation. The album carries `metadata.source: "manual"` forever, but downstream everything works the same.

Once added, Roadie takes over. You can walk away.

> **Discogs integration (issue #24 / [ADR 0017](../adrs/0017-discogs-personal-token-and-direct-images.md)):**
> the collection browser needs a Discogs **personal access token** (Settings → Discogs), a separate
> auth mechanism from the Spotify login above. Cover art comes from the Discogs release image
> directly. Dedupe is per-source on the Discogs release id, so a record you have on both Spotify and
> Discogs can be added from either.

> **Spotify account login (issue #23 / [ADR 0014](../adrs/0014-spotify-user-oauth-pkce.md)):** the
> Spotify search/paste modes work with app-only catalog access and need no login. Optionally
> connecting a real Spotify account (Settings → "Connect Spotify", Authorization Code + PKCE) routes
> those lookups through the user's session and — the motivating case — **unblocks playing a record's
> album straight through the user's speakers via Spotify Connect** when the sleeve is placed on the
> stand, as an alternative to the physical vinyl. That playback flow is a follow-on; this onboarding
> workflow is unchanged by it.

## 10. Interruption and edge cases

Real workflows have interruptions. Some to design for:

**Session interrupted mid-flow.** You approve a palette and close the browser before copying the prompt. Album stays in `awaiting_review`. Coming back, the state is unchanged; the prompt is still there to copy, and the video drop zone is still open if you turn out not to need it. No lost work; no confusion.

**Video generation failed / you hate the result.** Regenerate the prompt (potentially with a different template), send back to the video tool, try again. Album stays in awaiting-video the whole time. No state churn.

**Attached wrong video.** "Detach" button on the video panel returns the album to `awaiting_video`. File stays on disk (it might be right for a different album).

**Palette review too fast, second thoughts.** Any time before verified, palette section is editable. Marking `handEdited: true` protects it from batch regenerates.

**Tag written but never verified.** Album sits in `awaiting_verify`. Fine — the album is technically usable; verification is confirmation. Collection view surfaces "N pending physical verification" so you can knock them out next time you're in the room.

**Roadie errored, you don't want to deal with it now.** The album sits in `needs_manual` or `errored` in the "Needs your attention" section. It doesn't push into "Needs you right now." You can leave it for weeks; when you're ready, retry or handle manually.

**Album deleted.** DELETE endpoint removes the asset file. Media files optional (`?deleteMedia=1`). The physical sticker on the sleeve is now orphaned — it'll scan as an unknown URI, and Backdrop/Conductor will treat it as "not in library" (see runtime overview §6). Peel it off, or leave it as a curiosity.

## 11. Related flows

The primary flow above is the common case. A few variants worth naming:

**New acquisition** — you bought a record today. Same flow starting from the Add screen. No structural difference from any other add.

**Refresh video** — your AI service improved; you want a new visualizer for Purple Rain. From album detail, click "Regenerate prompt" (or just re-copy the existing one), get a new video, attach (replaces old file). State returns to `awaiting_preview`. Everything downstream re-runs from there. Tag stays.

**Refresh palette** — Palette Press v2 shipped. From album detail, click "Reset to auto" on the palette. Palette regenerates. If the album's verified, no state change downstream (palette change doesn't invalidate video or tag). If you want to re-preview to be safe, click the preview button voluntarily.

**Batch refresh palette after algorithm upgrade** — bulk operation, not a session. Curator's batch tools handle this via `POST /api/batch/regenerate-palettes`, reached from **Settings → Library**. Hand-edited palettes are skipped by default, along with albums Roadie is still processing and any without cover art; all three are reported rather than silently passed over. It runs as a cancellable background job with a progress panel ([ADR 0029](../adrs/0029-batch-work-runs-as-a-library-job.md)) — palettes regenerated before a cancel stay regenerated.

**Override art** — you have a better scan of the album cover than Spotify's version. Upload via album detail's Artwork section. Palette auto-regenerates (with confirm dialog if palette was hand-edited). Everything downstream re-runs as needed.

## 12. What this UX implies about building

Several design principles fall out of the queue-pull model:

**Album detail is a workbench, not a form and not a wizard.** The workstation matching the album's current state is selected by default; every other one stays a click away. No "fill everything out then submit" mental model — and equally, no step order you have to satisfy before the UI will take an artifact you already have.

> **2026-07-25 ([ADR 0026](../adrs/0026-album-detail-is-a-workbench.md)):** this previously read _"other sections are collapsed or hidden depending on what makes sense."_ Hiding turned out never to make sense — artifacts arrive out of order, and a hidden section is indistinguishable from one that doesn't exist. Availability is now never a function of `roadie.state`; see [curator-ui-ux.md](curator-ui-ux.md) §4. This also settles a disagreement inside this very document, whose §5 already said each state is independent (below).

**Next-action buttons everywhere.** Every album, in every queue section, has an obvious button that says what to do next. Never make the user figure out what step they're on.

**"Next album at this state" is a first-class affordance.** After completing an action, the natural question is "am I in a flow?" If yes, jump to the next album at the same state. If no, back to queue view. Make both easy.

**Sessions are user-controlled, not system-controlled.** Curator never asks "are you sure you're done for now?" or "would you like to complete this album?" You do what you do; the state persists on disk; you leave.

**The needs-you number is the honest single metric.** "Needs you right now" tells you if there's work. If Curator ever starts showing other numbers beside it (queue depth, total albums, errors), the signal gets muddy.

> **2026-07-25:** this said "tab-title number." Curator is a single-window Electron app — there is no tab. The count lives in the app header; see [curator-ui-ux.md](curator-ui-ux.md) §8. The principle is unchanged: one number, and only that one.

**Empty queue is a valid, positive state.** When no albums need you right now, the queue view should feel accomplished, not empty. Something like "🎵 All caught up. Roadie is idle." Not a "get to work" prompt.

## 13. Preserved for the agentic future

The queue-pull model with Roadie already IS the agentic experience — just with Roadie limited to what it can do given today's tool constraints. The extensions the future brings:

**Video service API arrives.** Roadie gains a new sub-state `generating_video` that calls the video API, waits for callback, downloads and attaches the result. The `awaiting_video` human state disappears — humans jump straight from `awaiting_review` to `awaiting_preview`. Same queue view, one less step.

**Audio features return (via ReccoBeats, third-party, or Spotify re-opening).** Pattern selection is already context-aware — it reads energy from the palette ([ADR 0022](../adrs/0022-palette-derived-motion-energy.md)). A returning audio-features source would refine it further (truer energy, tempo-locked motion), making pattern hand-edits rarer still. No workflow change; palette review just has one less thing to tweak.

**Auto-verification via runtime callback.** Once Backdrop confirms it successfully played a video and Conductor confirms it drove the lights, and enough time has passed for the album to have "played through," we could mark `awaiting_verify` as complete without human input. Feasible but not worth building until we're sure the runtime is stable enough to trust.

**Multi-source metadata.** MusicBrainz fallback for albums Spotify doesn't have. Fewer manual entries.

None of these disrupt the queue-pull model. They just reduce how many states involve humans.

## 14. Metrics

Ambient signals worth surfacing for calibration, not for gaming:

- Median time in each `awaiting_*` state (which step is the bottleneck?)
- How often palette gets hand-edited (are default templates good enough?)
- How often preview is rejected and iterated (is the preview step catching real issues, or is it a rubber stamp?)
- How often verify fails and drives back to earlier states (is our composition process reliable?)
- Add-to-verified time distribution (how long does an album really take, end to end?)
- Roadie retry rate per state (where is transient failure most common?)

Ambient log-based analysis is enough. No dashboards yet.

## 15. Open questions

- **When multiple people use one Curator instance** (partner adds records too). Do queue items get assigned? Probably fine to be shared with "who did this last?" audit info in the roadie history. Not currently scoped.
- **Snooze/postpone.** Sometimes you don't want to deal with an album right now but don't want to leave it in the queue either. Not supported currently; either you do it or you don't. A "not now, remind me next week" flag is a natural add if the queue starts accumulating stale items.
- **The preview approval is subjective and can drift.** Palette-that-you-approved-in-March might feel wrong in July. Is that a "re-review" state, or do we just live with it? Current design lives with the drift. If it matters later, add a "re-review palette" action.
- **Physical verification lag.** Album is `awaiting_verify` for weeks because you haven't been in the listening room. Should the header number include it? Probably yes — you should feel that lag. Alternatively, exclude verification-only items from the count as "low urgency." Current design includes them.
- **Onboarding the first 50 albums vs steady-state.** The first burst has a different rhythm than ongoing additions. Is there a "setup mode" that changes UI? Currently: no; the queue view handles both. Revisit if the first-run experience feels wrong in practice.
