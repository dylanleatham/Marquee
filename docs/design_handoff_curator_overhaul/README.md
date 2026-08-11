# Handoff: Curator UX overhaul + Pressing Plant theme

## Overview

A ground-up rework of **Curator**, the standalone admin app in the Marquee project
(`packages/curator`). Curator is the tool that prepares each album's presentation
assets so that placing a tagged sleeve on the stand turns the room into that record.

The current app is organised as an end-to-end workflow: a **Queue** of albums in one
of nine machine states, and an **album detail** page with a five-station rail
(Look → Video → Card → Preview → Ship) that walks you through them in order.

The overhaul replaces that with **three places**:

1. **The collection** — every record you own, art-first, in a shuffled grid. The old
   queue survives only as a filter chip. _(Since 2026-08-10 the bar carries one chip
   per state and one per need; the queue is the NOT STARTED chip —
   [ADR 0070](../adrs/0070-the-collection-filters-by-what-a-record-owes.md). Since
   2026-08-11 that chip is **hidden while the queue is empty**, which is most of the
   time, and returns when Roadie is holding something —
   [ADR 0071](../adrs/0071-a-chip-for-the-records-one-need-is-all-that-is-left-of.md).)_
2. **The record** — one page listing the four things a record still needs (lights,
   a visualizer, a card, tags), done in any order. No stepper, no rail, no
   machine-state names in the UI. _(Three since 2026-08-10: lights became an optional
   tab like the demo cut — [ADR 0069](../adrs/0069-the-lights-are-not-a-need.md).)_
3. **The room** — a full-bleed simulation of the actual listening room, washed in the
   record's own palette. This is also where a record gets signed off, so approving
   always means having just watched it.

Plus supporting screens: add a record, a dedicated Discogs collection sync, system
status, and settings.

Visual direction is **"Pressing Plant"**: light, printed, editorial. Warm paper
stock, ink black, one brick-red accent, hairline rules instead of cards, Archivo
Black for display, Helvetica for body, IBM Plex Mono for anything counted.

---

## About the design files

The files in this bundle are **design references created in HTML** — prototypes that
show intended look and behaviour. **They are not production code to copy.**

They are authored in a bespoke streaming-HTML component format (`.dc.html`, with an
inline template and a logic class). That format exists only in the design tool. Do
not try to port it, and do not import it.

The task is to **recreate these designs inside the existing Curator UI codebase** —
`packages/curator/ui`, which is React 18 + TypeScript + Vite + React Router, styled
with a single hand-written `src/styles.css`. Use that project's existing patterns:
the `api` client in `src/api.ts`, the `usePoll` hook in `src/hooks.ts`, the pure
helper modules (`src/format.ts`, `src/rail.ts`), and the component conventions in
`src/components/`.

The existing `styles.css` implements the **old** theme ("backstage marquee": warm
near-black `#14110f`, theater amber `#f5a623`). Pressing Plant **replaces** it. Expect
to rewrite that stylesheet rather than extend it.

Everything in the prototypes uses inline styles because of how the design tool
streams. **Do not reproduce that.** Lift the values into whatever CSS approach the
codebase already uses — in Curator's case, classes in `styles.css`.

---

## Fidelity

**Two levels, both included.**

- `Curator - Pressing Plant.dc.html` is **high fidelity**. Final colours,
  typography, spacing, copy and interaction. Recreate this precisely. All the
  design-token values in this README are taken from it.
- `Curator - Screen walkthrough.dc.html` is **low fidelity** — sixteen annotated
  wireframe plates covering every screen including ones the hi-fi file doesn't
  render (first run, the toast in context, the Discogs triage list). Use it as the
  **specification of intent**: each plate carries notes explaining what changed from
  today's app and why. Where the two disagree, the walkthrough's *annotations* are
  the source of truth on behaviour and wording; the Pressing Plant file is the source
  of truth on pixels.

Two further files are context, not targets:

- `Curator - Current UI.dc.html` — a faithful recreation of the app as it stands
  today, rebuilt from `packages/curator/ui/src`. Useful for diffing old against new.
- `Curator UX - Wireframes.dc.html` — the four original direction explorations. The
  chosen direction is `2a`, the hybrid. Historical only.

---

## Vocabulary — apply this everywhere

This was settled explicitly with the user over three rounds of review. It is not
cosmetic; the old words were rejected. Nothing in the UI should say otherwise.

