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

## 3. Design language — "backstage marquee"

**Ratified as-is.** It is coherent, on-theme, and already implemented throughout; this section
promotes it from a CSS comment to a specified contract.

> Warm near-black, a single theater-amber accent used with restraint, tracked-uppercase labels like a
> stage cue sheet. The signature is the lit-bulb pulse on whatever album Roadie is working right now.

### 3.1 Tokens

Defined in `:root` in `styles.css`. These names are the contract; components reference tokens, never
literal hex.

| Token          | Value     | Role                                                         |
| -------------- | --------- | ------------------------------------------------------------ |
| `--bg`         | `#14110f` | Page ground. Warm near-black, deliberately not neutral gray. |
| `--panel`      | `#1e1a17` | Cards, rows, controls.                                       |
| `--panel-2`    | `#241f1b` | Raised or nested surface.                                    |
| `--line`       | `#2e2823` | Borders, dividers, control outlines.                         |
| `--text`       | `#ede6db` | Primary text. Warm off-white.                                |
| `--muted`      | `#9a8f82` | Secondary text, labels, timestamps.                          |
| `--amber`      | `#f5a623` | **The** accent: marquee bulb, primary action, next action.   |
| `--amber-soft` | `#6b4e1e` | Amber at rest — dim bulb, inactive accent.                   |
| `--cyan`       | `#48c4c4` | Roadie is working. Reserved; means nothing else.             |
| `--alert`      | `#e5484d` | Error, destructive action.                                   |
| `--sage`       | `#6bbf59` | Healthy, connected, verified.                                |
| `--radius`     | `10px`    | Panels and cards. Buttons use `8px`.                         |

**Amber is scarce by design.** It marks the one thing to do next. A screen with three amber elements
has no next action — it has three, which is none. If everything needs emphasis, the layout is wrong.

### 3.2 Type

`Inter` with a system fallback stack; `ui-monospace` for identifiers, payloads, and prompts. Base
`15px / 1.5`.

The one distinctive move is the **cue-sheet label**: `12px`, `letter-spacing: 0.16em`,
`text-transform: uppercase`, `--muted`, underlined by a `--line` rule. It marks section and group
boundaries. It is a _label_, never body copy — nothing longer than about four words gets tracked
uppercase.

### 3.3 Motion

Motion carries state, never decoration. Three sanctioned uses:

- **The bulb pulse** — the album Roadie is working on, in `--cyan`. The signature; do not reuse the
  animation for anything else.
