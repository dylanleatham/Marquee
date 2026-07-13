# ADR 0004 — Roadie's queue + control endpoints live under `/api/agent/*`

Status: accepted · Date: 2026-07-13 · Supersedes: curator-spec §8 (`/api/queue`, `/api/queue/counts`)

## Context

The two specs disagree on where the queue endpoint lives:

- **curator-spec §8** documents the queue under a top-level `/api/queue` and `/api/queue/counts`,
  while placing the Roadie _controls_ (`status`, `retry`, `pause`, `resume`) under `/api/agent/*`.
- **roadie-spec §10** documents the queue under `/api/agent/queue`, alongside those same controls.

The queue is a projection of Roadie's state — the same worker that owns `status`/`retry`/`pause`/
`resume`. Splitting it into a separate top-level namespace from its own controls is the odd choice.
Step 5 (PR #7, merged) shipped `GET /api/agent/queue`, and step 6 added `GET /api/agent/queue/counts`
next to it. The spec-adherence review flagged the divergence from curator-spec §8.

## Decision

Standardize **all** Roadie-owned read/control endpoints under `/api/agent/*`:

```
GET  /api/agent/queue          grouped queue (was curator-spec /api/queue)
GET  /api/agent/queue/counts   per-bucket counts + needs-you total (was /api/queue/counts)
GET  /api/agent/status
POST /api/agent/retry/:curatorId
POST /api/agent/pause · /resume
```

Chosen over the alternative (rename back to `/api/queue*`) because `/api/agent/queue` already
shipped and the grouping keeps every Roadie surface in one cohesive namespace. If a top-level
`/api/queue` alias is ever wanted (e.g. for an external consumer), it can be added as a thin alias
without moving anything.

## Consequences

- curator-spec §8's `/api/queue` and `/api/queue/counts` rows are updated to `/api/agent/queue`
  and `/api/agent/queue/counts`, with a dated note pointing here. roadie-spec §10 already matches.
- The Curator UI (step 6) consumes `/api/agent/*` throughout.
- No behavior change — the response shapes are exactly as both specs described; only the paths
  are reconciled.
