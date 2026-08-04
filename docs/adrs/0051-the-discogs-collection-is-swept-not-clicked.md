# ADR 0051 — The Discogs collection is swept, not clicked

Status: accepted · Date: 2026-08-03 · Extends:
[ADR 0017](0017-discogs-personal-token-and-direct-images.md) (Discogs as an album source: personal
token, release-id identity, direct images) · Builds on:
[ADR 0018](0018-generation-runs-as-background-jobs.md) (long work is a job),
[ADR 0029](0029-batch-work-runs-as-a-library-job.md) (library-scoped sweeps) · Relies on:
[ADR 0027](0027-generation-is-invoked-not-pipelined.md) (generation is invoked, never pipelined) ·
Amends: curator-spec.md (§8 add routes, Discogs table), album-onboarding-workflow.md (source list) ·
Implements: issue #234

## Context

[ADR 0017](0017-discogs-personal-token-and-direct-images.md) made the Discogs collection an album
source, and the Add screen browses it a page at a time with a **Send to Roadie** button per row.
That is the right shape for adding one record. It is the wrong shape for the actual starting
condition: a collection that already exists, in full, on Discogs. Onboarding a real collection means
several hundred button presses across dozens of pages, and there is no way to answer "did I add the
four records I bought last month?" other than reading the list and remembering.

Three things were missing and are really one thing — the collection as a whole was never a unit of
work:

1. No way to add everything at once.
2. No way to re-check for what's new.
3. No way for that check to happen without being asked.

Two constraints shape the answer.

**Cost.** The user's requirement was explicit: sweeping the collection must not spend LLM credits.
This turns out to already be true and worth writing down —
[ADR 0027](0027-generation-is-invoked-not-pipelined.md) took prompt drafting out of Roadie's
pipeline, so `fresh → fetching_metadata → downloading_art → generating_palette → awaiting_review`
reaches review with zero Gemini calls. Card art and video were already opt-in under
[ADR 0012](0012-artifact-generation-is-opt-in.md). A sweep of a thousand records costs nothing but
Discogs requests and local CPU. **This ADR depends on that property**, which makes it a property to
keep rather than an accident to rediscover.

**Rate limits.** Discogs allows 60 authenticated requests per minute. A sweep of 500 records is
5 collection pages, but the albums it queues then cost Roadie one release fetch each, against the
same budget. Unthrottled, that is an immediate 429 storm, and Roadie classes 429 as transient — so
albums would burn their four retries and park in `errored`. The feature would appear to work and
then quietly ruin the library.

## Decision

**One sweep, run three ways.** `discogsSyncRunner` pages through the whole collection and adds every
release the library doesn't already have. It is the initial import, the refresh, and the poll tick —
the same code path, with no separate "first run" mode and no stored cursor.

What makes that possible is that **dedupe is on the Discogs release id**, which
[ADR 0017](0017-discogs-personal-token-and-direct-images.md) already established as the stable identity.
So the sweep is idempotent by construction: running it again adds only what's new. A cursor — "last
synced at T" — would be a second source of truth to keep in step with reality, and would be wrong
after any interrupted run. The collection itself is the state.

Four consequences of that choice, each of which removes a thing that would otherwise need designing:

- **A truncated sweep needs no resume logic.** Cancelled, page-capped, or cut off by a failing page:
  what was added is added and queued, and the next run continues. The report says it stopped and why.
- **The refresh button is the sync button.** There is one control, not two. Two would imply a
  difference that doesn't exist.
- **The poller has no privileged path.** It calls exactly what the button's route calls.
- **A duplicate press is free.** The [ADR 0018](0018-generation-runs-as-background-jobs.md) manager
  dedupes library-scoped jobs by kind, so a second press — or a poll tick landing mid-sweep —
  reattaches instead of walking the collection twice.

**It runs as a library-scoped job**, per [ADR 0029](0029-batch-work-runs-as-a-library-job.md).
`POST /api/discogs/sync` returns **202 + a job**; the UI polls it. A first sync is minutes of paging
and hands hours of work to Roadie, which no HTTP request may hold open.

**Polling is a plain interval, and it runs the full sweep.** Discogs has no webhook, so polling is
the only mechanism available. The tick could be cheaper — sort the collection by date added and read
only the first page — but it runs the whole sweep anyway, because ceil(n/100) requests per hour is
nothing against a 3,600/hour budget, and paying it buys one code path instead of two and a tick that
is **self-healing**: a sweep that was truncated or partly failed is simply completed by the next one.
Opt-in, default off, floor of 5 minutes. It does **not** sweep on boot — a restart would otherwise
spend a full walk, and the first tick is at most one interval away.

**The rate budget is enforced in the client, once.** `DiscogsClient` spaces API requests by a minimum
interval (default 1.1s ≈ 54/min), queuing them. Not in the sweep: the sweep is not the only caller,
and Roadie's per-release fetches draw on the same budget. Bounding the shared helper is what makes
every caller inherit it — including the ones that don't exist yet. Cover downloads are deliberately
exempt: the image host is not part of the API budget, and queuing them behind it would add an hour
to a large sync for nothing.

**Bulk dedupe gets an index.** `store.findByDiscogsUri` reads every asset file per call — fine for
one add, quadratic for a sweep (500 releases × 500 files to add 500 albums). `addDiscogsAlbum` takes
an optional pre-built `DiscogsIndex`; the sweep builds one and passes it. Absent one, behaviour is
exactly as before.

## Consequences

- Onboarding a collection is one button press. Keeping it current is either one press or nothing.
- **The no-LLM-in-the-pipeline property is now load-bearing.** Putting a Gemini call back into a
  Roadie step would silently make every sync cost money per record.
  `discogs-sync.test.ts` asserts no Gemini client is ever touched by a sweep, so the regression is
  caught rather than billed.
- Every Discogs API call is now serialized behind a shared gate. A large sweep takes longer in
  wall-clock than an unthrottled one would — that is the point; the unthrottled version does not
  finish correctly. Tests pass `minIntervalMs: 0`.
- The sweep reports per item and its rows are capped by nothing but the collection size. A first sync
  of a large collection produces a large report, held in the job result and persisted with it — the
  same tradeoff [ADR 0029](0029-batch-work-runs-as-a-library-job.md) accepted for palette
  sweeps.
- Auto-sync applies immediately (it is only a timer). Credentials still need a restart; the routes
  now report `restartRequired` accordingly instead of always claiming it.
- Two library sweeps can be on screen at once, so the progress panel's corner became a stack and the
  panel's chrome moved into a shared `JobProgress`.
- Polling costs more requests than a date-sorted probe would. If a collection ever gets large enough
  for that to matter, the early-exit is the optimization — deliberately not taken now.
