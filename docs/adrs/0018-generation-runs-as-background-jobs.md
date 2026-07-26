# ADR 0018 — Card-art / video generation runs as a background job, not in the HTTP request

Status: accepted · Date: 2026-07-21 · Amends: curator-spec.md (§HTTP API — `video/generate`,
`card-art/generate`), [ADR 0011](0011-auto-generate-visualizer-clips.md) (the async-job model it
flagged as future work) · Relates: [ADR 0010](0010-auto-card-art-generation-candidate-set.md) ·
Implements: issue #30

## Context

The AI generation actions — `generateCardArtSet` (ADR 0010) and `generateVideoSet` (ADR 0011) — ran
**synchronously inside the HTTP request**. The route awaited the whole set (N artifacts generated in
parallel) and only then replied with `{ videoClips }` / `{ cardArtCandidates }`. For card art that's
seconds; for **video it's minutes** — a long-running Veo/"Omni" operation polled per clip, several in
parallel.

ADR 0011 accepted the held request for a single-user LAN app but explicitly flagged the background-job
model ("poll a job id") as the obvious improvement. Issue #30 is that improvement. The held request is
fragile in exactly the ways a minutes-long HTTP call always is:

- browser/proxy idle timeouts kill it mid-generation;
- no progress feedback (the user stares at a spinner with no idea if it's 1/5 or 5/5);
- no way to cancel;
- a page reload **loses the result** — the work may still be running server-side, but the client
  that would receive it is gone.

Roadie is untouched by this: generation is a human-triggered action deliberately _outside_ Roadie's
queue (roadie-spec §15). This is purely about the request/response shape of two routes.

## Decision

**The generate routes start a background job and return immediately; the UI polls the job.**

1. **A tiny in-memory job manager** (`src/jobs/manager.ts`, `GenerationJobs`). A job carries
   `{ id, kind: "video"|"cardArt", curatorId, status: running|done|failed, progress: {done,total},
result?, error? }`. In-memory is deliberate (issue #30: "in-memory is fine to start") — generation
   is a convenience, not durable pipeline state, so a job lost on restart just means clicking generate
   again. Terminal jobs are GC'd after a TTL so the map can't grow without bound.
2. **`POST …/video/generate` and `…/card-art/generate`** now:
   - run the **cheap preconditions synchronously first** (`assertGenerable`: Gemini configured,
     generation enabled per ADR 0012, prompt drafted, cover art present) so a misconfigured request
     still gets an **immediate 4xx** — the validation contract is preserved, not pushed into the job;
   - then **enqueue and return `202 { … job }`** with the `jobId`.
3. **`GET /api/jobs/:id`** returns the job's status/progress/result/error for the UI to poll.
4. **`GET /api/albums/:curatorId/jobs`** lists an album's active + recent jobs, so the detail page can
   **re-attach to a running job after a reload** — directly fixing the "a reload loses the result"
   failure mode.
5. **The generate actions are unchanged in contract** — same partial-success / all-fail semantics
   (ADR 0010/0011), same save path. They gained only an optional `onProgress(done, total)` the job
   manager threads through, fired as each variant settles.
6. **Duplicate-run guard**: starting a job while one is already running for the same album+kind
   returns the existing job rather than launching a second minutes-long run (clicking twice, or a
   reload, is a no-op).

The whole-batch failure that used to surface as a **5xx** now surfaces as a **failed job** (polled),
since the request has already returned 202 by the time generation runs. Per-request validation still
maps to 4xx via the synchronous precheck.

## Consequences

- The UI drives generation through a `useGenerationJob` hook: click → POST → poll `GET /api/jobs/:id`
  every ~1.5s, showing live progress ("Generating 3/5…"); on completion it refreshes the album so the
  new clips/candidates appear immediately. On mount it checks `…/jobs` and re-attaches to any running
  job, so a reload no longer loses an in-flight generation.
- Tests: the route tests now assert `202 + poll-to-done/failed + progress`; the action-level tests
  (`video-gen`, `card-art-gen`) are unchanged since the action signatures are compatible. The job
  manager has its own unit tests (dedupe, progress, failure, GC, re-attach listing).
- ~~**Not done here** (kept small, per the issue): job **cancel** (nice-to-have follow-up) and
  **persistence across restarts** (in-memory is intentional for now).~~

  **Update (2026-07-22, issue #57) — both landed:**
  - **Cancel** — each running job carries an `AbortController`; `POST /api/jobs/:id/cancel` aborts
    it and marks the job `cancelled` (a fourth terminal status). The signal is threaded through the
    generate actions into the Gemini client's `fetch`, so an in-flight upstream call is actually
    aborted (surfacing as a distinct `499`) rather than running to completion; a runner that
    resolves after the abort has its result discarded. Cancel is idempotent (terminal/unknown → no-op
    / `404`). The UI shows a **Cancel** button next to the generate button while running.
  - **Persistence** — an optional on-disk `JobStore` (`FileJobStore`, `{dataDir}/generation-jobs.json`)
    persists the job list across a restart so the UI can still see recent jobs. A job left `running`
    when the process died can't be resumed (its runner is gone), so it's restored as a **failed**
    "interrupted by a Curator restart" job rather than a zombie. Best-effort: a corrupt/unreadable log
    loads as empty and never blocks generation.