| Say | Never say |
|---|---|
| the collection | the wall, the queue |
| **Not complete** | wants you, needs you |
| **Ready** | fully lit, lit, verified |
| ~~**Needs a look**~~ retired 2026-08-10 ([ADR 0069](../adrs/0069-the-lights-are-not-a-need.md)) | **Needs Lights**, **Needs a look**, needs colours, awaiting review |
| **Not started** | queued, pending, fresh |
| **Needs Visualizer** | needs video, needs a moving picture, awaiting video |
| **Needs Card** | awaiting card |
| **Needs Sign-off** | awaiting verification |
| **Roadie is on it** | processing, generating palette |
| **Stuck** | errored |
| Lights | colours, palette (in user-facing copy) |
| A visualizer | video, a moving picture |
| Tags | tag write, ship |
| "What this record still **needs**" | "...still wants" (no personification) |
| Tags verified | mark physically verified, I've put it on the shelf |
| Bench only / In the room | bench, room rehearsal, demo room |

Additional copy rules:

- **Never show a machine state name or an album id in the UI.** Roadie's log says
  "Roadie is working on **Kind of Blue** — finding the sleeve", not
  `working on 2k7bxq9m (Generating palette)`. The id may appear once, small and
  muted, at the bottom of the record sidebar.
- **Never show a raw error code to describe a failure.** `spotify_lookup_failed`
  becomes "Roadie couldn't find this anywhere — try a different name, or type the
  details in yourself." Raw codes are allowed in exactly one place: per-service
  errors on the System screen, where `connect ECONNREFUSED` is shown alongside a
  RETRY and a COPY ERROR button.
- Nine explanatory sentences were cut as redundant. Do not reintroduce them. Removed:
  "Find it and hand it to Roadie", "The page you open when something's wrong",
  "Set once, then forget it", "Curator follows it", the card explanation, the tag
  explanation, and "the room becomes the record".

---

## Design tokens

### Colour

| Token | Hex | Use |
|---|---|---|
| Paper | `#F2EFE8` | app background, reversed text on ink |
| Paper, sunk | `#EFEBE2` | stat bands, sidebars, secondary panels |
| Paper, raised | `#F7F4EE` | the in-use palette card, tag panels, the toast |
| Paper, log | `#EAE5DA` | the expanded Roadie log |
| Rule | `#D8D2C4` | every hairline divider |
| Rule, soft | `#C9C2B1` | input underlines, unselected card outlines |
| Dashed | `#B3AB99` | empty-state dashed borders |
| Ink | `#17150F` | all primary text, bars, filled buttons |
| Ink, muted | `#6F6A5C` | secondary text, mono labels |
| Ink, faint | `#8D8778` | tertiary text, captions |
| Ink, ghost | `#A49D8C` | ids, prompt numbers |
| Accent | `#B4402C` | anything not complete, Roadie's presence, the current stat |
| Accent, text | `#8E3122` | accent-coloured body text (contrast) |
| Accent, wash | `#F7ECE9` | the Stuck row, the failing service cell, unmatched Discogs rows |
| Positive | `#3F7D4E` | reachable services, "written", "saved a moment ago" |
| Amber | `#E0A24A` | fader/slider accent inside the dark room only |
| Room floor | `#0D0A10` | the room's base before the palette wash |

Rules:

- Ink borders are `1px solid #17150F`. Hairlines are `1px solid #D8D2C4`. The
  masthead's bottom border is the one exception at `3px solid #17150F`.
- Nothing has a border radius. Zero. Everything is square, including buttons,
  inputs and the toast. The one radius in the file is `border-radius:50%` on status
  dots.
- No shadows anywhere except the toast (`0 10px 30px rgba(23,21,15,.24)`).
- Album artwork uses `outline`, not `border`, so it doesn't affect layout: ink for
  ready, `#C9C2B1` for not complete, `2px solid #B4402C` for Roadie-is-on-it.
- ~~Not-complete artwork is additionally set to `opacity:.62`.~~ **Superseded 2026-08-07** by
  [ADR 0054](../adrs/0054-not-complete-is-a-folded-corner-not-a-dimmed-sleeve.md): the wash is a
  folded corner on the sleeve instead, and the artwork is never dimmed. Dimming degraded the one
  thing an art-first grid exists to show, for most of the wall.

### Typography

Three families, each with one job.

```
Display   Archivo Black, 400 only          — numbers, screen titles, record titles
Body      Helvetica Neue / Helvetica / Arial — everything readable
Mono      IBM Plex Mono, 500/600           — labels, counts, times, hex, ids, buttons
```

Load Archivo Black (400) and IBM Plex Mono (400, 500, 600) from Google Fonts.
Helvetica is a system stack — do not load a webfont for it.

