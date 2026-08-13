# ADR 0074 — The default visualizer is chosen in Curator, not scp'd

**Date:** 2026-08-12
**Status:** Accepted
**Amends:** [ADR 0073](0073-a-record-with-no-visualizer-plays-the-default.md) — which specified the
clip but left getting it there to the operator.

## Context

[ADR 0073](0073-a-record-with-no-visualizer-plays-the-default.md) gave Backdrop a default clip to
play for any record with no visualizer of its own, and left the file itself to the human:
`PUT /api/media/default` or an `scp`, plus a hand-run `ffmpeg` to meet the decode budget. DEPLOY.md
step 9b said so in as many words — _"Nothing encodes it for you: Curator's ingest pipeline never sees
this file"_.

That is backwards on the axis that matters. Every other visualizer is encoded on ingest precisely
because a clip outside the budget stutters on a Pi that decodes H.264 in software
([ADR 0040](0040-visualizers-carry-a-decode-budget.md)), and Curator's preview cannot show you the
defect — it runs on a workstation with a hardware decoder
([ADR 0046](0046-layer-roles-swap-on-screen-and-the-pi-reports-its-own-decode.md)). The default clip
is the one that plays **most often**: on the first real deployment it stood in for 441 of 477
records. So the file with the widest blast radius was the only one with no encode step, no
validation, and no preview.

It also had no surface. Nothing in Curator could say whether a default clip existed, whether the Pi
had it, or what it was — while `GET /api/library` reported all 441 records as `fileMissing` for want
of it.

## Decision

**Curator owns choosing the default visualizer, and it goes through the same ingest as any other.**

A section on the Settings screen: choose a file, see it play, see whether Backdrop has it, replace or
remove it. Behind it:

1. **The same ingest.** `ingestVideo` with a reserved fileId — probe, validate, normalize to
   `DECODE_BUDGET`, render a thumbnail. There is no "is it H.264?" field to get wrong because
   nothing asks you.
2. **The same transfer.** Routed through `MediaTransfer`, so it obeys `media_transfer` exactly as an
   album's visualizer does: `push` streams it, `local` copies it, `none` moves nothing **and the
   panel says to copy it yourself** rather than offering a button that cannot work.
3. **The same honesty about the other end.** `onBackdrop` is `present`/`absent`/`unknown`, never a
   boolean ([ADR 0072](0072-backdrop-presence-is-checked-not-assumed.md)). It is inferred from any
   `usesDefault` entry's `fileMissing` — which _is_ Backdrop's judgement of its own default clip, so
   one entry answers for all of them. A library where no record uses the default is `unknown`, not
   `absent`: nothing on the Pi is in a position to report.

**Settings, not a record page.** The clip belongs to the collection — it is what plays _instead of_ a
record's own — so hanging it off any one record would misstate ownership. Its description lives in
`settings.json` and its bytes at `visualizers/default.mp4` under the reserved fileId `default`, which
no album can claim because a curatorId is `^[a-z0-9]{8}$` and this is seven characters. Sharing the
visualizers directory is what lets `ingestVideo` work unaltered and makes Curator's layout match the
Pi's, where Backdrop's `media_dir` _is_ that directory.

**Choosing a default is not progress on any record.** Nothing here touches what a record owes: the
collection still reads `NEEDS VISUALIZER` for all 441, and `videoPresence` still reports a
`usesDefault` entry as `absent`. A stand-in is a stand-in.

## Consequences

**Good.** The clip that plays most often is now the one hardest to get wrong. The "441 records show
nothing" state is visible, explained, and fixable from the screen you are already on. A single-machine
install works, which a raw `putMedia` would not have.

**Bad.** One more thing on the Settings screen, and a second place (besides a record) where a video
can be uploaded — so the ingest pipeline now has two entry points to keep honest. Both go through
`ingestVideo`, which is the mitigation, but a future change to ingest has two callers to think about.

**Watch for.** Deleting the default in Curator does **not** delete the Pi's copy: Curator has no route
that deletes remote media, and inventing one to un-choose a clip is the wrong place to gain that
power. The response says `stillOnBackdrop` so the UI can tell you, but the Pi goes on playing it
until something replaces it. If that becomes a real annoyance, the fix is a deliberate
remote-media-delete route with its own ADR, not a quiet widening of this one.
