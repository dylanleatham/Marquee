# Curator — UI/UX Spec

_How Curator looks and behaves. Companion to [curator-spec.md](curator-spec.md), which owns the API,
data shapes, and on-disk layout. Where the two disagree about the UI, this document wins._

## 1. Purpose and status

Curator's visual design arrived by implementation, not by decision: the only record of it was a
comment at the top of `packages/curator/ui/src/styles.css`. Its interaction model was specced once
(curator-spec §10, "session-shaped") and then contradicted by every feature added afterward.

This document ratifies the former and replaces the latter. It records the design conversation of
**2026-07-25** and the three ADRs that came out of it:

- [ADR 0026](../adrs/0026-album-detail-is-a-workbench.md) — the album detail is a workbench, not a guided session
- [ADR 0027](../adrs/0027-generation-is-invoked-not-pipelined.md) — generation is invoked, never pipelined
- [ADR 0028](../adrs/0028-preview-bench-and-room-modes.md) — preview has bench and room modes; hardware requires arming

> ### Status, 2026-08-06 — the overhaul has landed
>
> [**ADR 0052**](../adrs/0052-curator-is-three-places-not-a-nine-state-queue.md) replaces this app's
> information architecture and its whole visual language: Curator becomes **three places** — the
> collection, the record, the room — and "backstage marquee" becomes **"Pressing Plant"**. The design
> handoff it implements is in `docs/design_handoff_curator_overhaul/`.
>
> It shipped in stages, so this spec is part new and part historical. Read it accordingly:
>
> | Section                | State                                                                                                                    |
> | ---------------------- | ------------------------------------------------------------------------------------------------------------------------ |
> | §3 design language     | **Rewritten.** Pressing Plant, as built.                                                                                 |
> | §8 the collection      | **Rewritten.** Replaces the queue view, as built.                                                                        |
> | §5 the record          | **Rewritten.** All four panels built; the rail is deleted.                                                               |
> | §6 the room            | **Rewritten.** Bench and the Demo Room are one screen; §8.6 adds the ready toast.                                        |
> | §8.5 system            | **Rewritten.** The album matrix is replaced by an exception list.                                                        |
> | §8.7–§8.9              | **New.** Add a record, Discogs, Settings.                                                                                |
> | §9.1 keyboard          | **Withdrawn.** The accelerator layer is removed.                                                                         |
> | §4 workbench principle | **Kept, its rail deleted.** "Providing an artifact is never gated" survives; the five stations that expressed it do not. |
> | §9.2–§10               | Unchanged.                                                                                                               |
>
> **Every screen is on the new theme**, and `styles.css`'s legacy block — which repointed the old
> variables so an un-migrated screen still rendered — is deleted with the last screen that needed it.
>
> Nothing below is deleted — a spec that loses its history can't explain why the code looks the way it
> does, or why a decision was reversed.

## 2. The frame — a desktop app, not a website

Curator ships as an Electron app ([ADR 0008](../adrs/0008-desktop-app-supervises-services.md)):
one window, `1360×900` default, `900×600` minimum, `autoHideMenuBar: true`. It is served over
`http://localhost` and built with React + Vite, but it is **not a web page**, and four things follow
from that:

1. **You own the window.** Content is not capped at web reading width for its own sake. A layout may
   constrain a text column; it may not leave a third of the window empty by default.
2. **There is no browser tab.** Any "put it in the tab title" affordance is dead on arrival — the
   count lands in the OS title bar, which is invisible while the window is focused. See §8.
3. **There is no browser chrome.** No back button, no address bar, no bookmarks. The app supplies its
   own navigation, its own menu, and a keyboard path (§9).
4. **Native `confirm()` / `alert()` are out of place.** They render as OS-chrome dialogs in an app
   that otherwise controls its own surface, they can't be styled, and they block the renderer.
   Destructive confirmation uses an in-app dialog matching §3.

Curator is a **workstation tool**. It is not designed for phones or tablets; a viewport narrower than
`minWidth` is not a supported configuration. Responsiveness exists to serve window resizing on a
desktop, not device classes.

## 3. Design language — "Pressing Plant"

> **Rewritten 2026-08-04** ([ADR 0052](../adrs/0052-curator-is-three-places-not-a-nine-state-queue.md)).
> This section used to specify **"backstage marquee"** — warm near-black `#14110f`, theater-amber
> `#f5a623`, `10px` radii, Inter. That theme is gone. While the overhaul was mid-flight `styles.css`
> carried a marked **legacy block** repointing the old `--bg`/`--panel`/`--amber` variables at the
> tokens below, so an un-migrated screen still rendered; it was **deleted 2026-08-06** with the last
> screen that needed it. The old names are recorded here only to make an old screenshot legible.

Light, printed, editorial.

> Warm paper stock, ink black, one brick-red accent. Hairline rules instead of cards; grid gutters
> are borders, so the collection reads as ruled paper. Nothing is rounded. The signature is the
> pulsing accent dot wherever Roadie is present.

### 3.1 Tokens

Defined in `:root` in `styles.css` as `--pp-*`. These names are the contract; components reference
tokens, never literal hex.

| Token               | Value     | Role                                                               |
| ------------------- | --------- | ------------------------------------------------------------------ |
| `--pp-paper`        | `#f2efe8` | App ground, and reversed text on ink.                              |
| `--pp-paper-sunk`   | `#efebe2` | Stat bands, sidebars, secondary panels.                            |
| `--pp-paper-raised` | `#f7f4ee` | The in-use palette card, tag panels, the toast.                    |
| `--pp-paper-log`    | `#eae5da` | The expanded Roadie log.                                           |
| `--pp-rule`         | `#d8d2c4` | Every hairline divider.                                            |
| `--pp-rule-soft`    | `#c9c2b1` | Input underlines, unselected outlines.                             |
| `--pp-dashed`       | `#b3ab99` | Empty-state dashed borders.                                        |
| `--pp-ink`          | `#17150f` | All primary text, bars, filled buttons.                            |
| `--pp-ink-muted`    | `#6f6a5c` | Secondary text, mono labels.                                       |
| `--pp-ink-faint`    | `#8d8778` | Tertiary text, captions.                                           |
| `--pp-ink-ghost`    | `#a49d8c` | Ids, prompt numbers.                                               |
| `--pp-accent`       | `#b4402c` | **The** accent: not complete, Roadie's presence, the current stat. |
| `--pp-accent-text`  | `#8e3122` | The accent as body text, where the lighter one loses contrast.     |
| `--pp-accent-wash`  | `#f7ece9` | The Stuck row, a failing service, unmatched Discogs rows.          |
| `--pp-positive`     | `#3f7d4e` | Reachable services, "written", "saved a moment ago".               |
| `--pp-amber`        | `#e0a24a` | Fader accent — **inside the dark room only**.                      |
| `--pp-room-floor`   | `#0d0a10` | The room's base, before the palette wash.                          |

Three rules the tokens don't carry on their own:

- **Nothing has a border radius. Zero.** Buttons, inputs, panels and the toast are all square. The
  one round thing in the app is a status dot (`border-radius: 50%`).
- **No shadows anywhere except the toast** (`0 10px 30px rgba(23,21,15,.24)`).
- **Album artwork uses `outline`, never `border`**, so the state treatment can't move the layout: ink
  for ready, `--pp-rule-soft` for not complete, `2px` accent for Roadie-is-on-it.
- **A not-complete sleeve is never dimmed.** The mark is a folded corner drawn inside the outline
  ([ADR 0054](../adrs/0054-not-complete-is-a-folded-corner-not-a-dimmed-sleeve.md)); the artwork
  itself always renders at full contrast, because showing it is what the screen is for.

**The accent is scarce by design**, and it does more work than amber did — it now carries
"not complete" across a whole wall of records. That makes §3.4 load-bearing rather than advisory.

### 3.2 Type

Three families, each with one job:

| Family  | Stack                              | Job                                       |
| ------- | ---------------------------------- | ----------------------------------------- |
| Display | Archivo Black 400 only             | Numbers, screen titles, record titles.    |
| Body    | Helvetica Neue / Helvetica / Arial | Everything readable.                      |
| Mono    | IBM Plex Mono 500/600              | Labels, counts, times, hex, ids, buttons. |

Archivo Black and IBM Plex Mono are loaded from Google Fonts in `index.html`; Helvetica is a system
stack and is never loaded. Both webfonts have real fallbacks, because Curator is a desktop app that
is expected to work away from the internet.

Base body is `13px / 1.45`; prose is `15px / 1.65` capped at `62ch`.

The distinctive move is the **mono label**: `9.5px`, `letter-spacing: .18em`, uppercase,
`--pp-ink-muted`. **Every uppercase label is genuinely uppercase in the markup**, not
`text-transform`-ed — so it is uppercase to a screen reader and to a copy-paste too. The masthead
wordmark is the single exception.

### 3.3 Motion

Motion carries state, never decoration. Four sanctioned animations, all named `pp*`:

- **`ppPulse`** (`2.4s`) — Roadie is present: the masthead dot, the log's dot, a loading screen.
- **`ppDrift`** (`26s`) — the room's palette wash. Inset `-6%` on all sides so the drift never
  reveals an edge.
- **`ppToast`** (`5s`, forwards) — the ready toast's whole life.
- **Transitions** — `500–600ms` crossfades where the runtime itself crossfades, so what you rehearse
  matches what Backdrop does.

`prefers-reduced-motion: reduce` disables animation globally, `ppDrift` included. The prototype did
not respect it and should have — a slow full-screen drift is exactly what that setting exists for.