- **The artwork skeleton** — a cover that is still downloading (§10, issue
  [#134](https://github.com/dylanleatham/Marquee/issues/134)). Distinct from the bulb pulse: it
  stands in for the art itself rather than annotating a row.
- **Transitions** — `150ms` for hover/focus affordances, `500–600ms` crossfades where the runtime
  itself crossfades (Preview, Demo Room), so what you rehearse matches what Backdrop does.

`prefers-reduced-motion: reduce` disables animation globally. Already implemented; keep it.

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

### 3.5 Focus

Every interactive element has a visible focus ring that meets 3:1 against its own background. This
is not optional once the app has a keyboard path (§9) — an invisible focus ring makes keyboard
navigation unusable.

Contrast was audited at ratification: `--muted` on `--bg` is ≈6.0:1 and `--amber` on `--bg` is
≈9.4:1, both clearing AA for body text. Any new token pair must be checked before it lands.

## 4. The workbench principle

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

## 5. Album detail — the rail

The detail page is a **left rail of five workstations** beside a full-width canvas. The selected
workstation gets the whole canvas; the rail is always visible.

Eight scrolling sections were the wrong unit — with five video prompts and five card-art prompts each
rendered in full, the page became a document to scroll rather than a bench to work at. Five
workstations is the right unit because it matches how the work actually arrives: _I have the card
art, let me go do card things._

| #   | Rail item   | Contains                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | **Look**    | Palette (swatches, roles, reorder, reset-to-auto), the derived pattern **read-only**, the Motion picker (Auto + all seven pattern types), artwork override _(built 2026-07-25, issue #100; streaming opt-in added 2026-07-27, [ADR 0035](../adrs/0035-streaming-effect-is-a-per-album-opt-in.md); widened to every pattern type 2026-07-29, [ADR 0039](../adrs/0039-one-motion-picker-clip-patterns-are-selectable.md))_ |
| 2   | **Video**   | Five video prompts · clip gallery · splice · attach / detach / replace                                                                                                                                                                                                                                                                                                                                                   |
| 3   | **Card**    | Five card-art prompts · candidate set · attach / detach / replace · download print version                                                                                                                                                                                                                                                                                                                               |
| 4   | **Preview** | Bench preview and room rehearsal (§6)                                                                                                                                                                                                                                                                                                                                                                                    |
| 5   | **Ship**    | Tag payload + QR · `.nfc` download · mark written (sleeve / card) · verify physical                                                                                                                                                                                                                                                                                                                                      |

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

Beneath it, the **Motion picker** offers one list of eight
([ADR 0039](../adrs/0039-one-motion-picker-clip-patterns-are-selectable.md)): **Auto** plus the four
CLIP patterns (static, rotate, pulse, crossfade) and the three streaming effects (aurora, shimmer,
wave). Auto is a peer chip, not a separate clear button — the album always has exactly one answer,
and the default deserves to be visible as a choice. Selection carries a check glyph as well as the
chip fill (§3.4), never colour alone.

The two halves differ in one way, and the UI says which: the streaming three need an **entertainment
area** on the bridge, so they sit in their own labelled group and the note names the derived pattern
they fall back to without one. A CLIP pick plays on any bridge and simply displaces the derived
pattern in the payload. Per §10 the control states this rather than degrading silently.

Choosing anything but Auto and static reveals **its own knobs** as sliders
([ADR 0036](../adrs/0036-streaming-effect-params-are-tunable.md),
[ADR 0039](../adrs/0039-one-motion-picker-clip-patterns-are-selectable.md)) — tunable because they
belong to the override, not to the derived pattern, so there is still no computed value being edited
in place. Each shows its number beside the slider, since a slider alone can't be read back or
reproduced, and saves on release rather than on every drag frame. Ranges come from
`PATTERN_PARAM_SPECS` in `@marquee/contracts`, the same source the server validates against. Judge
the result in **Room rehearsal** (§6.2) — bench preview never drives the lights.

## 6. Preview — bench and room

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
feature. Curator proxies each runtime service so the browser never holds the shared secret; audio
follows the same pattern (`POST /api/demo/audio` → Amp's `POST /api/admin/play`), which is why this
costs almost nothing to build.

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

## 8. Queue view

Essentially as built, and the strongest screen in the app: grouped by which step is next, one row per
album with cover, title/artist, wait time, and a single next-action link. Sections in attention
order — _Needs you right now_, _Roadie is on it_, _Needs your attention_, _Done_. Keep all of it.

Two corrections:

- **The "needs you right now" count needs a real home.** It is currently written into
  `document.title`, an affordance that assumes a browser tab (§2). In a single-window app that count
  belongs **in the app header**, visible while you work. Optionally mirror it to the taskbar/dock
  badge for when the window is not focused — that is where an OS-level count is actually read.
- **Empty is a positive state.** "All caught up. Roadie is idle," not an empty container. Already
  specified in the onboarding workflow; keep it true.

The onboarding workflow's rule stands: the needs-you number is the only number that gets this
treatment. Adding queue depth or total albums beside it muddies the one signal that answers "should I
sit down now?"

## 8.5 System status — the page you open when something is wrong

Added 2026-08-01, at `/system`. Every runtime service already had a status endpoint; what was
missing is that **the failures worth catching are disagreements between hosts**, and answering one
meant curling four services and diffing the results by hand.

So the heart of the page is the **album matrix** — the only view that says "Curator has thirteen
albums and the runtime has six". One row per album, one column per host that should be holding part
of it:

| Column              | Answers                                                                                                                     |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Video attached      | Curator has a visualizer — without one there is nothing downstream to hold                                                  |
| On Conductor        | The asset was pushed, so a scan can drive the lights ([ADR 0045](../adrs/0045-curator-pushes-album-assets-to-conductor.md)) |
| In Backdrop library | Backdrop can resolve the scan URI to a file path                                                                            |
| Video on Backdrop   | …and the bytes are actually there ([ADR 0038](../adrs/0038-curator-pushes-media-over-http.md))                              |

The last two are deliberately separate columns. The entry and the bytes travel on different legs, so
"listed but unplayable" is a real state — and it is exactly how an album sat in the library with no
mp4 for a day, looking healthy from every angle.

Also on the page: service reachability, what is playing (video / lights / audio), **the stand**, jobs
in flight, and one **Sync everything** button. Read-only apart from that button — this is the page
you open when something is wrong, so it must never be the reason something is wrong.

**The stand** is the section that pays for itself during bring-up. It reports Stylus's _reader_ view,
not its state machine (stylus-spec §8), which distinguishes three things that used to be one blank:
nothing on the stand, a tag present whose NDEF won't decode, and a tag that decoded but carries
something unactionable. The last refusal is kept after the sleeve is lifted.

Two rules this page must not break:

- **Never colour alone (§3.4).** Every matrix cell is a glyph plus screen-reader text naming what it
  means _for that column_ — "no" is not equally bad everywhere; no video attached is mid-workflow,
  missing from Conductor is broken. Each album also carries a **word**, Ready or Incomplete.
- **State the limits rather than implying completeness.** Conductor's playback view covers only CLIP
  playback and carries no `curatorId`, so an album on a streaming pattern reports nothing. The page
  says so in place instead of showing a confident blank.

## 9. Desktop affordances

### 9.1 Keyboard

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

#### The command palette (`Ctrl/⌘ K`)

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

#### The primary action (`Ctrl/⌘ Enter`)

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
