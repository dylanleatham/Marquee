# Review-agents — known issues / follow-ups

The free-plan repo has no enforced issue tracker, so open follow-ups on the review harness
live here: version-controlled, grep-able, and reviewed in PRs. Per `dev-harness.md §12`,
each item should end as a **regression test** (in `review-agents/lib/lib.test.mjs`) or a
**reviewer prompt/config change** — not a lingering note. Delete an item when it's fixed.

To promote any of these to a GitHub issue, the text below is paste-ready.

---

## RA-2 — `consistency` specialist hits the 90s spawn timeout under load

- **Symptom:** `consistency: unavailable (spawnSync … ETIMEDOUT)`; specialist is skipped
  (non-blocking).
- **Seen:** 2026-07-10, when 5 specialists ran in parallel on `feat/conductor-bridge`.
- **Suspected cause:** contention — several full Claude Code sessions running at once push
  one past the 90s `TIMEOUT_MS` in `review-agents/lib/claude.mjs`.
- **Options (pick when it recurs):** make `TIMEOUT_MS` configurable via env; run specialists
  in limited-concurrency batches (e.g. 3 at a time) instead of all at once; or retry once on
  a timeout before marking unavailable.
