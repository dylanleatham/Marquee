# ADR 0052 — Curator is three places, not a nine-state queue

Status: accepted · Date: 2026-08-04 · Supersedes:
[ADR 0026](0026-album-detail-is-a-workbench.md) (the five-station rail),
[ADR 0043](0043-command-palette-carries-commands.md) (the command palette),
[ADR 0044](0044-workstations-declare-their-primary-action.md) (per-workstation primary action) ·
Amends: curator-ui-ux.md (§3 design language, §5 the rail, §8 queue view, §9.1 keyboard),
curator-spec.md (§8 `GET /api/albums` shape) · Implements: the design handoff in
`docs/design_handoff_curator_overhaul/`

## Context

Curator's UI was built as a **pipeline made visible**. The queue groups albums by Roadie's machine
state into nine buckets; the album page is a five-station rail (Look → Video → Card → Preview →
Ship) walked in order; the vocabulary is the state machine's ("awaiting review", "awaiting tag
write", "fully lit"). That was the honest shape while the state machine was the thing being built.

It is the wrong shape for the thing that exists now. Three problems, all the same problem:

1. **The order is fiction.** Nothing about a record requires lights before a visualizer before a
   card. The rail asserts a dependency the system does not have, and the queue's nine buckets are
   nine names for "one of four things is missing".
2. **The machine leaks into the copy.** `awaiting_verify`, `2k7bxq9m`, `spotify_lookup_failed` — a
   person looking at their own record collection is reading Roadie's internal vocabulary.
3. **The collection is invisible.** The queue only ever showed work-in-progress. There was no
   screen that answers "what do I own?", which is the question you actually have when you sit down.

The design work (four direction explorations, then three rounds of review on the chosen hybrid) is
in `docs/design_handoff_curator_overhaul/`. This ADR records what was settled.

## Decision

**Curator becomes three places, plus supporting screens.**

- **The collection** — every record, art-first, in a shuffled grid. The queue survives as a filter
  chip, not as the home screen.
- **The record** — one page listing the four things a record still needs (lights, a visualizer, a
  card, tags), doable in any order. No stepper, no rail.
- **The room** — a full-bleed simulation washed in the record's own palette, and the only place a
  record is signed off, so approving always means having just watched it.

Four decisions underneath that are load-bearing:

**The need is derived from the assets, not read off the state machine.** A record needs lights until
its preview is approved, a visualizer until one is attached, a card until one is attached, and tags
until both are written _and_ checked. `RoadieState` still drives Roadie; it no longer drives the UI's
model of what is left to do. This is what makes "any order" true rather than merely claimed — the
four needs are independent predicates over the asset, so there is no order to enforce. Derivation is
one pure module (`ui/src/needs.ts`) used by both the collection and the record page, so the two can
never disagree about what a record needs.

**A record shows its first outstanding need only** — never a count, never "+1". The precedence is
lights → visualizer → card → tags, which is a reading order, not a dependency.

**No machine state name and no album id appears in the UI.** Roadie's log says "Pulled the lights
from _Kind of Blue_", not `2k7bxq9m (generating_palette)`. Raw error codes are allowed in exactly one
place: the per-service errors on the System screen, where `connect ECONNREFUSED` is the actionable
text. Everywhere else a failure is a sentence. The id may appear once, small and muted, at the bottom
of the record sidebar.

**The visual direction is "Pressing Plant": light, printed, editorial.** Warm paper, ink black, one
brick-red accent, hairline rules instead of cards, zero border radius, no shadows except the toast.
Archivo Black for display, Helvetica for body, IBM Plex Mono for anything counted. It replaces
"backstage marquee" (warm near-black + theater amber) wholesale — the two do not compose, so
`styles.css` is rewritten rather than extended.

**The keyboard layer is withdrawn.** `⌘K`, `j`/`k`, `1`–`5` and `⌘⏎` are removed, and with them the
command palette ([ADR 0043](0043-command-palette-carries-commands.md)) and the declared per-bench
primary action ([ADR 0044](0044-workstations-declare-their-primary-action.md)). The user asked
explicitly to optimise for clarity over speed: an accelerator layer is worth its cost when the
underlying screen is dense and ordered, and the new collection is neither. Every control stays
keyboard-_reachable_ — that is an accessibility floor, not an accelerator, and it survives.

## Consequences

- **`GET /api/albums` grew.** Deriving the need client-side needs per-asset state in the list
  response, so `summary()` now carries `year`, `genres`, the palette hexes, and the card-art / tag /
  verification / error facts. Additive; existing consumers are unaffected.
- **Colour is doing more work than it used to, and must not do it alone.** The accent carries "not
  complete" across the whole collection. Every use is paired with a word (`NEEDS LIGHTS`, `READY`)
  or a shape (the dashed outline, the `?` placeholder), per curator-ui-ux §3.4 — a grid where the
  only difference between done and not-done is a hue would be unreadable to this project's own user.
