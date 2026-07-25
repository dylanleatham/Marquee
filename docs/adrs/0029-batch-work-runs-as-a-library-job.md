# ADR 0029 — Batch work is a library-scoped job, not an SSE stream

Status: accepted · Date: 2026-07-25 · Supersedes: curator-spec §Palettes' "Streams progress via SSE"
and §10 "Batch progress" (SSE-backed slide-over) · Extends:
[ADR 0018](0018-generation-runs-as-background-jobs.md)

## Context

curator-spec has specified `POST /api/batch/regenerate-palettes` as _"regenerate all non-hand-edited
palettes; **streams progress via SSE**"_ since the original draft, with a matching §10 slide-over
panel. Neither was built ([issue #104](https://github.com/dylanleatham/Marquee/issues/104)).

That text predates [ADR 0018](0018-generation-runs-as-background-jobs.md). Card-art and video
generation faced exactly the same problem — long-running work whose progress the UI needs, that must
survive a reload and be cancellable — and it was solved with a **background job manager**: the route
returns `202 { id, status, progress }`, the UI polls `GET /api/jobs/:id`, `POST /api/jobs/:id/cancel`
aborts the runner, and a `JobStore` persists jobs across a Curator restart (issue #57).

Building the batch path on SSE would mean two progress mechanisms, two cancel stories, and two
reattach-after-reload stories, for one product concept: _something long is running, show me how far it
got, let me stop it._

SSE's genuine advantage is push latency. That does not matter here: a palette regeneration is seconds
of local image decode per album, and the existing 1s poll is well inside the granularity a human reads
a progress bar at. SSE's genuine costs do apply — a held-open connection that a reload drops and a
proxy may buffer, plus a second server-side lifecycle to reason about. The job manager's weakness
(polling latency) is irrelevant here and its strengths (restart persistence, idempotent restart,
uniform cancel) are exactly what a library-wide sweep needs.

## Decision

**Batch palette regeneration is a job kind on the ADR 0018 manager. There is no SSE endpoint.**

1. `JobKind` gains `paletteBatch`. `POST /api/batch/regenerate-palettes` returns `202 { job }` and the
   UI polls the same `GET /api/jobs/:id` it already polls for video and card art. Cancel is the
   existing `POST /api/jobs/:id/cancel`.
2. **A job's `curatorId` becomes optional.** Every job so far belonged to one album; a library sweep
   belongs to none. Rather than encode "the whole library" as a sentinel id, the field is absent, and
   a job with no `curatorId` is **library-scoped**. `GET /api/jobs?kind=paletteBatch` lists them, which
   is how the UI reattaches to a running sweep after a reload.
3. **The dedup key already does the right thing.** `start()` returns the running job when one matches
   album+kind+index; with `curatorId` absent, that means at most one library sweep of a kind runs at a
   time. Pressing the button twice reattaches rather than starting a second pass over the collection.
4. **The §10 slide-over is kept as a UI shape** — a panel with progress and a cancel button — and is
   simply fed by polling instead of an event stream. It is mounted app-wide, not inside the screen
   that started it, so navigating away does not lose the run.
5. **Batch add stays synchronous.** `POST /api/albums/batch` does no network I/O — adds dedup on the
   Spotify URI and hand off to Roadie, which fetches off the request path — so it answers in
   milliseconds with a complete per-item report. A job would add ceremony and remove the thing that
   makes it useful, which is the report.

## Consequences

- **One progress mechanism.** The batch panel, the video job and the card-art job all poll
  `/api/jobs/:id` and cancel the same way. A future batch kind (draft-prompts-for-all,
  [issue #96](https://github.com/dylanleatham/Marquee/issues/96)) is a new `JobKind` and a runner, not
  a new transport.
- **A sweep survives a reload and a restart.** The reload case reattaches by polling; the restart case
  inherits ADR 0018's honest behaviour — a job that was running when the process died is restored as
  `failed: interrupted by a Curator restart`, because its runner is gone. Palettes it had already
  written stay written; they are saved per album as the sweep goes, not at the end.
- **Cancel drops the report, not the work.** The manager discards the result of a cancelled job. For a
  sweep that is right: the palettes regenerated before the cancel are on disk regardless, and the
  job's `progress` still says how far it got. The alternative — special-casing partial results into
  the manager — buys a summary line at the cost of the manager's one clear rule.
- **`forAlbum(curatorId)` never returns library jobs**, since `undefined !== curatorId`. The album
  detail page is unaffected by a running sweep, which is correct: the sweep is not that album's job.
- **The sweep is sequential and unbounded in duration by design.** Palette extraction is CPU-bound
  local work; running the collection in parallel would starve the event loop of an always-on service
  for no wall-clock win worth having. Cancellation, not a timeout, is the bound — the runner checks
  the abort signal between albums.
- **Trade-off accepted:** progress moves in poll-sized steps rather than instantly. For a bar that
  ticks once per album over a run measured in minutes, that is invisible.
- curator-spec §Palettes and §10 are updated in the same change, per the working agreement. The SSE
  wording is struck rather than deleted, so the history reads.