Animation that loops runs **only while it can be seen** — gated on tab visibility, and on an
`IntersectionObserver` where the element can scroll away. The shared `useVisibleCycle` hook owns
this so each new preview inherits it rather than growing its own bare `setInterval`
([#136](https://github.com/dylanleatham/Marquee/issues/136)).

### 3.4 State is never encoded in colour alone

Every state indicator pairs its colour with a text label, a glyph, or a shape. A green dot alone is
not a status; "● Ready" is.

This is a **repeat class**, not a hypothetical: Backdrop shipped a connection indicator that was
unreadable without colour vision (`37ffdae`, PR #85). The rail's readiness dots (§5) are the exact
same shape of risk, so the rule is written down here rather than rediscovered a third time.

This section is the reason the accent can carry "not complete" across a whole wall of records. On the
collection, a record that isn't finished is marked **three ways at once** — a paler outline, a folded
corner on the sleeve, and the need spelled out in words underneath. Roadie's is marked by outline
_weight_ as well as hue. Remove the words and the grid becomes unreadable to this project's own user.

The middle signal was `opacity: 0.62` on the artwork until
[ADR 0054](../adrs/0054-not-complete-is-a-folded-corner-not-a-dimmed-sleeve.md) replaced it with the
fold: dimming the sleeve degraded the one thing an art-first grid exists to show, and it did so for
most of the wall, since "not complete" is the common case on a collection mid-build. A shape is the
better answer here anyway — it reads as an absolute rather than by comparison with a brighter
neighbour, so it survives a screen where every record is unfinished.

### 3.5 Focus

Every interactive element has a visible focus ring that meets 3:1 against its own background. This is
not negotiable: the accelerator layer went away (§9.1) but keyboard _reachability_ did not, and it is
an accessibility floor rather than a power-user feature.

Pressing Plant's ring is `2px solid --pp-ink` at `2px` offset — a **shape**, which is what makes it
readable without colour. On ink-filled controls it inverts to paper and moves inside, so it never
disappears into the fill. The design prototype had no focus states at all; they were added here.

Contrast: `--pp-ink-muted` on `--pp-paper` is ≈4.7:1 and `--pp-accent-text` on `--pp-paper` is
≈5.6:1, both clearing AA for body text. `--pp-accent` is used for large type, rules and fills rather
than small body copy, which is why `--pp-accent-text` exists at all. Any new token pair must be
checked before it lands.

## 4. The workbench principle

> **The principle survives; the rail that carried it does not (2026-08-05,
> [ADR 0052](../adrs/0052-curator-is-three-places-not-a-nine-state-queue.md)).** "Providing an
> artifact is never gated" was right, and the record page keeps it — all four needs are open at all
> times. What went is the **five-station rail** that expressed it, along with the readiness chips,
> the stepper and the `1`–`5` keys. `rail.ts`, `PeerNav.tsx`, `PaletteEditor.tsx` and
> `AlbumDetail.tsx` are deleted; the record page is specified in §5 below.
>
> The rail's own failure was subtler than gating: it asserted an **order** — Look → Video → Card →
> Preview → Ship — that the system does not have. Nothing requires lights before a visualizer. The
> replacement makes the four needs independent predicates over the assets, so "any order" is true by
> construction rather than by a rule the UI has to keep.

**The album detail page is a workbench, not a guided session** ([ADR 0026](../adrs/0026-album-detail-is-a-workbench.md)).

You frequently arrive holding an artifact for a _later_ stage without having done an _earlier_ one —
a visualizer already rendered, card art already commissioned. A UI that reveals sections in state
order makes that normal case impossible and forces busywork to unlock a drop zone.

The governing rule:

> **Providing an artifact is never gated. Advancing state is gated — and the gate is shown, not hidden.**

Concretely:

- **Always live**, whenever their inputs exist: drop zones, palette edits, prompt copies, artwork
  override, downloads. Never conditioned on `roadie.state`.
- **Gated, and visibly so**: actions with real preconditions the API enforces — e.g.
  `verify-physical` returns `4xx` outside `awaiting_verify`. These render **disabled with the reason
  stated in place** ("Verify unlocks once the sleeve tag is marked written"). They are never absent,
  because an absent control is indistinguishable from a control that doesn't exist.
- **Roadie's state drives emphasis and queue placement — never availability.** It answers "what
  should I look at first," not "what am I permitted to touch."

The one legitimate hard block is a genuine write conflict: palette actions return `409` while Roadie
is processing ([ADR 0025](../adrs/0025-palette-edit-rejected-during-processing.md)). That is a lock,
not a workflow gate, and it surfaces as an explained `409`, not a hidden section.

This generalizes a decision the repo already made once in
[ADR 0005](../adrs/0005-video-attach-does-not-require-copying-the-prompt.md) ("the drop zone is live
from `awaiting_review` onward, so a video you already have can be attached without touching the
prompt") but never stated as a rule — which is why sections added afterward re-litigated it
privately and two of them landed the other way.

## 5. The record

> **Rewritten 2026-08-05** ([ADR 0052](../adrs/0052-curator-is-three-places-not-a-nine-state-queue.md)).
> All four panels are built and the rail is deleted. §5.2 below is kept as the record of what it was.

One page listing the four things a record still needs — **Lights · A visualizer · A card · Tags** —
done in any order. No stepper, no rail, no machine-state name.

> **A fifth tab that is not a need (2026-08-08,
> [ADR 0058](../adrs/0058-a-demo-tag-plays-one-chosen-track.md)).** **A demo cut** sits after the four,
> past a hairline, in italics — with **no `●`/`○` glyph** and the screen-reader text "optional". A
> demo cut is a preference most records never express, so counting it would put a permanent
> outstanding item on several hundred finished records — the misreading
> [ADR 0056](../adrs/0056-need-labels-name-the-act-not-the-artifact.md) exists to prevent. `Need` and
> `RecordSection` are separate types in `needs.ts` for exactly this reason, and the collection's tile
> labels are unchanged. See §5.3.

**A 310px sidebar**, top to bottom: `← THE COLLECTION`, the cover, a 26px strip of the live palette,
the title in Archivo Black 25px, the byline, the state label, and a full-width ink
`▶ SEE IT IN THE ROOM`. Pinned to the bottom: `↑ PREV`, `NEXT ↓`, and **the one place in the app an
album id may appear** — small, muted, never inside a sentence.

`↑ PREV` / `NEXT ↓` walk the collection in `GET /api/albums` order, deliberately **not**
`GET /api/albums/:id/peers`: that endpoint walks same-state buckets, which is the nine-state model
the UI no longer shows, so a run through it would step by a rule nothing on screen explains. The run
does not wrap — at the end the honest answer is "that was the last one", and the button says so.

**The needs tabs.** Each carries a filled `●` or hollow `○` glyph plus screen-reader text saying
"done" or "still needed", so the two questions — which tab am I on, what is left — never share one
channel. The open tab is ink text with a `2px` accent underline. **Every tab is always open**: §4's
principle, minus the rail.

**Opening a record always lands on Lights**, whatever is outstanding. A click from the collection is
then predictable rather than dependent on state you can't see from the tile.

**Preview is not a tab.** Signing the lights off means having watched them, so that lives in the room.

### 5.0 The Lights panel

- **Edits autosave**, debounced, with a quiet "saved a moment ago — edits save as you make them"
  line that states the _rule_ as well as the state. There is no Save button, no Discard and no `⌘⏎`.
  Three things this has to get right, because autosave that loses work is worse than a button:
  a half-typed hex holds the write back rather than being sent and rejected; a burst of picker
  drags coalesces into one write; and an edit still inside the debounce window is **flushed on
  unmount**, so navigating away cannot silently discard it.
- **One sign-off line**, under the autosave line and one notch quieter: "signed off <when>", or
  "not signed off yet — **see it in the room**" with the link. Added 2026-08-08
  ([ADR 0063](../adrs/0063-the-machine-is-settled-from-the-asset-not-driven-by-the-button.md)): the
  tab strip's `●`/`○` reported the state without offering any way to act on it, which is exactly how
  the user's report read — "the circle is always open and I can't mark it as verified". It is a
  sentence and a link, **never a second approve button**: sign-off still happens only in the room,
  because it means having just watched the record.
- **Roadie's note**, as prose at 15px/1.65 capped at 62ch — when there is one. A plain cover
  extraction has no note, and the panel shows nothing rather than inventing a sentence.
- **Two source palettes side by side** — FROM THE SLEEVE and FROM THE FEELING — inside one ink
  border. The one in use is raised, marked `· IN USE`, and its action reads "IN USE"; the other reads
  "USE THIS INSTEAD →". A feeling palette that has not been proposed yet offers `◈ ASK FOR THESE`,
  marked as a control that spends money (§7). **Both are permanent**: switching destroys neither, and
  the feeling palette does not disappear once suggested — see the API note below, because that was
  not true of the server until ADR 0052.
- **THE LIGHTS, IN ORDER** — one row per colour: swatch, hex, role, and **where it lands in the
  room** ("the wall wash", "the far corner", "the glow behind the stand"), then reorder/remove.
  Order is the meaning, so the role follows position and the old per-row role dropdown is gone. Past
  the third colour the row reads "held in reserve" rather than naming a place the lights don't have.
- `+ ADD A LIGHT` and **BACK TO ROADIE'S ORIGINAL** (which replaces "reset to auto"/"start over"),
  then the line promising both palettes are recoverable.

Dropped from the old Look station and **not** to be reinstated: the artwork override, the source
badge, the genre tags, and the raw `{"transitionMs":…,"holdMs":…}` JSON.

**Moved, not dropped: how the lights _move_.** The Motion picker
([ADR 0039](../adrs/0039-one-motion-picker-clip-patterns-are-selectable.md), driving
`PUT /api/albums/:curatorId/pattern-override`) belongs in the room's control dock — **LIGHT
PATTERN**, beside transition, hold and brightness — because those are things you judge by watching,
not by reading a list. That is the whole reason colour editing stays here and movement goes there.

> **Closed 2026-08-09.** The gap was real twice over. The picker was deleted with the rail, leaving no
> way to set motion at all; the room then landed with a picker offering three of the eight answers,
> which is how it was in fact discovered later as a bug report
> ([#287](https://github.com/dylanleatham/Marquee/issues/287)). The dock now carries all eight —
> §6's "The dock's LIGHT PATTERN group is the Motion picker, in full".

> **Two API changes this panel required** (ADR 0052), both because the screen makes a promise the
> server did not keep:
>
> - `POST /palette/generate` no longer deletes `paletteCandidates`. It re-points `cover` and `blend`
>   at the new extraction and **keeps `feeling`** — which is about how the record _sounds_, and which
>   re-extracting a sleeve does not invalidate. Before, "back to Roadie's original" silently threw
>   away a palette that costs a Gemini call to recover.
> - `PUT /palette` carries `rationale` forward instead of dropping it. The note is prose about the
>   record, not a claim about exact hexes, and the panel shows it above the editor — so nudging one
>   swatch used to erase it.

### 5.1 The visualizer, card and tags panels

Built 2026-08-05. Together with §5.0 they replace the Video, Card and Ship workstations outright.

**A visualizer.** The attached clip **plays here, looping, washed in the record's own palette** —
the same `radial-gradient` the room uses, because judging whether a clip belongs to _this_ record is
the only thing this panel is for, and a still frame on paper stock cannot answer that. Its position
and resolution sit in the corners. `REPLACE · REMOVE · PICK A FILE`; **no "paste a link"** — a URL is
not a file, and the one that mattered was always local.

Beneath it, the **Backdrop strip carries all three of its states**: uploading (percent _and_ bytes,
never the bar alone), a quiet green "on Backdrop", and a failure with its **RETRY right here** rather
than only on the System screen. A clip attached in Curator that never reached Backdrop plays as a
black screen in the room, and the old panel said nothing at all once the transfer stopped — success
and failure looked identical, which is the case
[ADR 0038](../adrs/0038-curator-pushes-media-over-http.md) exists to prevent.

**Both legs of the transfer report, not just the second** (2026-08-09,
[issue #284](https://github.com/dylanleatham/Marquee/issues/284)). The strip above describes Curator
→ Backdrop. The leg before it — browser → Curator, which is the one carrying the file the user just
picked — said nothing at all: the panel kept reading `No visualizer yet` (or kept playing the old
clip on `REPLACE`) until the server answered, so a several-hundred-megabyte clip looked like a press
that missed. It now gets the same strip and the same numbers: the file's name, percent _and_ bytes,
an ETA once there is enough to make one honestly. Once every byte is out it stops claiming a
percentage and says `Adding <file> to the record…` — against a local Curator the probe and the copy
are most of the wait, and a bar parked at 100% for them reads as a stall. While it runs, the controls
that would start a second upload are shut. The card panel's `UPLOAD MY OWN` had the identical
silence and gets the identical strip.

> **No `STOP` on this one**, unlike the Backdrop strip beside it. That one cancels a server-side job
> through a route built to be cancelled; aborting an HTTP request mid-body only stops the browser
> talking — the server may already have the whole file and attach it anyway, so the button would be
> free to lie. Left out rather than faked.

A 280px side panel lists **every drafted prompt, numbered, each separately copyable**. The old bench
showed one behind a variant chooser, so the rest may as well not have been written. `LET ROADIE MAKE
IT` is marked `◈` as a control that spends, and says why it is off when it is.

**`LET ROADIE MAKE IT` generates and then joins, in one press.** `generateVideoSet` returns several
`videoClips`; this page shows a _visualizer_. The old bench closed that gap with a gallery and a
manual splice step ([issue #29](https://github.com/dylanleatham/Marquee/issues/29)); the design has
neither, so the button does it — a clip per draft, spliced in index order into the attached loop.
Stopping at the clips would leave the button looking like it did nothing, because nothing on this
page can render them.

While it runs, the panel reports **items done of total** (a clip is a multi-minute call and there is
one per draft, so this is a long wait) and offers `STOP`. It re-attaches to a running job on mount,
so a reload mid-run resumes and still splices.

> **Two cases the automatic join cannot cover**, and one strip that covers both: the app was closed
> while the job ran — `useGenerationJob` adopts an already-finished job without re-firing its
> completion — or the splice itself failed. Either way the clips are on disk with nothing attached,
> which is invisible on a page that only renders a visualizer. So when clips exist and no visualizer
> does, the panel says how many there are and offers **MAKE THE LOOP**.

> **The design asks for four drafts; the backend writes five, and it still writes five.**
> `PROMPT_VARIANTS` is shared with card art, and the narrative metaprompt names its five options in
> prose — so cutting to four means choosing an option to delete, which is a content decision with no
> obvious winner, not a constant to edit. The requirement that actually mattered ("four, **not
> one**" — every draft visible and separately copyable) is met by rendering however many exist. The
> panel is headed `ROADIE'S DRAFTS · n`, so it stays honest if the count ever changes.

**A card.** The candidates, **7:5 landscape, two up** — the old gallery was a 140px auto-fill grid,
and thumbnails that small cannot be judged, which is the only thing this screen is for. The one in
use gets a `2px` accent outline, full opacity, an `IN USE` mark and a `DOWNLOAD`; the rest sit at
`opacity:.5` with `USE THIS ONE INSTEAD`.

> The design shows four. **The grid renders however many exist** — `generateCardArtSet` draws one per
> drafted prompt, which is `PROMPT_VARIANTS` (5) today, the same count the visualizer drafts carry
> and for the same shared reason. Two-up at 7:5 is the requirement; four was the mock's arithmetic. **"Use", never "keep"** — keep read as a commitment when
> the choice is free to change. **Download, not a print sheet**: you take the one you are using, and
> `/card-art/print` belonged to a workflow that no longer exists.

The attached card is matched to its candidate by **`fileId`, not index** — a regeneration renumbers
the candidates, and matching on index would put the `IN USE` mark on whichever card landed in that
slot. A candidate whose image won't load is dropped rather than shown as a broken glyph.

> **`EDIT THE PROMPT` is not built.** The design lists it beside "ask for more" and "upload my own",
> but there is no API for editing a drafted prompt's text by hand — only selecting a variant or
> asking Gemini to redraft. Left out rather than faked; it needs a backend before it needs a button.

**Tags.** THE SLEEVE, THE SHELF CARD and THE DEMO TAG, each with its **real QR** (the server renders
it from the URI; the prototype's checkerboard was a stand-in), its `curator:album:` / `curator:card:` /
`curator:demo:` URI, and its written state as a word plus a tick. Then `SEND THIS RECORD TO THE
FLIPPER · DOWNLOAD .NFC · DOWNLOAD DEMO .NFC · HOW DO I WRITE THESE?` — **per record only**; the bulk
"send the whole list" went with the queue, because you write these standing at the shelf, one at a
time.

> **The demo tag is the odd one of the three (ADR 0058)**, and the panel says so in two ways. It
> **states what it will play** — the chosen cut by name, or "no cut chosen — plays the whole record",
> because with nothing chosen it behaves exactly like the shelf card and a screen that stayed silent
> would make that look like a bug. And it is the one sticker `TAGS VERIFIED` **never** marks, because
> that button covers only the two stickers every record gets: claiming a demo tag was written when you
> never made one is a lie on the one screen whose job is catching mis-written stickers. (Its own
> `I'VE WRITTEN THIS ONE` was the demo tag's alone until 2026-08-08; all three carry one now — see
> [ADR 0062](../adrs/0062-the-tag-step-is-recorded-on-the-asset-not-on-the-machine.md). What stays
> unique to it is being outside the one-press check.)

Below a hairline, set apart on purpose: **THEN CHECK THEM**, and **one `TAGS VERIFIED` button
covering the sleeve and the card**. Marking the sleeve written and the card written were bookkeeping about a single
act at the Flipper; the _check_ — tapping each tag and confirming it opens the right record — is the
only part that is a decision, and it is where a mis-written sticker turns up. So verification stays
its own visually separated step, and it is one press.

> **Resolved 2026-08-08** ([ADR 0062](../adrs/0062-the-tag-step-is-recorded-on-the-asset-not-on-the-machine.md),
> [#261](https://github.com/dylanleatham/Marquee/issues/261)). This paragraph used to say the gate was
> shown rather than hidden: `TAGS VERIFIED` was disabled with its reason until the record reached the
> tag step, and the tension between "any order" and a linear machine was "real and not resolved
> here". It was not survivable. The only exit from `awaiting_review` is attaching a visualizer, so on
> the real collection **478 of 499 records could not record a tag at all** — and with no per-sticker
> control on the sleeve or the card, nothing else on the panel could either. The tag step is now
> recorded on the asset whatever the state; the machine advances only as far as it legally goes. The
> one reason left to withhold the press is `checked <when>`.
>
> **The lights sign-off, which that ADR left open, went the same way on the same day**
> ([ADR 0063](../adrs/0063-the-machine-is-settled-from-the-asset-not-driven-by-the-button.md),
> [#263](https://github.com/dylanleatham/Marquee/issues/263)) — reported in almost the same words,
> for the same reason. Neither the tension nor the class survives: no control drives an edge of its
> own now, so there is no third instance to find.

**Every unwritten sticker carries its own `I'VE WRITTEN THIS ONE`** — the sleeve and the card as well
as the demo tag (ADR 0062). `TAGS VERIFIED` is the _check_, and the check happens hours or days after
the writing; a panel whose only control is the check has nothing to say the evening you burned the
stickers. The visible wording is identical on all three, because you are answering the same question
about the sticker beside it; the **accessible name** is where they differ (`I've written the sleeve`),
so a screen reader never reads three buttons that sound alike.

### 5.3 The demo-cut panel ([ADR 0058](../adrs/0058-a-demo-tag-plays-one-chosen-track.md))

Built 2026-08-08. Which one song a **demo tag** plays — the cut that makes someone want to hear the
rest of the record.

**The choice is stated in words before any list**, inside an ink border: the song's name, its track
number and length, and `PLAY THE WHOLE RECORD INSTEAD`. With nothing chosen the same box carries the
honest sentence — "No demo cut chosen — a demo tag plays the whole record, just like the shelf card
does" — because clearing is not a deletion and must not read like one.

Then the tracklist, one row each: `●`/`○`, number, name, length, and either `IN USE` or
`USE THIS ONE`. The chosen row is raised **and** filled-glyphed **and** labelled — never colour alone
(§3.4). `IN USE`, matching the card gallery, because the app has one word for "this is the one".

**Fetched live, stored never.** The songs come from `GET /api/albums/:curatorId/tracks` on mount; only
the _choice_ lands on the asset. A record with no tracklist — a manual pressing, no Spotify
credentials, Spotify unreachable — shows the server's own sentence in a dashed box, because that is an
ordinary state of this screen rather than a failure of it. A transport failure reads the same way:
one place says why there is no list.

**Which Spotify album this is, and how to change it** ([ADR 0059](../adrs/0059-a-matched-album-plays-only-on-an-exact-match.md) / [ADR 0060](../adrs/0060-the-year-is-a-tiebreak-not-a-gate.md)). A dashed block above the list says what the record is linked to — `matched automatically to <artist — album>` for a guess, `linked by hand` or `added from Spotify` for a fact, or `not linked` — with **USE A DIFFERENT ALBUM** and **UNLINK**. It takes the `open.spotify.com` share link as well as the `spotify:album:` URI, because the share button is where anyone gets this.

It is shown **whether or not a match exists**, and that is the point. The first version appeared only when there was no tracklist, so it could fix a _missing_ match and not a _wrong_ one — and once ADR 0060 loosened the rule, a wrong-edition match became the failure to expect. That one shows up as a tracklist full of the wrong songs, so the fix has to sit next to them. ADR 0060 leans on this: the looser rule is the right trade only because a mistake is visible here and correctable in one press. The library-wide sweep is a **link** to Settings, not a button — it is the answer for hundreds of records, and offering it beside one album invites running it to fix one.

**No preview button, deliberately.** You judge a demo cut by hearing it in the room, and the room
already plays audio. A second, quieter way to play a track here would make the honest answer ("go
listen to it properly") the harder one. `useTracks` is the panel's only fetch and it has no polling —
a tracklist does not change under you.

## 5.2 Album detail — the rail (superseded, and now deleted)

> **Deleted 2026-08-05.** `workflow.tsx` — the five workstations, the prompt blocks, the splice
> controls and the tag payload — is gone with the panels above. What survived it is the `Run` type,
> now `ui/src/run.ts`. The section below is kept only as the record of what the rail was.

The detail page is a **left rail of five workstations** beside a full-width canvas. The selected
workstation gets the whole canvas; the rail is always visible.

Eight scrolling sections were the wrong unit — with five video prompts and five card-art prompts each
rendered in full, the page became a document to scroll rather than a bench to work at. Five
workstations is the right unit because it matches how the work actually arrives: _I have the card
art, let me go do card things._

| #   | Rail item   | Contains                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| --- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Look**    | Palette (swatches, roles, reorder, reset-to-auto), the derived pattern **read-only**, artwork override _(built 2026-07-25, issue #100; streaming opt-in added 2026-07-27, [ADR 0035](../adrs/0035-streaming-effect-is-a-per-album-opt-in.md); widened to every pattern type 2026-07-29, [ADR 0039](../adrs/0039-one-motion-picker-clip-patterns-are-selectable.md); the Motion picker moved to the room's dock 2026-08-06, [ADR 0052](../adrs/0052-curator-is-three-places-not-a-nine-state-queue.md) — see §6)_ |
| 2   | **Video**   | Five video prompts · clip gallery · splice · attach / detach / replace                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 3   | **Card**    | Five card-art prompts · candidate set · attach / detach / replace · download print version                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 4   | **Preview** | Bench preview and room rehearsal (§6)                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 5   | **Ship**    | Tag payload + QR · `.nfc` download · mark written (sleeve / card) · verify physical                                                                                                                                                                                                                                                                                                                                                                                                                              |

Notes on the grouping:

- **Preview is its own workstation**, not a step inside Video. It composes the whole album — sleeve,
  lights, video, audio — so it belongs beside the sections that feed it, not inside one of them.
- **Ship holds only physical actions.** The old "Simulate scan" button moves into Preview's room
  mode, where it belongs (§6) — it was always a rehearsal, filed under verification.
- The **fixed left column** (cover, title, artist, state badge, Demo Room, Delete, curatorId) stays
  as built; the rail sits below it.

### 5.1 Behaviour

- **Routable.** Each workstation has its own path — `/albums/:curatorId/video` — so back/forward
  work, and a deep link opens where you meant.
- **Readiness, not permission.** Each rail item carries a state indicator: _empty · ready · attached ·
  blocked_. Per §3.4 it is a dot **plus** a word, never a dot alone. It reports what exists; it never
  prevents entry. Every workstation is always clickable.
- **Default selection** is the workstation matching the album's current state — the one place
  `roadie.state` legitimately influences the UI, because choosing a default is emphasis, not gating.
- **No section is ever hidden.** Including for albums still in a Roadie processing state: if you have
  the video in hand while metadata is still fetching, Video accepts it.

**Pattern is derived, and shown as such — but it can be overridden.** Motion comes from palette
energy ([ADR 0033](../adrs/0033-palette-derived-motion-energy.md)), and that stays the default for
every album: the first answer to "the motion doesn't suit this record" is still to change where the
colours come from ([ADR 0030](../adrs/0030-palette-from-album-feeling.md)). The derived pattern is
displayed read-only above the picker, because it is never written by a choice made here.

**The picker itself is not here — it moved to the room** (§6), because how the lights move is
something you judge by watching, not by reading a list. That is the whole reason colour editing stays
on the record and movement goes there. What the eight answers are, how Auto behaves, and which half
needs hardware are all specified in §6's "The dock's LIGHT PATTERN group is the Motion picker, in
full"; this panel shows the derived pattern read-only and nothing else about motion.

## 6. Preview — bench and room

> **Built 2026-08-06** ([ADR 0052](../adrs/0052-curator-is-three-places-not-a-nine-state-queue.md)).
> Bench and room are **one screen**, `/room/:curatorId`, with the arm toggle choosing between them.
> `PreviewWorkstation.tsx` and `DemoRoom.tsx` are deleted; `/demo/:curatorId` still resolves, because
> that address is in the old screen's own history. The safety reasoning below is unchanged and is
> exactly why the toggle exists.
>
> **The screen.** A flex _column_: the stage flexes and the dock is a real footer sibling, never
> absolutely positioned — the sleeve-on-the-stand has to sit in the space actually left over or it
> ends up behind the controls on a short window. The wash is the record's own palette, inset `-6%`
> so `ppDrift` never reveals an edge, and stilled by `prefers-reduced-motion`.
>
> **Bench plays everything except the hardware.** The clip loops and the wash drifts whether or not
> the room is armed; gating those on being armed would make the safe mode the useless one. `♪ PLAY
THE ALBUM` follows the switch — desk audio on the bench
> ([ADR 0037](../adrs/0037-bench-preview-audio-via-spotify-connect.md)), the room's own speakers when
> armed. Arming starts the room and un-arming stops it, as does leaving the screen: nothing should
> keep a room lit for a window nobody is looking at.
>
> **Conductor failing degrades the room to a window.** The wash, the clip and the sleeve do not
> depend on it, so an unreachable Conductor shows a line and leaves the screen working.
>
> **Sign-off lives here and nowhere else** — approving a record's lights means having just watched
> them, which is not a claim a form can make for you.
>
> **Rewritten 2026-08-08** ([ADR 0063](../adrs/0063-the-machine-is-settled-from-the-asset-not-driven-by-the-button.md)).
> It used to be gated by the state machine (`state === "awaiting_preview"`), and it disabled with its
> reason — but the only entrance to that state is attaching a visualizer, so on a record with no
> visualizer the control was permanently dead and the lights need could never be marked done. The
> gate now asks about the **record**: you have already signed it off, or Roadie has not pulled the
> lights yet. Both are temporary and both are true.
>
> **It confirms in place.** It used to return to the collection and fire the ready toast whatever was
> outstanding, so the only evidence you had signed anything off was a five-second toast on a different
> screen claiming all four needs were done. The control becomes a receipt — `● SIGNED OFF ✓`,
> disabled, with "Signed off <when>" beneath it. The glyph carries it, never colour alone. The toast
> and the return to the collection are kept for the case that earns them: the sign-off was the last
> outstanding need, so the record really is finished (§8.6).
>
> ### The control dock's sliders are the pattern's own knobs
>
> The design draws three fixed sliders — Transition, Hold, **Brightness** — and the walkthrough is
> explicit that all three are per record. Two of the three ship. **Brightness does not, and cannot
> yet**: `palette-payload.schema.json` admits no global brightness, and `static` is specified as
> `maxProperties: 0`, so a brightness slider on HOLD STILL would build a payload Conductor's own
> contract rejects. ADR 0036 already settled the principle — "a UI that offers a value the server
> refuses is worse than no slider".
>
> So the movement group renders **`PATTERN_PARAM_SPECS` for the chosen pattern**: Fade and Hold for
> crossfade, Breath / Dim to / Rise to for pulse, and a plain sentence for hold still, which has
> nothing to tune. Every slider shown does something. **Getting the design's brightness needs a
> contract change** across the payload schema, Conductor and Palette Press — recorded in ADR 0052,
> not silently dropped.
>
> ### The dock's LIGHT PATTERN group is the Motion picker, in full
>
> _Corrected 2026-08-09 ([#287](https://github.com/dylanleatham/Marquee/issues/287)). It shipped
> naming CROSSFADE · PULSE · HOLD STILL, with a streaming pattern appearing as a fourth chip only if
> the record already carried one. That is three of the eight answers
> [ADR 0039](../adrs/0039-one-motion-picker-clip-patterns-are-selectable.md) specifies: `rotate` and
> the streaming three could not be chosen at all, and an override could not be undone._
>
> The group offers **all eight**, in three columns, chips built from `PATTERN_TYPES` rather than a
> list of its own so contracts and this screen cannot drift again:
>
> | Column                      | Chips                                   |
> | --------------------------- | --------------------------------------- |
> | LEAVE IT TO ROADIE          | AUTO                                    |
> | PLAYS ON ANY BRIDGE         | HOLD STILL · ROTATE · PULSE · CROSSFADE |
> | NEEDS AN ENTERTAINMENT AREA | AURORA · SHIMMER · WAVE                 |
>
> **AUTO is a peer chip, not a clear button** — the record always has exactly one answer, and the
> default deserves to be visible as one. It is pressed whenever `patternOverride` is absent, which is
> the overwhelming majority of records. The group's own label names what Roadie derived
> (`LIGHT PATTERN · ROADIE CHOSE CROSSFADE`), read-only, because a choice made here never writes it.
>
> The streaming three are **named as gated, never disabled**: this screen cannot see whether the
> bridge has an entertainment area, and Conductor falls back to the derived pattern by itself where
> there isn't one — so the column's note says which pattern that would be. Per §10 the control states
> the condition rather than degrading silently.
>
> The chosen chip carries a **✓ glyph** as well as the paper fill (§3.4) — hidden from the accessible
> name, where `aria-pressed` already says it.
>
> **Under AUTO there are no sliders.** The knobs belong to an override, not to the derived pattern
> (ADR 0039, ADR 0030's surviving half) — the movement group instead reads "Roadie's own choice plays
> here. Pick a pattern below to tune it yourself." Until #287 a slider moved under AUTO silently
> converted the record to an override of the derived type, which is derivation edited in place under
> another name. Choosing a chip starts that pattern from its spec defaults, per ADR 0039 §5.

Preview has **two modes** ([ADR 0028](../adrs/0028-preview-bench-and-room-modes.md)). The split is
not stylistic; it exists because the listening room may contain other people, and taking over their
lights and audio is a side effect on humans, not a rendering choice.

### 6.1 Bench preview (default)

Everything in the window. **Touches no hardware, ever.** Always available, cannot surprise anyone.

- The **sleeve** — album art at size, as it sits on the stand
- The **video** loop, with Backdrop-accurate crossfade timing
- The **palette** animating as CSS, driven by the same pattern the runtime will use — paused
  whenever the tab is hidden or the stage is off screen (§3.3)
- **Audio** — a track from the album, played at the workstation by transferring Spotify Connect to
  the desktop Spotify client, proxied through Curator
  ([ADR 0037](../adrs/0037-bench-preview-audio-via-spotify-connect.md), built 2026-07-27, issue
  #93). Only a local device of type `Computer` is ever targeted: bench must not be able to take over
  a room speaker, so the device filter is part of "touches no hardware", not a convenience. The
  control **says it takes over Spotify** before it does — the transfer really does replace whatever
  the producer was listening to — and leaving the bench pauses what it started. Premium and a
  running desktop client are required; per §10 the control names whichever is missing instead of
  degrading silently, and the bench stays usable without audio

This is the early-preparation mode: judging composition for albums you're preparing now and will
play later, with the room untouched.

### 6.2 Room rehearsal (armed)

The real thing, minus the physical tag: lights → Conductor, video → Backdrop, audio → Amp. This is
what `POST /api/albums/:curatorId/simulate-scan` already does for the first two; adding Amp as a
third target makes that endpoint the complete rehearsal.

Because it drives the actual runtime path rather than approximating it, it is the honest last
checkpoint before you commit to writing stickers.

The existing **Demo Room** (`/demo/:curatorId`,
[ADR 0007](../adrs/0007-demo-room-drives-conductor-via-curator-proxy.md)) is the full-viewport
presentation of this mode — including its place/lift/swap controls and room picker — not a separate
feature.

> **This was aspirational until 2026-08-08** ([#277](https://github.com/dylanleatham/Marquee/issues/277)):
> every `/api/demo/*` route drove Conductor alone, so placing a record lit the room and left the
> screen black while this section claimed otherwise. `play` and `stop` now drive Backdrop too.
>
> The two legs deliberately carry **different payloads**. Conductor is handed the _live-edited_
> palette, which is what makes the pattern knobs re-apply as you turn them; Backdrop is sent a scan
> event, because it resolves the video by URI from its own library and has nothing live to edit.
> Pointing the screen at `simulate-scan` instead would have made Conductor resolve from its _synced_
> copy and silently broken that tuning. A pattern change therefore re-applies **lights only** — a
> video that restarted on every knob nudge would make tuning unusable.
>
> The screen leg is best-effort: an unreachable or unconfigured Backdrop leaves the lights running
> and reports why, because a black screen otherwise looks exactly like a record with no visualizer. Curator proxies each runtime service so the browser never holds the shared secret; audio
> follows the same pattern (`POST /api/demo/audio` → Amp's `POST /api/admin/play`), which is why this
> costs almost nothing to build.

### 6.3 Arming

A **room-arm switch lives in the persistent bottom status bar**, alongside the Roadie strip. Two
states, persisted across launches, defaulting to bench:

- **Bench only** (default) — every hardware-touching control in the app is disabled with the reason
  shown: room rehearsal, Demo Room, verify-physical.
- **Room live** — armed; the status bar says so continuously for as long as it is on.

It is a single deliberate act at the start of a working session rather than a decision re-made at
every button. Today `▶ Demo Room` sits one click from the album detail and will change the lights in
an occupied room with no warning — that is the behaviour this removes.

## 7. Generation is invoked, never pipelined

Gemini calls cost money, so **every call is the direct result of a click**
([ADR 0027](../adrs/0027-generation-is-invoked-not-pipelined.md)).

[ADR 0012](../adrs/0012-artifact-generation-is-opt-in.md) made _artifact_ generation opt-in, but
prompt _drafting_ was never covered: `drafting_prompts` is an unconditional pipeline step, so every
album spends two Gemini calls authoring ten prompts — including albums whose video and card art you
already have and will never draft prompts for.

Three rules:

1. **Drafting is lazy.** Prompts are drafted when you enter the Video or Card workstation and ask
   for them — not during Roadie's onboarding pipeline. An undrafted section shows a **Draft prompts**
   button where the prompts would be.
2. **Never draft for a section whose artifact is already attached.** If `visualizer` exists, Video
   leads with the attached video and drafting is a secondary "actually, regenerate" action. Same for
   `cardArt`.
3. **Spending is legible.** Any control that costs money is visually distinct from a free one and
   names what it will spend before you press it — "Generate all 5" is five image calls; a per-prompt
   button is one. Today they are styled identically to **Copy**, which is free.

The template fallback path costs nothing and is unaffected; it stays available on demand.

## 8. The collection

> **Rewritten 2026-08-04** ([ADR 0052](../adrs/0052-curator-is-three-places-not-a-nine-state-queue.md)).
> This section used to specify the **queue view**: albums grouped into nine machine-state buckets,
> in attention order, one row each with a next-action link, and a "needs you right now" count in the
> header. That screen only ever showed work-in-progress — there was no view that answered "what do I
> own?", which is the question you actually have when you sit down. The queue survives as one filter
> chip. `pages/QueueView.tsx` and `queueKeys.ts` are deleted.

Home. Every record you own, art-first, in a shuffled grid.

**A record shows its first outstanding need, and only that** — never a count, never "+1". The need is
derived from the assets, not read off `roadie.state`: lights until the preview is approved, a
visualizer until one is attached, a card until one is attached, tags until both are written _and_
checked. Precedence is lights → visualizer → card → tags, which is a reading order, not a dependency.
One pure module (`ui/src/needs.ts`) owns the derivation for both this screen and the record page, so
they cannot disagree about the same record.

The vocabulary is fixed and was settled over three rounds of review. Not cosmetic — the old words
were rejected:

| Say                                         | Never say                                          |
| ------------------------------------------- | -------------------------------------------------- |
| the collection                              | the wall, the queue                                |
| Not complete / Ready                        | wants you / fully lit, lit, verified               |
| Needs a look / Visualizer / Card / Sign-off | **Needs Lights**, needs colours, awaiting anything |
| Roadie is on it                             | processing, generating palette                     |
| Stuck                                       | errored                                            |

**A need label names the act you still have to perform, never the artifact**
([ADR 0056](../adrs/0056-need-labels-name-the-act-not-the-artifact.md)). `Visualizer` and `Card` are
allowed to read as their artifact only because there genuinely isn't one yet. `Lights` never is:
Roadie derives the palette seconds after a record lands, so `NEEDS LIGHTS` claimed something false
for the record's whole life — on a 499-record sync it read as "Roadie never looked at the covers"
while 458 of those records held a full palette. It is `NEEDS A LOOK`; the outstanding act is watching
it in the room. The stat band's sentence matches ("three still need a look").

**No machine state name and no album id appears anywhere on this screen.** Roadie's log says "Pulled
the lights from **Kind of Blue**". A failure reads as a sentence with a way out, not as
`spotify_lookup_failed`.

Four regions:

- **The stat band** — Not complete (accent) · Ready · Not started, each with a one-line detail; then
  a **rotating statistic** you advance by clicking. The pool is built from the statistics there is
  data for, so it is four today and becomes five when `label` is stored on an asset.
- **The filter bar** — Everything · Not complete · Ready, a search over title and artist, `SHUFFLED ↻`,
  and a density cycler (5 / 7 / 9 columns). Filter, query and density live in the URL so a session
  survives a reload.
- **The grid** — gutters are **borders, not gaps**. Selecting _Not complete_ regroups it under one
  heading per need; **empty groups are not rendered at all**. Stuck records get their own row on
  `--pp-accent-wash` below the groups, with the sentence and a `FIX IT` button.
- **Roadie's log** — a strip **docked to the bottom of the window** with the newest entry, expanding
  into a panel that opens _upward_ and is bounded at `45vh`
  ([ADR 0055](../adrs/0055-roadies-log-is-docked-to-the-window-not-to-the-page.md); it was a footer
  strip at the end of the page, which meant scrolling the whole collection to reach it).
  **Session-only and not persisted**; the panel says so. Failures live durably in the Stuck group
  instead.

  It also carries **where Roadie stands**, in words — `IDLE · NOTHING QUEUED`, `WORKING · n QUEUED`,
  `PAUSED`, or `CHECKING…` before the first poll answers
  ([ADR 0057](../adrs/0057-the-log-strip-says-where-roadie-stands-not-only-what-it-did.md)). The
  sentence beside it is **history**; this is **state**, and the two are only distinguishable when it
  matters. Roadie clears a record in ~130ms, so a whole sweep lands in one minute and the strip then
  stops changing — identically whether Roadie finished or died. The dot pulses only while busy, but
  nothing depends on noticing that: per §3.4 the word is the signal. `IDLE · NOTHING QUEUED` claims
  only that **Roadie's** queue is empty, never that the collection is finished.

**Order is shuffled on every visit**, seeded so it is stable across the poll's re-renders within a
visit and different next time. `SHUFFLED ↻` reseeds. A grid that reorders under the cursor every
three seconds would be unusable, so the seed is load-bearing, not decorative.

**Empty is a positive state.** "Your collection is empty" with a way to add the first record — never
an empty container, and never a blank wall when a search matches nothing.

The header's count is now **progress across the whole collection** ("18 of 40 ready"), not a
needs-you tally. It answers "how far am I?" rather than "how much is nagging me?", which is the
question a wall of records raises.

## 8.5 System — the page you open when something is wrong

Added 2026-08-01 at `/system`. Every runtime service already had a status endpoint; what was missing
is that **the failures worth catching are disagreements between hosts**, and answering one meant
curling four services and diffing the results by hand.

> **Rewritten 2026-08-06** ([ADR 0052](../adrs/0052-curator-is-three-places-not-a-nine-state-queue.md)).
> The **album matrix is deleted.** It answered "is everything fine?" by making you read every album
> against every host and compare ticks — work that grows with the collection to answer a question that
> is usually "yes". The page now shows **the exceptions**: it is as long as the number of things
> actually wrong, and says "Every record is everywhere it should be." when that number is zero. The
> four facts below are unchanged — they are now a predicate rather than four columns.

The four facts about each album, and what each one being false means:

| Fact                | Answers                                                                                                                     |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Video attached      | Curator has a visualizer — without one there is nothing downstream to hold                                                  |
| On Conductor        | The asset was pushed, so a scan can drive the lights ([ADR 0045](../adrs/0045-curator-pushes-album-assets-to-conductor.md)) |
| In Backdrop library | Backdrop can resolve the scan URI to a file path                                                                            |
| Video on Backdrop   | …and the bytes are actually there ([ADR 0038](../adrs/0038-curator-pushes-media-over-http.md))                              |

The last two stay separate. The entry and the bytes travel on different legs, so "listed but
unplayable" is a real state — and it is exactly how an album sat in the library with no mp4 for a day,
looking healthy from every angle.

**An album is an exception when it is missing from somewhere it belongs**, which depends on whether it
has a visualizer at all: no video means Conductor is the only host that should hold it, so the
Backdrop facts are not failures — a mid-workflow record must not read as broken. Each exception says
which host in words (`NOT ON CONDUCTOR`, `NOT IN BACKDROP'S LIBRARY`, `NO VISUALIZER ON BACKDROP`) and
links to the record.

Each service is named with **what it is for**, not just its port — Conductor is "the lights", Backdrop
"the screen", Stylus "the stand", Amp "the sound". Two failures are kept apart in words as well as
style: **not set up** (never configured — Amp normally) is not **not answering** (configured and
unreachable, which is a fault).

Also on the page: what is playing (screen / lights / sound / **the stand**), jobs in flight with a
count as well as a bar, and one **Sync everything** button.

**A job streaming a file says which file, and how far.** Under the job's own row, indented and
quieter, sits the visualizer currently uploading: the album's name, bytes sent of bytes total, an
estimate of the time left once there is enough history to make one honestly, and the same bar +
percentage columns as the row above it. It is absent whenever nothing is moving, which is most of a
sync — the Conductor leg and every album whose file is already up to date.

It exists because **the job row alone cannot distinguish slow from stuck.** A `runtimeSync` counts
album-legs, so it advances once per album; a single 66 MB visualizer crawling over a poor link leaves
that number motionless for minutes, which is exactly what a wedged process looks like. On 2026-08-08
a sync spent 47 minutes on one file with nothing on screen to say so. The bytes are the only honest
signal that something is still happening.

The two counters are **deliberately separate fields, not one**: `progress` counts album-legs and
`transfer` counts bytes. Merging them is not a hypothetical — it is
[#268](https://github.com/dylanleatham/Marquee/issues/268), where a running sync read `24248819/998`.

> **Amended 2026-08-08** ([ADR 0061](../adrs/0061-the-lights-are-stopped-from-the-system-page.md)).
> This said "Read-only apart from that button — this is the page you open when something is wrong, so
> it must never be the reason something is wrong." The reason stands; the rule was one notch too
> tight. **The page writes to the runtime, never to the collection.** A stray click here must never
> change a record, a palette, or a push — but a recovery action that takes the runtime back to
> neutral belongs on the page that reports the runtime.

**Stop the lights** sits in the LIGHTS row, the row that told you they were on. It calls
`POST /api/demo/stop` — Conductor stops playback and fades the room back to its pre-session snapshot.
Until this existed, the only reachable stop was inside the room and gated on the arm switch, so
turning the lights off meant opening some record's room and turning them **on** first; the documented
alternative was `curl` ([runbook.md](../runbook.md), "Force a service back to idle").

Two details it does not get to skip:

- **It is offered whenever Conductor answers, not only when a light is showing.** The caveat three
  lines below says Conductor's playback view covers CLIP playback only — a streaming pattern lights
  the room and reports nothing. Gating the button on the row would hide it in exactly the case the
  page admits it cannot see. Conductor unreachable is the one state that hides it: the stop could only
  502, and the service list above already says why.
- **Success gets a sentence too.** Pressed while the row already read "nothing", a correct stop
  changes nothing on screen and is indistinguishable from a broken button — so the result is stated
  either way ("The lights are off — the room is back to how it was." / "Couldn't stop the lights: …"),
  in wording before colour (§3.4).

The stop is **room-wide, not per-record**, because Conductor's is: it defaults to the configured
listening room. The room screen's **LIFT THE SLEEVE** is unchanged and remains the right control while
you are in there watching one record.

This is **the one place a raw error code belongs.** `connect ECONNREFUSED` is the actionable text for
a service that won't answer; paraphrasing it takes away the string you paste into a search. It comes
with **Retry** and **Copy error**. Everywhere else in the app, an error is a sentence.

**The stand** is the section that pays for itself during bring-up. It reports Stylus's _reader_ view,
not its state machine (stylus-spec §8), which distinguishes three things that used to be one blank:
nothing on the stand, a tag present whose NDEF won't decode, and a tag that decoded but carries
something unactionable. The last refusal is kept after the sleeve is lifted.

Two rules this page must not break:

- **Never colour alone (§3.4).** A service's dot is the glance; the line under its name is what says
  which state it is in. An exception names the missing host in words. A job's bar is always paired
  with its count. (Under the matrix this rule was carried by a glyph plus screen-reader text in every
  cell, for the same reason: "no" is not equally bad everywhere.)
- **State the limits rather than implying completeness.** Conductor's playback view covers only CLIP
  playback and carries no `curatorId`, so an album on a streaming pattern reports nothing. The page
  says so in place instead of showing a confident blank.

## 8.6 The ready toast

Built 2026-08-06. What the "record finished" screen became.

A screen is a stop: you have just signed a record off and the next one is what you want, so being
made to acknowledge the last one is friction dressed as celebration. This is a corner of the
collection — `#F7F4EE`, ink border, **the one shadow in the design**, because it is the only element
that floats above the paper rather than being printed on it.

"<Title> is ready", then "Lights, visualizer, card and tags — all done. Tap to watch it." **The whole
toast is one button**, and tapping it opens the room for that record — the only reason to look back
at a record you have just finished is to watch it. That also cancels its timer, so it cannot fade out
from under the screen it just opened. Otherwise it goes after ~5s on its own and **never blocks
moving to the next record**.

> **It fires only when it is true (2026-08-08,
> [ADR 0063](../adrs/0063-the-machine-is-settled-from-the-asset-not-driven-by-the-button.md)).** The
> room used to fire it on every sign-off, so a record that still needed a card and tags was announced
> as "all done" — the toast's own sentence naming three things that had not happened. It now fires
> only when the sign-off was the **last** outstanding need, which is also when returning to the
> collection is what you want. A sign-off with needs remaining confirms in the room instead (§7).

It is fired by the room and outlives the navigation back, so it lives in a module store rather than a
component, and it is **mounted in the shell** rather than on the collection — which means it floats
over whatever screen you are on when its five seconds run out. That is the point: signing off and
immediately opening the next record must not cut it short, and it must not be something you have to
come back to the collection to see. A record it cannot name is not shown at all — "Untitled is ready"
is worse than the quiet it replaced.

## 8.7 Add a record

Built 2026-08-06 at `/add`, replacing the old add-album screen.

The behaviour that changed: **adding does not take you anywhere.** The old screen navigated to the
record you had just added, which is exactly wrong for the actual task — you came here because you have
a stack of sleeves, not one. The search box keeps its query, added results are marked `ADDED` and
cannot be added twice, and a running "added just now:" line accumulates what has landed with a link to
each. Leaving is a deliberate act.

Three ways in, as tabs: **SEARCH** (Spotify, debounced as you type, results four up with artist and
year), **TYPE IT IN** (title, artist, and a sleeve — the sleeve is required, and the screen says why:
it is where the lights come from), and **SYNC DISCOGS ›**, which is a link out, not a tab. Discogs is
a standing collection with its own screen ([ADR 0051](../adrs/0051-the-discogs-collection-is-swept-not-clicked.md)),
not a way to pick one record.

Pasting a Spotify link is **removed**. It existed because search was unreliable before the client was
fixed; it asked the user to know what a URI is, and every link it accepted, search also finds.

## 8.8 Discogs

Built 2026-08-06 at `/discogs`. The sweep ([ADR 0051](../adrs/0051-the-discogs-collection-is-swept-not-clicked.md))
already writes every release into the library on a timer, so this screen is **not a picker** — there is
no browse-and-approve list, because nothing is waiting for approval.

It answers three questions instead:

1. **Are the two collections the same size?** A stat band: in Discogs, in Curator, came in today, and
   last synced. Only the first needs an upstream call — one row is enough, since the response carries
   the total. Discogs refusing to answer shows an em dash and says so; `0` would read as an empty
   collection, which is a different and much more alarming fact. The unmatched count is **not** in the
   band: it is the only number here you are meant to act on, and it lives on the section that lets you
   act, rather than being read twice.
2. **What arrived today?** The records added on the local calendar day, newest first, labelled with the
   same words the collection uses (§8) — not a second vocabulary for the same states.
3. **What did Roadie fail to finish?** The only real to-do here, and the reason the screen exists.
   They **never leave this list on their own**, so each offers `SEARCH BY HAND` (which opens §8.7 with
   the title already in the box) and `SKIP`, which hides the row for this session without pretending
   it is resolved.

   The design labels this **"couldn't match to Spotify"**, and it is not built that way, because that
   is not a state a Discogs record can reach: its metadata comes from Discogs, and the Spotify step is
   a best-effort _cover art_ lookup that never fails the add (roadie-spec §5.2). Keying the section
   off `album_not_on_spotify` would have made it empty forever. What actually strands one of these is
   the release fetch — `release_not_on_discogs`, `invalid_discogs_release` — or an ordinary pipeline
   failure, so the section reads **ROADIE COULDN'T FINISH THESE** and each row carries its own reason
   in words.

The page also says when the sync last ran and whether it runs itself, offers `SYNC NOW`, and names the
two behaviours that would otherwise surprise you: multiple pressings of one record collapse to one
entry, and removing something from Discogs does not remove it from Curator.

## 8.9 Settings

Built 2026-08-06 at `/settings`. Two columns: **the room and the services** and then **accounts** on
the left, **what Roadie may do on its own** on the right — what the room is and what it is plugged
into reads as one thing, and the permissions are the only part of the screen that is a decision.

Three things this screen is deliberate about:

- **Service addresses are shown, not edited.** They are resolved once at startup from `config.toml` or
  the environment, and `settings.json` sits _below_ `config.toml` in that chain — so a text field here
  could be silently overridden by a file the user can't see from this screen. Showing the value and
  saying where it comes from beats a box that appears to work.
- **Credentials live behind `CHANGE`.** The steady state of this screen is "everything is connected",
  and a wall of half-filled secret fields makes a working system look broken. A secret is never sent
  back to the client, so the field says it has to be typed again rather than showing a masked
  placeholder that implies it could be left alone. Spotify and Discogs each keep **both** ways in —
  the credentials form, and the OAuth login beneath it when consumer creds are configured
  ([ADR 0014](../adrs/0014-spotify-user-oauth-pkce.md),
  [ADR 0017](../adrs/0017-discogs-personal-token-and-direct-images.md)). An account is **connected
  when either** is good: app-level credentials work with no user session, so a signed-out session must
  not report a working account as broken.
- **Permissions, not feature flags.** The three checkboxes are things Roadie may do on its own —
  draw card art, make the visualizers, follow the Discogs collection — and each names its cost, since
  that is the actual decision. The Discogs sweep's **interval is not editable here**: "how many
  minutes" is a worse question to put in this column than "may it at all", and the answer is nearly
  always the default. It remains a real setting on `PUT /api/settings/discogs`, and the permission's
  note is generated from the configured value rather than asserting "once a day".

  Two of the three take effect **on restart** — the Gemini flags are read once at boot — so the box
  shows what you have _asked for_ (the stored setting, not the running value) and a line under the
  column says when it becomes true. The Discogs poller applies immediately, so it shows no such line.
  A flag pinned above `settings.json` in `config.toml` or the environment is rendered as a
  **statement, not a checkbox**, naming where it is set — the same call as the service URLs above.
  Binding the box to the _running_ value instead is what made these look unclickable: the click
  saved, the next poll answered with the boot value, and the tick sprang back
  ([#240](https://github.com/dylanleatham/Marquee/issues/240)). "Suggest a second palette" is **not** among them: the palette is
  extracted locally and free, and a flag putting a paid call in Roadie's pipeline is what
  [ADR 0027](../adrs/0027-generation-is-invoked-not-pipelined.md) rules out and what lets a
  whole-collection sync stay free ([ADR 0051](../adrs/0051-the-discogs-collection-is-swept-not-clicked.md)). The
  screen says so in a note rather than offering a checkbox that would have to lie.

The room picker lists Conductor's rooms; when Conductor isn't answering it says that, rather than
rendering an empty picker that reads as "you have no rooms".

## 9. Desktop affordances

### 9.1 Keyboard — withdrawn

> **Withdrawn 2026-08-04** ([ADR 0052](../adrs/0052-curator-is-three-places-not-a-nine-state-queue.md)).
> **Every binding in the table below is removed**, along with the command palette
> ([ADR 0043](../adrs/0043-command-palette-carries-commands.md)) and the declared per-workstation
> primary action ([ADR 0044](../adrs/0044-workstations-declare-their-primary-action.md)). `⌘K`,
> `j`/`k`, `1`–`5`, `⌘⏎`, `n`, `⌘,` and `/` do nothing.
>
> The premise below — "the success criterion is working through ten albums in one session" — is what
> changed. The user asked to optimise for **clarity** instead: an accelerator layer earns its cost
> when the screen underneath is dense and ordered, and the collection is neither. `[`/`]` become the
> record sidebar's `↑ PREV` / `NEXT ↓` buttons, which are the same affordance without a hidden key.
>
> **Keyboard _reachability_ is not withdrawn** — every control remains focusable and operable, with a
> visible ring (§3.5). That is an accessibility floor, not an accelerator. Do not reinstate any of
> these bindings without asking; they were removed deliberately, not lost.
>
> The rest of this section is kept for the two bugs it records (#119 and #225), which are about React
> painting before it flushes effects and will bite again in a different shape.

The success criterion is working through ten albums in one session. Ten albums × mousing to every
control is what turns a session into a chore.

| Context | Key                      | Action                                    | Status |
| ------- | ------------------------ | ----------------------------------------- | ------ |
| Global  | `Ctrl/⌘ ,`               | Settings                                  | built  |
| Global  | `n`                      | Add album                                 | built  |
| Queue   | `j` / `k` (or `↓` / `↑`) | Move selection                            | built  |
| Queue   | `Enter`                  | Open selected album                       | built  |
| Queue   | `/`                      | Focus search                              | built  |
| Queue   | `Esc` (in search)        | Leave the search field                    | built  |
| Detail  | `1`–`5`                  | Jump to rail workstation                  | built  |
| Detail  | `Esc`                    | Back to queue                             | built  |
| Global  | `Ctrl/⌘ K`               | Jump to album, or run a command           | built  |
| Detail  | `[` / `]`                | Previous / next album at the same state   | built  |
| Detail  | `Ctrl/⌘ Enter`           | Primary action of the current workstation | built  |

> **Status added 2026-07-25** when the keyboard path was implemented; `[`/`]` built 2026-07-26
> ([issue #94](https://github.com/dylanleatham/Marquee/issues/94)); `Ctrl/⌘ K` and `Ctrl/⌘ Enter`
> built 2026-07-31 ([issue #95](https://github.com/dylanleatham/Marquee/issues/95)), each of which
> needed a surface rather than a handler — see below. **The table is now complete: every binding
> specified here is implemented.**
>
> **Superseded 2026-08-04:** every row above now reads `removed`. See the withdrawal note at the top
> of §9.1.

`[` / `]` implement the onboarding workflow's "next album at this state is a first-class affordance"
(§12 there). The neighbours come from the **server**, sharing the queue's own bucketing
(`GET /api/albums/:curatorId/peers`) — re-deriving the ordering on the detail page would be a second
implementation of it, free to drift from the list you were just looking at.

Two behaviours are deliberate. Navigating **keeps the workstation you are on**, so finishing five tag
writes in a row doesn't bounce you back to Look each time. And the run **does not wrap**: at the end,
the honest answer is "that was the last one", where looping silently back to the first would have you
re-verify an album you already finished. Both ends stay visible and disabled with the reason (§10),
as does an album that is the only one at its state.

Every shortcut must also be reachable by mouse. The keyboard is an accelerator, never the only path.
No shortcut fires while focus is in a text field, so a search query never triggers navigation.

**A shortcut acts on what is on screen now, and never silently does nothing.** A key handler must
read the current list and selection at the moment the key arrives, not a copy captured when it was
registered — React paints rows before it flushes effects, so a handler that closed over the list was
stale in precisely the moment the queue first appeared, and `j`/`Enter` were discarded with no
feedback ([issue #119](https://github.com/dylanleatham/Marquee/issues/119)). A shortcut that
intermittently does nothing is worse than one that doesn't exist, because the user can't tell which
they have. The decision itself lives in `ui/src/queueKeys.ts` as a pure function of the live rows, so
the clamping rules are checkable without racing a render.

#### The command palette (`Ctrl/⌘ K`) — removed

> **Removed 2026-08-04** ([ADR 0052](../adrs/0052-curator-is-three-places-not-a-nine-state-queue.md)).
> `CommandPalette.tsx`, `commandPalette.ts` and the header's **Jump…** button are deleted. Nothing
> below is live. Kept because the one durable finding is worth keeping: a shortcut needs a _surface_,
> not just a handler.

Ranks **albums and commands in one list, albums first**
([ADR 0043](../adrs/0043-command-palette-carries-commands.md)). An empty input lists the commands
only — fuzzy matching needs letters, and a whole library dumped into an empty overlay buries the
short list worth showing before you have typed. The commands are navigational (Queue, Add album,
Settings, the NFC how-to): **the palette takes you places, it does not do things.** Arming the room
is deliberately absent — its switch stays in the status bar where its state is continuously visible
([ADR 0028](../adrs/0028-preview-bench-and-room-modes.md)) — as is anything that spends a Gemini
call. Ranking is a pure function in `ui/src/commandPalette.ts`, for the reason `queueKeys.ts` is.
`GET /api/albums` already carries what it needs, fetched when the palette opens rather than polled;
a failed fetch still leaves the commands working and says why the albums are missing.

The palette has a mouse path — the header's **Jump…** button — but no app-menu item (§9.2).

#### The primary action (`Ctrl/⌘ Enter`) — removed

> **Removed 2026-08-04** ([ADR 0052](../adrs/0052-curator-is-three-places-not-a-nine-state-queue.md)).
> The binding is gone. `primaryAction.tsx` and the bench header's label go with the rail when the
> record page lands; until then they are still running and still correct about what they say.

Each workstation **declares its own** primary action into a slot the detail page owns
([ADR 0044](../adrs/0044-workstations-declare-their-primary-action.md)); the answer depends on state
the workstation holds — Look's is "save the palette", and only the palette editor knows whether the
draft differs from what is stored — so it cannot live in the rail's own table.

| Workstation | `Ctrl/⌘ Enter`                                           |
| ----------- | -------------------------------------------------------- |
| Look        | Save palette — disabled, with the reason, when not dirty |
| Video       | _none_                                                   |
| Card        | _none_                                                   |
| Preview     | Looks good (approve). The rejections stay mouse-only     |
| Ship        | Mark sleeve tag written, then Mark physically verified   |

Video and Card have no single primary control — draft, generate, attach and select are alternative
routes to the same artifact, chosen by what you happen to be holding (ADR 0026). **The bench header
always names what `Ctrl/⌘ Enter` will do**, including "No primary action on this workstation", which
is what keeps an inert key honest: a state you can read before you press it is not a silent one.

> **"Always" includes the first frame (2026-08-02, [issue #225](https://github.com/dylanleatham/Marquee/issues/225)).**
> A workstation registers from a **layout** effect, so the label is right in the same frame the bench
> appears. Registering after the paint — the obvious `useEffect` — meant opening Look painted one
> frame reading "No primary action on this workstation" on a bench that has one, and `Ctrl/⌘ Enter`
> pressed in that window really was a dud. This is the same class as #119 above: React paints before
> it flushes effects, so anything a shortcut depends on must be in place by the commit that shows it.

### 9.2 App menu

`autoHideMenuBar: true` with no menu defined means the app has no discoverable command surface and no
standard accelerators. A real menu — File (Add album, Quit), View (Queue, Settings, reload, zoom,
fullscreen), Help (docs) — makes the shortcuts discoverable and the OS integration honest.

> **Built 2026-07-25.** Menu navigation loads the route rather than messaging the renderer: the
> window runs with `contextIsolation` and no preload, and Curator already serves an SPA fallback for
> any non-`/api` GET, so a menu item costs no new IPC surface. The **room-arm switch deliberately
> stayed out of the menu** — it belongs in the status bar where its state is continuously visible
> (§6.3); a menu item would hide the one thing that must never be forgotten.
>
> **The command palette is not in the menu either (2026-07-31).** Loading a route is exactly what it
> must not do: the palette is an overlay over wherever you already are, and a menu item would have to
> reload the window to open it. Its discoverable half is the header's **Jump…** button instead.
>
> **Amended 2026-08-04** ([ADR 0052](../adrs/0052-curator-is-three-places-not-a-nine-state-queue.md)):
> the palette is gone, so that last paragraph is moot. Three live corrections to the menu itself —
> **View › Queue is now View › Collection**, **File › Add album is now File › Add a record…** (§8.7),
> and the **room-arm switch moved from the status bar to the room's own top bar** (the status bar was
> removed with the queue), so the reason it stays out of the menu is unchanged but the place it lives
> is not.

### 9.3 Window

`.page` capped at `920px` inside a `1360px` window, leaving roughly a third of the default window
unused. The rail layout (§5) is what spends it — the detail page now uses a `1320px` measure while
every other screen keeps the narrower reading width. Long-form text inside a workstation — a prompt
body — may still constrain its own measure; that is a text-column decision, not a page-width one.

### 9.4 Background work outlives the screen that started it

Long work — a batch palette sweep today (curator-spec §10, issue #104), any future library operation —
reports through a **fixed panel mounted at app level**, not inside the page that launched it. Two rules
follow, and they are the same rule seen from either end:

- **Starting it is a page's job; watching it is not.** Settings has the button; the panel is
  app-wide, so walking off to look at an album while the sweep runs neither hides it nor stops it.
- **The stop control and the progress live together, and neither can be dismissed while work is in
  flight.** A panel you can close mid-run is a run you can no longer cancel.

This is the visual half of [ADR 0029](../adrs/0029-batch-work-runs-as-a-library-job.md): one job
mechanism on the server, one place it surfaces in the window.

## 10. States every screen owes

Specified once here rather than improvised per component:

- **Loading** — spinner plus what is loading. Never a bare spinner.
- **Pending vs absent** — a thing that hasn't arrived yet must not look like a thing that isn't
  coming. Album art is the worked example ([#134](https://github.com/dylanleatham/Marquee/issues/134)):
  while Roadie is still fetching the cover, `AlbumThumb`/`Cover` request nothing and show a pulsing
  skeleton; the initials monogram is reserved for art that genuinely isn't there; the browser's
  broken-image glyph is never painted, so the `<img>` stays hidden until it loads. Per §3.4 the two
  cases differ by channel — pending is motion, absent is text — not by colour.
- **Empty** — what this is for and the action that fills it.
- **Error** — what failed, in plain language, and what to do. Errors are shown in place, next to the
  control that failed; a failed action never silently reverts.
- **Disabled** — always accompanied by the reason (§4). A disabled control with no explanation is a
  bug.
- **Busy** — per-action, not per-page. Already implemented (PR #72); keep it.
- **Degraded** — an unreachable service is reported, never fatal. Conductor down means the lights
  badge says so and local playback continues.

## 11. Open questions

**None open.**

**Resolved 2026-07-27 — desk audio for bench preview.** Bench preview needs a track playing at the
workstation (§6.1), and the route sat undecided between three candidates, none free. The spike under
[`spikes/desk-audio`](../../spikes/desk-audio) measured all three against real credentials on the
target platform, as [ADR 0034](../adrs/0034-amp-sonos-playback-and-card-uri.md) did for Amp's
transport:

- **30-second `preview_url` clips** — **dead on availability.** The field is not issued to this app's
  client id: 0/14 album tracks, `null` on the full track object, 0/5 search hits.
- **Spotify Web Playback SDK** — **dead as packaged.** Stock Electron 33.4.11 has no Widevine
  (`NotSupportedError`; ClearKey succeeds in the same run, so the probe is sound). Viable only behind
  a castlabs Electron build — kept as the named fallback, not the route.
- **Connect transfer** to the desktop Spotify client — **works**, on the scopes
  [ADR 0014](../adrs/0014-spotify-user-oauth-pkce.md) already grants. Adopted.

The choice, the constraint that stops bench from reaching a room speaker, and what killed the
alternatives are recorded in
[ADR 0037](../adrs/0037-bench-preview-audio-via-spotify-connect.md).

**This never blocked bench preview.** Sleeve + video + palette animation carried most of the
judgment while the route was open; the Connect leg was built the same day the spike settled it
([#93](https://github.com/dylanleatham/Marquee/issues/93)), and bench preview still works — silent
— for anyone without Premium or a running desktop client.