| Role | Spec |
|---|---|
| Screen title | Archivo Black 30px / 1, `letter-spacing:-.02em` |
| Masthead wordmark | Archivo Black 21px / 0.9, `-.02em`, uppercase |
| Stat number | Archivo Black 36px / 1 |
| Header stat number | Archivo Black 20px / 1 |
| Record title (sidebar) | Archivo Black 25px / 1.05, `-.02em` |
| Record title (room) | Archivo Black 17px / 1, `-.01em` |
| Toast title | Archivo Black 16px / 1.15, `-.01em` |
| Sign-off button | Archivo Black 15px / 1, `-.01em` |
| Section label | Plex Mono 500 9.5px / 1, `letter-spacing:.18em`, uppercase |
| Nav / filter / button | Plex Mono 500 10.5px / 1, `letter-spacing:.14em`, uppercase |
| Small action | Plex Mono 500 9.5–10px, `letter-spacing:.14–.16em`, uppercase |
| Masthead sub-label | Plex Mono 500 9px / 1.4, `letter-spacing:.2em` |
| Hex / id / time | Plex Mono 500 10–13px |
| Body | Helvetica 400 13px / 1.4–1.55 |
| Body, prose | Helvetica 400 15px / 1.65, `max-width:62ch`, `text-wrap:pretty` |
| Record name in grid | Helvetica 600 12.5px / 1.25 |
| Byline | Helvetica 400 11px / 1.35 |
| Caption | Helvetica 400 11.5–12px / 1.4–1.55 |

Every uppercase label is genuinely uppercase in the markup, not
`text-transform`-ed — except the masthead wordmark, which uses the property.

### Spacing

Not a strict scale. The values actually used:

- Screen padding `24px`; stat cells and sidebar `15–20px`; grid cells `16px`.
- Masthead: `13px 20px`; nav items `0 18px`.
- Vertical rhythm inside panels: `gap:13px` (controls), `18–22px` (sections).
- Table-ish rows: `padding:9–11px 0` with a `1px` bottom rule.
- Grid gutters are **borders, not gaps** — collection tiles sit in a
  `display:grid` with each cell carrying `border-right` and `border-bottom`, so
  the grid reads as ruled paper. Only the Discogs grid and the card chooser use
  real `gap` (`14px` / `16px`).

### Motion

```css
@keyframes ppPulse { 0%,100%{opacity:.35} 50%{opacity:1} }         /* 2.4s ease-in-out infinite — Roadie dots */
@keyframes ppDrift { 0%{translate3d(0,0,0) scale(1.04)}
                     50%{translate3d(-1.5%,1%,0) scale(1.09)}
                     100%{translate3d(0,0,0) scale(1.04)} }          /* 26s ease-in-out infinite — the room wash */
@keyframes ppToast { 0%{opacity:0;translateY(10px)} 12%{opacity:1;translateY(0)}
                     88%{opacity:1;translateY(0)} 100%{opacity:0;translateY(4px)} }  /* 5s ease forwards */
```

The room's wash element is inset `-6%` on all sides so the drift never reveals an
edge. `ppDrift` should respect `prefers-reduced-motion` — the prototype does not,
and should have.

---

## Screens

### 1. Masthead — persistent

`position:sticky; top:0; z-index:20`, `border-bottom:3px solid #17150F`.
A single flex row of four regions, each separated by `1px solid #D8D2C4`:

1. **Brand block** (`flex:none`, `padding:13px 20px`) — the Marquee disc mark at
   52×52, then a stacked lockup: "CURATOR" in Archivo Black 21px uppercase, and
   "MARQUEE COLLECTION" in Plex Mono 9px with `.2em` tracking, `#6F6A5C`.
2. **Nav** — COLLECTION · ADD A RECORD · DISCOGS · SYSTEM · SETTINGS. Active item
   is ink background, paper text. Inactive is transparent with `#6F6A5C` text.
   `white-space:nowrap` on every item.
3. **Progress** (right-aligned, `flex:1`) — "**18** OF 40 READY", then a 96×6
   bar: `#DED8C9` track, `1px solid #C9C2B1`, ink fill at the ready percentage.
4. **Roadie indicator** — a 7px pulsing `#B4402C` dot and "ROADIE WORKING", behind
   a `border-left` with `padding-left:16px`.

### 2. The collection

Replaces `pages/QueueView.tsx`.

**Stat band** — four cells in a row, `background:#EFEBE2`, hairline-separated.

- NOT COMPLETE — count in accent, plus a one-line detail ("two still need a visualizer";
  ~~"three still need lights"~~ **changed 2026-08-07**, [ADR 0056](../adrs/0056-need-labels-name-the-act-not-the-artifact.md);
  ~~"three still need a look"~~ **changed 2026-08-10** — lights is no longer a need,
  [ADR 0069](../adrs/0069-the-lights-are-not-a-need.md)).
