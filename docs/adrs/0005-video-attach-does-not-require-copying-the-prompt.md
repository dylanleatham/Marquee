# ADR 0005 — Attaching a video doesn't require copying the prompt first

Status: accepted · Date: 2026-07-14 · Supersedes: album-onboarding-workflow §"Awaiting review" step 5, curator-spec §10 ("Mark as copied") · Closes: [#11](https://github.com/dylanleatham/Marquee/issues/11)

## Context

The onboarding workflow modelled exactly one route to a visualizer: review the palette → copy the
video prompt → paste it into an AI video tool → come back with the result. Copying the prompt was
therefore treated as the signal that review was finished, and it was the **only** transition out of
`awaiting_review`:

```
awaiting_review --(mark prompt copied)--> awaiting_video --(attach)--> awaiting_preview
```

The code implemented that faithfully — `VIDEO_ATTACHABLE = ["awaiting_video", "awaiting_preview"]`,
so attaching from `awaiting_review` returned a 409, and the UI kept its drop zone disabled with
"Copy the video prompt above first."

The model omits an obvious case: **you already have the video.** Maybe it predates the album being
added, maybe you made it by hand, maybe you generated it from a prompt you never asked Curator for.
The workflow then forces you to announce that you copied a prompt you didn't use, purely to unlock
the upload — a lie the state machine demanded (#11).

Separately, the UI carried two buttons where one would do: "Copy prompt" (clipboard) and a distinct
"Mark copied →" (the transition). Copying and then confirming you copied is ceremony.

The spec already anticipated this state disappearing, but only for a different reason —
album-onboarding-workflow §"Later" says that when a video-service API arrives, Roadie gains a
`generating_video` sub-state and "the `awaiting_video` human state disappears."

## Decision

**A video can be attached from `awaiting_review` onward, and copying the prompt is itself the
signal — there is no separate "mark copied" step.**

1. `VIDEO_ATTACHABLE` becomes `["awaiting_review", "awaiting_video", "awaiting_preview"]`.
   Attaching from `awaiting_review` or `awaiting_video` advances to `awaiting_preview`; attaching at
   `awaiting_preview` replaces the file and holds state. `awaiting_review → awaiting_preview` is now
   a legal human transition.
2. The "Mark copied →" button is gone. "Copy prompt" writes the clipboard **and** records the copy;
   the server keeps deciding what that means (video prompt at review → `awaiting_video`; card art →
   bookkeeping). `POST /prompts/:type/copied` is unchanged — only its caller is.

**`awaiting_video` is kept.** It was tempting to delete it along with the gate, and #11 proposed
exactly that. But the state isn't ceremony: album-onboarding-workflow §"Awaiting video" leans on it
for the multi-album flow — _"if you have 5 albums awaiting video, you're probably driving 2–3 in
parallel through your video tool"_ — and the queue bucket is how you see which ones you're waiting
on. Delete it and those albums fall back into `awaiting_review`, indistinguishable from albums you
haven't looked at. The gate was the problem; the bucket earns its place.

So `awaiting_video` stops being a mandatory checkpoint and becomes what it always described: "I've
kicked off a video and I'm waiting on it." You enter it by copying a prompt, and you skip it
entirely when you already have the file.

## Consequences

- **Two routes through the middle of the workflow**, which is the point:
  - _Prompt route_ — copy prompt (→ `awaiting_video`), generate, attach (→ `awaiting_preview`).
  - _Have-it-already route_ — attach from `awaiting_review` (→ `awaiting_preview`), skipping
    `awaiting_video`.
- **The 409 guard still exists**, but now bites where it should: an album still in Roadie's pipeline
  has no palette or prompts, so a video is premature. The regression test moved to that case.
- **Specs updated in this PR**: album-onboarding-workflow ("Awaiting review" step 5, the interrupted
  -session case, and the "Awaiting video" section) and curator-spec §8/§10.
- **`copiedAt` stays.** It still records when a prompt was taken, which is what drives the
  `awaiting_video` transition. Only the extra click is gone.
- This makes the future in §"Later" cheaper rather than harder: when a video API lands and
  `awaiting_video` becomes Roadie-owned, the human `awaiting_review → awaiting_preview` edge already
  exists.