- **Roadie's log is session-only** and is not persisted. Failures live durably in the collection's
  Stuck group instead, so nothing important depends on the log surviving a restart.
- **The rail, the command palette and the queue's keyboard model are deleted, not deprecated** —
  each with the screen it served, which is why they do not all go at once. Gone with the collection:
  `QueueView.tsx`, `queueKeys.ts`, `RoadieStrip.tsx`, and `commandPalette.ts` /
  `CommandPalette.tsx` (the palette outlives no screen — the whole keyboard layer is withdrawn).
  `rail.ts`, `PeerNav.tsx`, `PaletteEditor.tsx`, `ArtworkSection.tsx`, `FeelingPalette.tsx`,
  `MotionPicker.tsx` and finally `workflow.tsx` itself — the five workstations — went with the record
  page (2026-08-05). `PreviewWorkstation.tsx`, `DemoRoom.tsx`, `RoomArmSwitch.tsx` and
  `primaryAction.tsx` went with the room (2026-08-06). "Deprecated" would mean leaving them
  reachable; nothing new may use them. `/demo/:curatorId` still resolves — to the room — because that
  address is in the old screen's own history.
- **A screen landing before its successor leaves real gaps, and they are written down rather than
  discovered.** Deleting the rail took four controls with it. Three came back with the room on
  2026-08-06 — the motion picker (as the dock's LIGHT PATTERN and its knobs), bench preview, and desk
  audio. **Room rehearsal (`simulate-scan`) did not**: the room drives the lights through
  `demo/play` rather than replaying a scan, so the rehearsal's fan-out to Backdrop and Amp has no
  control. Its routes are untouched. Worth restoring if "does a scan of this actually work
  end-to-end" turns out to be a question the room can't answer.
- **"Something's off" is obsolete rather than dropped.** The old Preview bench had a reject control
  (`POST /preview/reject`) that sent a record _back_ to review or video. It existed because the rail
  was linear: going back was a transition you had to ask for. On the record page every tab is always
  open, so if the lights are wrong you open Lights and change them — there is no "back" left to
  request. The route and `api.rejectPreview` stay (the state machine still supports the transition,
  and it is the escape hatch if a record is somehow stuck forward of where it should be); the room
  simply has one verdict, `Looks right ✓`, which is what the design draws.
- **The design's brightness slider is not built, because no contract can carry it.**
  `palette-payload.schema.json` has no global brightness and specifies `static` as
  `maxProperties: 0`, so a brightness knob on HOLD STILL would build a payload Conductor's own
  contract rejects. ADR 0036 settled the principle: a UI offering a value the server refuses is
  worse than no slider. The dock therefore renders `PATTERN_PARAM_SPECS` for the chosen pattern —
  every slider shown does something. Delivering the design's brightness means a change across the
  payload schema, Conductor and Palette Press, and is a decision about what brightness _means_ on a
  Hue lamp (a dimmed colour, or the lamp's own brightness channel) as much as a plumbing job.
- **The clip gallery and splice are replaced by one press (issue #29).** `generateVideoSet` produces
  **several `videoClips`, not an attached visualizer**; the old bench showed a gallery and let you
  reorder, deselect and splice them into a loop. The design has neither, and shows only a player —
  so **`LET ROADIE MAKE IT` generates and then splices**, in index order, and the manual step is
  gone. Stopping at the clips would leave the button looking like it did nothing, because nothing on
  the record page can render them.

  Reordering and deselecting go with the gallery. That is a real reduction, and the right one for
  now: choosing among four clips you have not watched is not a decision the old UI supported well
  either (the gallery showed thumbnails), and the loop is re-makeable at any time by generating
  again. If picking among clips turns out to matter, it belongs in the room, where you can watch
  them.

  **The automatic join cannot cover two cases** — the app closed while the job ran (the job hook
  adopts an already-finished job without re-firing completion), or the splice itself failed — so the
  panel says when clips exist with no visualizer and offers to join them. Without that, those clips
  are invisible.

- **Some of the design needs backend work that does not exist yet**, flagged here so it is not
  rediscovered as a bug: brightness and light pattern become per-record; Discogs as a standing synced
  collection with durable unmatched rows; pressing collapse; collection statistics; and editing a
  drafted prompt by hand. `label` in particular is not stored on an asset today, so the "top label"
  statistic cannot be computed — the statistic rotation is built from the statistics that _have_
  data, and grows to five on its own when it lands. Palette autosave and the one-press tag
  verification landed with the record page.
- **The design's counts are not always requirements.** It asks for four visualizer drafts where the
  backend writes five; the requirement underneath was "every draft visible and separately copyable,
  not one behind a chooser", and that is met by rendering however many exist. Cutting to four would
  mean deleting one of five named options from a metaprompt — a content decision, not a constant.
- The overhaul lands screen by screen. While it does, `styles.css` carries a marked legacy block so
  the not-yet-converted screens stay usable; it is deleted with the last of them.