- READY — count in ink, "ready for the stand".
- NOT STARTED — count in ink, "Roadie will get to them".
- **The rotating stat** (`flex:1.5`) — a button. Clicking advances it. Shows
  `↻ n of 5` top-right in `#A49D8C`. Five stats, chosen at random on mount:

  | Stat | Presentation |
  |---|---|
  | BY DECADE | six bars, 50s→00s+, the tallest in accent |
  | GENRE BREAKDOWN | up to six bars, the largest in accent |
  | TOP ARTIST | Archivo Black 21px name + "n records — more than anyone else" |
  | TOP LABEL | Archivo Black 21px name + "n records pressed by them" |
  | OLDEST AND NEWEST | "1959 → 2012" + "Kind of Blue to The Idler Wheel" |

  Bars: a 42px-tall flex row, `gap:5px`, each bar `flex:1` with `min-width:0` and a
  percentage height floored at 6% so a value of 1 is still visible. Labels sit in a
  matching flex row underneath in Plex Mono 8.5px.

**Filter bar** — EVERYTHING · NOT COMPLETE · n · READY · n as ink/paper toggles,
then right-aligned: a bottom-ruled search input (170px, no border except
`border-bottom`, `outline:none`), SHUFFLED ↻, and a density cycler
(DENSITY ▪▫▫ / ▪▪▫ / ▪▪▪ → 5 / 7 / 9 columns).

> **Widened 2026-08-10** ([ADR 0070](../adrs/0070-the-collection-filters-by-what-a-record-owes.md)):
> one chip per state and one per need — EVERYTHING · NOT COMPLETE · n · NEEDS VISUALIZER · n ·
> NEEDS CARD · n · NEEDS SIGN-OFF · n · READY · n · NOT STARTED · n · STUCK · n. A need chip shows
> every record that still **owes** that thing, not just the ones it is first for, and relabels its
> tiles to the need you picked. EVERYTHING carries no count; STUCK is dropped when nothing is stuck.
> The bar now wraps — eight chips do not fit beside the search at 1280 — and the chips carry their
> own bottom rule so a wrapped row still reads as ruled paper.

> **Widened again 2026-08-11**
> ([ADR 0071](../adrs/0071-a-chip-for-the-records-one-need-is-all-that-is-left-of.md)): a
> `JUST NEEDS …` chip per need sits after the plain ones — JUST NEEDS VISUALIZER · n · JUST NEEDS
> CARD · n · JUST NEEDS SIGN-OFF · n. Where a need chip asks what a record **owes**, these ask what
> it has **left**: only the records owing that one thing and nothing else, which is the pile you can
> finish rather than the pile you can contribute to. They need no relabelling, and they sum to at
> most NOT COMPLETE. The drop-at-zero rule widens from STUCK alone to every transient chip — STUCK,
> NOT STARTED and each JUST NEEDS … — while NOT COMPLETE, READY and the plain need chips stay put at
> zero. Worst case is eleven chips; in practice it stays near eight, because clearing the visualizers
> is what makes JUST NEEDS CARD appear.

**The grid** — `display:grid` with `grid-template-columns:repeat(n, minmax(0,1fr))`.
Each tile is a button: square artwork, then the title (Helvetica 600 12.5px), the
byline, and the **first outstanding need only** — never a count, never "+1". Ready
records read `READY` in `#6F6A5C`; everything else reads its need in accent. The
last cell is a dashed "Add a record" tile.

**Order is shuffled on every visit.** Implement with a seeded shuffle so it's stable
across re-renders within a visit but different next time; SHUFFLED ↻ reseeds.

**Grouped mode** — selecting NOT COMPLETE regroups the grid under section headers
(NEEDS VISUALIZER · n, NEEDS CARD · n, NEEDS SIGN-OFF · n).
**Changed 2026-08-07** ([ADR 0056](../adrs/0056-need-labels-name-the-act-not-the-artifact.md)):
the lights group was ~~NEEDS LIGHTS~~, which claimed a palette was missing when one always exists.
A need label names the act, never the artifact.
**Changed again 2026-08-10** ([ADR 0069](../adrs/0069-the-lights-are-not-a-need.md)): the
~~NEEDS A LOOK~~ group is gone with the need. Renaming the label had fixed the sentence and left
the claim — it was outstanding on every record nobody had personally watched, which is nearly all
of them.
**Grouping stays first-need**, so a sleeve appears exactly once here even though it may answer to
several per-need chips ([ADR 0070](../adrs/0070-the-collection-filters-by-what-a-record-owes.md)).
**Empty groups are not rendered at all.** Below them sits a single STUCK · 1 row on
`#F7ECE9`: a `?` placeholder, the record name, the plain-English failure sentence,
and a FIX IT button — the same row that is the whole page under the STUCK chip.

