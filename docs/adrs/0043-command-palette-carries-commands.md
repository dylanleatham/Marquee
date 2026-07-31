# ADR 0043 — The command palette carries commands, not only albums

Status: accepted · Date: 2026-07-31 · Amends:
[curator-ui-ux](../specs/curator-ui-ux.md) (§9.1 `Ctrl/⌘ K` row: deferred → built) · Related:
[ADR 0028](0028-preview-bench-and-room-modes.md) (room arming stays in the status bar) · Part of
[#95](https://github.com/dylanleatham/Marquee/issues/95)

## Context

[curator-ui-ux §9.1](../specs/curator-ui-ux.md) specifies `Ctrl/⌘ K` as "jump to album (fuzzy over
title/artist)". It has been marked **deferred** since the keyboard path shipped, for a reason worth
restating: unlike `j`/`k`/`Enter`, it is not a handler over an existing surface. Nothing in Curator
draws a floating input with a ranked list, so the binding needed a component before it could need a
keymap.

That component — an input, a ranked list, keyboard selection, dismissal — is the whole of a command
palette. Having built it for albums, restricting it to albums is itself a decision, and the one the
issue asked to be made deliberately.

The case against carrying commands is real: the palette becomes a second place every navigation
lives, free to drift from the header and the app menu, and "what's in the palette?" becomes a
question with no principled answer. The case for is that the surface is already the fastest way to
reach anything, and a user who has learned one keystroke should not have to learn where each
destination hides.

## Decision

**⌘K ranks albums and commands in one list, albums first.**

1. **Albums require a query.** With an empty input the palette lists commands only. Fuzzy matching
   needs letters, and dumping a whole library into an empty overlay buries the short list that is
   worth showing before the user has typed.
2. **Albums always sort above commands** when both match, so the behaviour §9.1 specifies is the
   behaviour you get; commands are what is left over below them.
3. **The command list is navigational only.** Queue, Add album, Settings, and the NFC how-to. Every
   entry lands somewhere and changes nothing on its own.
4. **Ranking is a pure function** (`ui/src/commandPalette.ts`), as `queueKeys.ts` is, and for the
   same reason: the interesting claims ("`pnk` finds Pink Floyd", "a title hit outranks an artist
   hit") are then checkable without a DOM or a render race.
5. **The palette is reachable by mouse** from a header button, per §9.1's standing rule that the
   keyboard is an accelerator and never the only path.

### What the palette will not carry

**Arming the room.** It drives real lights and real speakers in a room that may have people in it,
and [ADR 0028](0028-preview-bench-and-room-modes.md) put its switch in the status bar precisely so
its state is continuously visible. A palette entry would let it be flipped by a half-remembered
keystroke and then forgotten — the exact failure the status-bar switch exists to prevent. PR #92
kept it out of the app menu on the same reasoning; this is that decision applied again, not a new
one.

**Mutations in general.** "Draft the prompt" and "generate card art" spend money
([ADR 0027](0027-generation-is-invoked-not-pipelined.md)), and `PromptSlot` deliberately marks
spending controls as distinct from the free ones. A fuzzy list where a mistyped query can put a
paid action under the cursor is the wrong surface for them.

The line, then: **the palette takes you places; it does not do things.** That is a rule that answers
"should this be in the palette?" without re-litigating it per entry.

## Consequences

- **⌘K is the fastest path to any album**, which is the success criterion §9.1 opens with — ten
  albums in one session, without mousing to the queue and finding your place.
- **Two places now list navigation** (the palette and the Electron menu, §9.2). They agree today and
  a divergence is a real risk; the mitigation is that both are short and both are in this repo.
- **The palette is not in the app menu.** The menu navigates by loading a route
  ([§9.2](../specs/curator-ui-ux.md), no preload, no IPC), and the palette is renderer state — a
  menu item would have to reload the window to open an overlay. The header button is the
  discoverable half instead.
- **No new endpoint.** `GET /api/albums` already returns title, artist and state. It is fetched when
  the palette opens rather than polled: a background poll of the whole library, all session, to
  serve a modal held open for two seconds is the wrong trade.
- **A failed library fetch degrades rather than empties.** The commands are local, so they still
  work, and the palette says why the albums are missing — an empty list would read as "you have no
  albums".
