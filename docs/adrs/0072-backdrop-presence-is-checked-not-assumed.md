# ADR 0072 — Backdrop presence is checked, not assumed, and "can't tell" is a third answer

Status: accepted · Date: 2026-08-11 · Amends:
[curator-ui-ux.md](../specs/curator-ui-ux.md) (§5 the record page — the visualizer panel's Backdrop
strip), [curator-spec.md](../specs/curator-spec.md) (§ the album routes) ·
Relates: [ADR 0038](0038-curator-pushes-media-over-http.md) (the transfer whose arrival this stops
assuming), [ADR 0052](0052-curator-is-three-places-not-a-nine-state-queue.md) (the record page this
strip lives on) · Closes [#296](https://github.com/dylanleatham/Marquee/issues/296)

## Context

The record page said **"on Backdrop"** for ZABA (Glass Animals) while Backdrop's library had no entry
for it at all. The System page, on the same collection at the same moment, listed it under NOT IN
BACKDROP'S LIBRARY. Backdrop was reachable and answering throughout. It was the only one of 36
records with a visualizer that was missing, and it would have played a black screen in the room.

The record page was guessing. `BackdropStrip` rendered from transfer-job state alone:

```ts
if (!hasVisualizer) return null;
if (job?.status === "running") …   // uploading
if (job?.status === "failed")  …   // failed + retry
return … "on Backdrop"             // ← the fallback
```

The green dot was the `else`. It meant "no transfer is currently in trouble" and was read as "the
file is there" — which is true of every clip that was never pushed, every clip whose job history a
Curator restart dropped, and every failure that left no failed job.

**The strip was itself the fix for the previous version of this bug**, which is the part worth
recording. Its own doc comment says so:

> a visualizer that is attached in Curator but never reached Backdrop plays as a black screen in the
> room, and the old panel said nothing at all once the transfer stopped — success and failure looked
> identical, which is the case ADR 0038 exists to prevent.

That fix covered the in-flight and failed cases and left the resting case inferred. The result was
strictly worse than the silence it replaced: silence invites you to go and check, a green dot tells
you not to bother.

Meanwhile the System page asked Backdrop directly. So **two screens derived one fact two different
ways** — and that, not the wrong label, is the defect. `VisualizerPanel.test.tsx` and
`system.test.ts` were both green. Neither could fail for the other's mistake, because nothing forced
them to answer from the same thing. `VisualizerPanel.test.tsx` even asserted the resting case, as
"renders on Backdrop" — it encoded the bug.

## Decision

### 1. One derivation, server-side, with three answers

`videoPresence(entries, curatorId)` in `runtime/system-status.ts` is the only place this is decided:

```ts
export type VideoPresence = "present" | "absent" | "unknown";
```

- no library at all (unreachable, unconfigured) → `unknown`
- no entry for the key → `absent`
- entry, `fileMissing` absent (a Backdrop too old to report it) → `unknown`
- entry, `fileMissing` true / false → `absent` / `present`

**"Can't tell" is not "fine".** The `fileMissing` flag already established that a library entry is
not the same as a playable file; this adds that _no answer_ is not a yes. The server already
half-knew it — the old code carried a comment saying absent `fileMissing` should read as "can't
tell" — but it had only a boolean to say it in, so the distinction died at the type. Anything that
renders a confirmation needs the third value or it will eventually draw one on no evidence.

### 2. Both screens read that one field

`AlbumPresence` carries `videoPresence`, and `presenceProblem` is rewritten in terms of it.
`videoOnBackdrop` remains, derived as `presence === "present"`, so the exceptions list is unchanged
in behaviour — every case maps to the message it produced before.

**The System page is right to treat `unknown` as a problem** and the record page is right not to.
They are different instruments: an exceptions list surfaces anything unconfirmed, so `unknown` keeps
the negative wording it already had rather than gaining a fourth row type; a status claim on the
record page must not assert what it has not been told. The shared field is what keeps that a
deliberate difference in _presentation_ rather than an accidental difference in _fact_.

### 3. The record page asks, on its own route

`GET /api/albums/:curatorId/presence` → `{ curatorId, hasVideo, video }`.

Its own route rather than a field on `GET /api/albums/:curatorId`: the record page polls the asset
every few seconds, and that route is otherwise pure local disk. Folding a cross-host call into it
would put a Backdrop round-trip behind every poll. The probe is the shared bounded `getJson`
(`PROBE_TIMEOUT_MS`, never throws), so an unplugged Pi answers `unknown` rather than hanging the
page.

`useBackdropPresence` slow-polls it at 15s through `usePoll`, which already pauses on a hidden tab
and drops a tick that arrives mid-flight. A failed request is `unknown`, never `present`.

### 4. The job owns the moving states; Backdrop owns the resting one

Checked in that order. While a transfer is running or has failed, the job is the truer story and a
presence poll from fifteen seconds ago must not overwrite live progress. Once nothing is moving,
what Backdrop says is the whole answer.

The resting state gains a **SEND IT** action on `absent`. The push existed only behind a failed job,
so a clip that was never sent had no route out of the UI at all — fixing ZABA took a `curl` against
`/api/albums/:curatorId/push`.

## Consequences

- A record whose clip never reached Backdrop now says so on its own page, with the button that fixes
  it. This is the whole point.
- **The gate is a cross-screen test**, not another per-component one: the panel confirms _exactly_
  when `presenceProblem` has no complaint, asserted over every shape `videoPresence` can take. A
  future change that makes either side answer from something else fails it. Two green suites that
  could not contradict each other is what let this through, so the durable fix has to span them.
- The record page makes one bounded cross-host request per 15s while open, where it previously made
  none. Accepted: it is the cost of not guessing, and it is the same probe the System page already
  makes four of.
- `unknown` is now reachable in the UI and says "Backdrop isn't answering". On a healthy setup it
  should never appear; if it does, it is true.
- An older Backdrop that never reports `fileMissing` will read `unknown` forever on the record page
  rather than a confident green. That is correct, and it is the honest cost of the third answer.

## What this does not change

The transfer itself, the push route, the System page's exceptions and their wording, the
library-entry-versus-file distinction `fileMissing` already carries, or what the room does. Only
whether Curator will claim something it has not checked.