**Roadie's log** — ~~a footer strip~~ a strip **docked to the bottom of the window**
(**changed 2026-08-07**, [ADR 0055](../adrs/0055-roadies-log-is-docked-to-the-window-not-to-the-page.md):
at the foot of the page you had to scroll the whole collection to reach it). Left:
a dot + "ROADIE'S LOG" — the dot pulses **only while Roadie is busy**, where it once
pulsed unconditionally. Middle: the newest entry, time in mono, truncated with
ellipsis. Then **where Roadie stands**, in words (`IDLE · NOTHING QUEUED`,
`WORKING · n QUEUED`, `PAUSED`) — **added 2026-08-08**,
[ADR 0057](../adrs/0057-the-log-strip-says-where-roadie-stands-not-only-what-it-did.md):
the sentence is history and goes still whether Roadie finished or died, so the strip
has to say which. Right: a THE WHOLE LOG toggle. Expanded, it becomes a `#EAE5DA` panel of
time-and-sentence rows, failures in accent, ending with "Cleared when Curator
restarts." The panel opens **upward** from the dock and is bounded at `45vh`.
**The log is session-only** — do not persist it. Failures live durably in the Stuck
group instead.

### 3. The record

Replaces `pages/AlbumDetail.tsx` and the whole five-station rail
(`components/workflow.tsx`, `rail.ts`).

**Sidebar** — 310px, `flex:none`, `background:#EFEBE2`, `border-right` hairline.
Top to bottom: a `← THE COLLECTION` link; square artwork; a 26px palette strip
(the live palette, ink-outlined, `1px` dividers between swatches); the title in
Archivo Black 25px; the byline; the state label; a full-width ink
`▶  SEE IT IN THE ROOM` button. Pinned to the bottom by `margin-top:auto`:
`↑ PREV`, `NEXT ↓`, and the album id in `#A49D8C`.

**Needs tabs** — "WHAT THIS RECORD STILL NEEDS" as a section label, then four tabs:
Lights · A visualizer · A card · Tags. Each carries a filled `●` or hollow `○` glyph
in mono. Active tab: ink text, `2px solid #B4402C` bottom border.

**Lights panel** (default)

- A `#3F7D4E` dot and "saved a moment ago — edits save as you make them".
  **This is a change to the app: palette edits must autosave.** The old explicit
  Save palette button and `⌘⏎` binding are removed.
- Roadie's note about the record, as prose at 15px / 1.65, `max-width:62ch`.
- Two palettes side by side inside one ink border: FROM THE SLEEVE and FROM THE
  FEELING. The one in use gets `#F7F4EE`, a `· IN USE` accent mark, and its action
  reads "IN USE"; the other gets `#EFEBE2` and "USE THIS INSTEAD →". **Both palettes
  are permanent** — switching never destroys either, and the feeling palette never
  disappears once suggested. Label rows are fixed at `height:12px` with `nowrap`
  spans so the two swatch bars stay on a shared baseline.
- "THE LIGHTS, IN ORDER" — one row per colour: 34px ink-outlined swatch, hex in
  mono, role (DOMINANT / SECOND / ACCENT), a plain-English note about where it lands
  in the room ("the wall wash", "the far corner", "the glow behind the stand"), and
  reorder/remove affordances.
- `+ ADD A LIGHT` and `BACK TO ROADIE'S ORIGINAL` (this replaces "start over"),
  then the reassurance line about both palettes being recoverable.
- Footer: an accent `SEE IT IN THE ROOM →` button and "The lights are signed off in
  the room, with them on."

Dropped from the old Look station and **not** to be reinstated here: artwork
override upload, the source badge, the genre tags, and the raw
`{"transitionMs":…,"holdMs":…}` JSON.

**Visualizer panel**

- A 16:9 player showing the attached clip, washed in the record's palette,
  captioned "playing · loops seamlessly", with `0:07 / 0:20` and `1920×1080` in the
  corners. **The clip plays and loops on this page.**
- Directly beneath, a **Backdrop upload strip**: accent dot, "Uploading to
  Backdrop — 68%", and an 80×5 progress bar. It settles into a quiet green
  "on Backdrop" line when complete, and into an accent failure row with a RETRY
  button on error. **Retry lives here as well as on System.**
- REPLACE · REMOVE · PICK A FILE. There is deliberately **no "paste a link"**.
- A 280px side panel, "ROADIE'S FOUR DRAFTS" — **four** numbered prompts
  (`01`–`04`), each with its own COPY button, then LET ROADIE MAKE IT and the cost
  warning in accent. Four, not one; each individually copyable.

**Card panel** — four candidates in a 2×2 grid at **7:5 landscape**. The one in use
gets `2px solid #B4402C`, an `IN USE` label and a DOWNLOAD button. The others are at
`opacity:.5` with "USE THIS ONE INSTEAD". Then ASK FOR FIVE MORE · EDIT THE PROMPT ·
UPLOAD MY OWN. **"Use", never "keep". You download one; there is no print sheet.**

**Tags panel** — two panels, THE SLEEVE and THE SHELF CARD, each with an 84px QR
placeholder, its `curator:album:<id>` / `curator:card:<id>` URI in accent mono, and
its written state. Then SEND THIS RECORD TO THE FLIPPER · DOWNLOAD .NFC · HOW DO I
WRITE THESE? — **per record only; the bulk "send list to Flipper" is removed.**

Below a hairline, "THEN CHECK THEM" and a bordered row: "Tap each tag on your phone
and confirm it opens the right record. This is where the bugs turn up." plus a
single ink **TAGS VERIFIED** button. **Verification stays a distinct step** — it
catches real bugs — but **one button covers both tags.**

### 4. The room

Replaces `components/PreviewWorkstation.tsx` and `pages/DemoRoom.tsx` — one screen
does both jobs.

A flex **column**: the stage flexes, the control dock is a real footer sibling. Do
not absolutely position the dock — the sleeve-on-the-stand must sit in the space
actually left over.

**Stage** (`flex:1`, `min-height:320px`, `overflow:hidden`)

- The wash: `position:absolute; inset:-6%`, `ppDrift`, and
  `radial-gradient(130% 100% at 50% 18%, <second> 0%, <dominant> 55%, #0D0A10 100%)`
  built from the record's live palette.
- A top bar: `← THE RECORD`, the title in Archivo Black 17px white, the byline at
  50% white, and the arm toggle pushed right — **BENCH ONLY** (outlined) or
  **IN THE ROOM** (accent filled). A plain toggle, no confirm dialog.
- Centred in `inset:74px 0 22px`: a 70%-wide hatched rectangle labelled
  "THE VISUALIZER, LOOPING", and beneath it a 70px square with
  "THE SLEEVE, ON THE STAND".

**Control dock** (`flex:none`, `rgba(10,7,12,.94)`, `border-top` at 25% white)

Four groups, `gap:34px`, `flex-wrap:wrap`:

1. **HOW THE LIGHTS MOVE · THIS RECORD** (250px) — three horizontal range inputs
   with `accent-color:#E0A24A`: Transition (1–30s, default 12), Hold (5–120s,
   default 45), Brightness (10–100%, default 70). Each labelled with its live value
   in mono. **All three are per record and save with it.**
   **There are no colour faders here** — colour editing belongs on the record page.
2. **LIGHT PATTERN** — CROSSFADE · PULSE · HOLD STILL, selected one filled paper.
3. **WHILE YOU LOOK** — ♪ PLAY THE ALBUM · LIFT THE SLEEVE · PLACE ANOTHER.
4. **SIGN IT OFF** (`margin-left:auto`) — a paper-filled Archivo Black
   **Looks right ✓** button, and "The lights are only signed off from in here."

**Approval lives here, not in a form.** Signing off returns to the collection and
fires the toast.

### 5. Ready toast

Not a screen — the old "record finished" page became a toast.
`position:fixed; right:26px; bottom:26px; z-index:60`, `#F7F4EE`, ink border, the
one shadow in the design, `max-width:360px`, `ppToast 5s ease forwards`.

46px artwork, "<Title> is ready" in Archivo Black 16px, then "Lights, visualizer,
card and tags — all done. Tap to watch it."

**The whole toast is a button** — tapping it opens the room for that record. It
otherwise fades on its own after ~5s and must not block moving to the next record.

### 6. Add a record

Replaces `pages/AddAlbum.tsx`. Title only, no explanatory subtitle.

Tabs: **SEARCH · TYPE IT IN · SYNC DISCOGS ›**. Two tabs plus a link out — "paste a
link" is removed, and Discogs is no longer a tab (it navigates to its own screen).

A large bottom-ruled search input (Helvetica 22px, `2px solid #17150F` underline),
then results in a 4-up ruled grid. Below a hairline, a running
"added just now: **Kind of Blue** · **Sketches of Spain** — keep searching, they'll
appear in your collection". **Adding does not navigate away.**

### 7. Discogs

New screen. Discogs is a **synced collection**, not an album picker.

Header: "Your Discogs collection" plus an outlined SYNC NOW button (kept for when
you've just added something and don't want to wait).

Four stat cells: IN DISCOGS `312` · IN CURATOR `310` · CAME IN TODAY `6` ·
LAST SYNCED "today, 18:40 · automatic".

**CAME IN TODAY · 6** — a 6-up grid with the caption "already in your collection —
nothing to approve". **Sync is automatic; there is no import or approve step.** Each
shows the need it already has, or ROADIE IS ON IT, or NEXT IN LINE.

**COULDN'T MATCH TO SPOTIFY · 2** — the only real to-do here. "These stay here until
you deal with them — they never leave this list on their own." Each row on
`#F7ECE9` with an ink border: the pressing name, why it failed, and SEARCH BY HAND /
PICK ONE plus SKIP.

Footer rule: "Multiple pressings of the same record collapse into one. Removing
something in Discogs leaves it here — delete it from your collection if you want it
gone." Both behaviours are decided: **pressings collapse; Discogs removal does not
cascade.**

### 8. System

Close to today's `pages/SystemStatus.tsx`, minus the full album matrix.

Four service cells, each with a status dot, its name, a **plain-English gloss**
(the lights / the screen / the stand / the sound), and its port. The failing one
gets `#F7ECE9`, accent text, the raw `connect ECONNREFUSED`, and RETRY /
COPY ERROR buttons.

**IN FLIGHT · 2** — one row per job with a 110×5 progress bar and `3/13` or `68%`
in mono. (`media-sync`, `visualizer upload`.)

Two columns: **PLAYING RIGHT NOW** (SCREEN / LIGHTS / SOUND / STAND, the last in
accent when Stylus is down) and **RECORDS THAT AREN'T EVERYWHERE THEY SHOULD BE** —
exceptions only, not the whole matrix.

### 9. Settings

Title only. Two columns.

Left, **THE ROOM AND THE SERVICES**: which room, then **all four** service URLs
(Conductor, Backdrop, Stylus, Amp) as bottom-ruled fields. Then **ACCOUNTS** — three
rows with green dots: Spotify, Gemini, **Discogs**, each "— connected" with a CHANGE
action. Keys collapse to this; the fields are behind CHANGE.

Right, **WHAT ROADIE MAY DO ON ITS OWN** — framed as permissions, not feature flags.
Four checkboxes (15px squares, ink-filled when on): Draw card art (on, "Cheap —
about five images a go"), Make the visualizers (**off**, "Metered and pricey. Off —
Roadie just drafts four prompts for you"), Suggest a second palette (on), Follow my
Discogs collection (on, "Checks once a day and brings new records in").

### 10. First run

In the walkthrough only (plate S01) — not in the hi-fi file. "Your collection is
empty", then a three-step checklist: Connect Spotify ✓ · Connect Gemini ✓ · Point
Curator at your room. **The room step does not block** — "Add your first record" is
enabled, with "the room can be pointed at later — you just can't play anything until
it is."

---

## Interactions & behaviour

| Trigger | Result |
|---|---|
| Click a nav item | switch screen |
| Click a collection tile | open that record, Lights tab, sleeve palette selected |
| Click the stat panel | advance to the next of the five stats |
| Click SHUFFLED ↻ | reseed the grid order |
| Click the density cycler | 5 → 7 → 9 → 5 columns |
| Select NOT COMPLETE | regroup by first need; drop empty groups |
| Select a need chip | every record still owing that thing, relabelled to it |
| Select a JUST NEEDS … chip | only the records owing that one thing and nothing else; no relabel |
| Select NOT STARTED / STUCK | the records no work chip includes; STUCK draws as rows |
| Type in search | filter on title + artist, case-insensitive |
| Click THE WHOLE LOG | expand/collapse the session log |
| Click a needs tab | swap the panel; no navigation |
| Click USE THIS INSTEAD | swap the live palette; both remain available |
| Edit a colour | autosave; update the "saved" line |
| Click SEE IT IN THE ROOM | open the room for the current record |
| Drag a room slider | update that value live for this record |
| Click the arm toggle | BENCH ONLY ⇄ IN THE ROOM, no confirm |
| Click Looks right ✓ | return to the collection and fire the toast |
| Click the toast | open the room for that record, cancel the timer |
| Toast timeout (~5s) | fade and clear |
| Click ← THE RECORD / ← THE COLLECTION | go back one level |
| Click ↑ PREV / NEXT ↓ | move through records without leaving the page |

Not built in the prototype and needing real work: hover and focus states (the
prototype has none — add them, and make every control keyboard-reachable),
loading and empty states beyond first run, the Discogs "pick one of three matches"
picker, and `prefers-reduced-motion` handling for `ppDrift`.

Keyboard is explicitly **not** a priority for this overhaul — the user asked to
optimise for clarity instead. The old `⌘K` palette, `j/k`, `1`–`5` and `⌘⏎` bindings
are gone. Don't reinstate them without asking.

---

## State

Prototype state, as a guide to what each screen needs:

```
view          "collection" | "record" | "room" | "add" | "discogs" | "system" | "settings"
filter        "all" | "needs" | "ready"
query         string
density       0 | 1 | 2                → 5 | 7 | 9 columns
seed          number                   → the shuffle seed
statIdx       0..4                     → which of the five stats
logOpen       boolean
selected      album id
need          "lights" | "visualizer" | "card" | "tags"
useFeeling    boolean                  → which palette is live
armed         boolean                  → bench vs. the real room
pattern       "crossfade" | "pulse" | "still"   ─┐
transition    1..30 seconds                      ├ per record, persisted
hold          5..120 seconds                     │
brightness    10..100 percent                   ─┘
toast         album id | null
```

In the real app most of this is server state reached through `src/api.ts`. `view`,
`need`, `selected` become routes; `filter`, `query`, `density` are good candidates
for URL search params so a session survives reload. `seed` and `logOpen` are
ephemeral. The room's four settings and the chosen palette are **per-album
persisted** values and need API support — check whether `transitionMs`/`holdMs`
already cover transition and hold, and whether brightness and pattern exist at all.

### Backend changes this design assumes

Flag these before building:

1. **Palette edits autosave.** Today they're explicit. The design has no save button.
2. **Brightness and light pattern per record.** May not exist yet.
3. **Four visualizer prompt variants** per record, not one.
4. **Discogs collection sync** — a standing relationship with a last-synced
   timestamp, a daily poll, and durable per-pressing unmatched records. Today's
   Discogs support imports selected albums.
5. **Pressing collapse** — many Discogs pressings to one Curator record.
6. **Collection statistics** — decade, genre, artist, label, oldest/newest. These
   may need new aggregate endpoints; `label` in particular may not be stored today.
7. **A first-outstanding-need field**, or enough per-asset state to derive one
   consistently in both the collection and the record page.
8. **Verification as one action covering both tags**, distinct from tag-write.

---

## Assets

- **`marquee-logo.jpeg`** — the user's Marquee logo: a hand-inked disc with sound
  waves, a tonearm and a grid, over the hand-lettered word MARQUEE, on off-white
  paper. Supplied by the user; it is the project's real logo.
  In the masthead only the **disc mark** is used, cropped out of the file: a 52×52
  overflow-hidden box containing the image at `width:130px`, offset
  `left:-38px; top:-8px`, with `mix-blend-mode:multiply` so the paper texture
  merges into `#F2EFE8`.
  **Ask the user for a mark-only asset** (ideally SVG, transparent) and replace the
  crop — cropping a JPEG is a prototype shortcut, not a shippable approach. The
  logo needs no restyling: it is already ink on warm paper and matches the theme.
- **Album artwork** is a placeholder everywhere: a 45° two-tone stripe built from
  each record's palette (`repeating-linear-gradient(135deg, c0 0 7px, c1 7px 14px)`).
  Real covers replace it. Keep the ink `outline` treatment.
- **QR codes** are CSS checkerboards. Generate real ones from the tag URIs.
- **No icons.** Everything is a typographic glyph: `●○ ↑↓✕ ← → ▶ ♪ ↻ ✓ ?`. Keep it
  that way — an icon set would fight the printed-paper direction.

---

## Files in this bundle

| File | What it is |
|---|---|
| `Curator - Pressing Plant.dc.html` | **The target.** Hi-fi, interactive, all screens. |
| `Curator - Screen walkthrough.dc.html` | 16 annotated wireframe plates. The behavioural spec. |
| `Curator - Current UI.dc.html` | The app as it stands today, for diffing. |
| `Curator - Theme directions.dc.html` | The three theme options. Pressing Plant is `3b`; the other two are context. |
| `Curator UX - Wireframes.dc.html` | The four original direction explorations. `2a` was chosen. |
| `marquee-logo.jpeg` | The logo asset. |
| `image-slot.js` | Support file for the drop-slots in the theme-directions file. Not part of the design. |
| `support.js` | Runtime for the `.dc.html` format. **Not application code — ignore.** |

Open any `.dc.html` file directly in a browser. The Pressing Plant one is fully
clickable; work through it before writing code.

### Where each screen maps in the codebase

| New screen | Replaces |
|---|---|
| The collection | `src/pages/QueueView.tsx` |
| The record | `src/pages/AlbumDetail.tsx`, `src/components/workflow.tsx`, `src/rail.ts` |
| Lights panel | `src/components/PaletteEditor.tsx` |
| The room | `src/components/PreviewWorkstation.tsx`, `src/pages/DemoRoom.tsx` |
| Add a record | `src/pages/AddAlbum.tsx` |
| Discogs | new; extracts the Discogs tab out of `AddAlbum.tsx` |
| System | `src/pages/SystemStatus.tsx` |
| Settings | `src/pages/Settings.tsx` |
| Roadie's log | `src/components/RoadieStrip.tsx` |
| Ready toast | new |
| Theme | `src/styles.css` — rewrite, don't extend |

`src/format.ts` holds the state-label mapping and will need rewriting against the
new vocabulary. `src/rail.ts` encodes the five-workstation model and should be
deleted along with the rail.
