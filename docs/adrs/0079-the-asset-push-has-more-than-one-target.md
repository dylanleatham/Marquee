# ADR 0079 — The album-assets push has a list of targets, and the co-located Conductor is not the only one

Status: accepted · Date: 2026-08-13 · Amends:
[ADR 0045](0045-curator-pushes-album-assets-to-conductor.md) (one `conductor.url` becomes a list of asset targets),
[ADR 0008](0008-desktop-app-supervises-services.md) (the shell stops setting `CONDUCTOR_URL`),
[runtime-overview.md](../specs/runtime-overview.md) (§8 sync table),
[curator-spec.md](../specs/curator-spec.md) (§Config, §Runtime sync) ·
Fixes [#306](https://github.com/dylanleatham/Marquee/issues/306) ·
Relates: [ADR 0081](0081-an-edit-that-changes-what-the-room-plays-pushes-it.md) (the edits that now
push — which this makes actually arrive), [ADR 0034](0034-amp-sonos-playback-and-card-uri.md) (Amp,
which reads the directory but is nobody's target)

## Context

`POST /api/runtime/sync` answered `{ pushed: 478, failures: [] }` and the runtime Pi received
nothing. Its copy of the album-assets store had last been written four days earlier; every scan in
between resolved against a stale file, and [#304](https://github.com/dylanleatham/Marquee/issues/304)'s demo cuts were only the first symptom anyone
stood in front of.

The push had one target, because `conductor.url` answers two different questions at once:

1. **Which Conductor does Curator talk to** — the Demo Room proxy, a simulated scan, the settings.
2. **Where does the album-assets store have to land** — every host that reads it at scan time.

On a plain deployment those are the same host and the conflation is invisible. The desktop shell
made them different and nothing said so: it sets `CONDUCTOR_URL` to the Conductor it starts beside
Curator, which was right for question 1 (issue #164 — the repo `.env` names the Pi, which on a
one-box install does not resolve, and Preview read "offline") and silently answered question 2 with
the same value. Worse, `loadEnvFile` will not override an already-set variable, so the `.env`'s real
runtime became invisible to Curator entirely.

The result is a push that round-trips: Curator PUTs 478 assets to a Conductor whose
`albumAssetsDir` **is** `~/marquee/album-assets`, the directory Curator itself writes. Every write
succeeds. Nothing leaves the machine. **Amp**, which has no ingest route of its own and can only be
served by whoever shares its disk, gets nothing at all.

## Decision

**`conductor.assetTargets` — a list of every host that reads the store, pushed to in order.** The
two questions get two answers.

### 1. Two variables, because they are two facts

The shell now passes `MARQUEE_COLOCATED_CONDUCTOR_URL` and leaves `CONDUCTOR_URL` alone.
Curator resolves:

- `conductor.url` = co-located ?? configured ?? default — unchanged for the Demo Room, so issue
  #164's fix survives intact.
- `conductor.assetTargets` = the co-located one **and** the configured one, nearest first, deduped.

Nearest first because the local push is instant and feeds the screen you are looking at; a Pi that
is asleep should never cost you the copy you can see. Deduping because one host named twice is one
host, and pushing to it twice would only double the log.

`[conductor] asset_targets = [...]` in `config.toml`, or `CONDUCTOR_ASSET_TARGETS` in the environment,
overrides both — that is someone naming their runtime by hand, and second-guessing it would make the
setting a suggestion.

### 2. A failure names the host, and never stands in for the others

Every target is attempted even after one fails, and each failure is recorded as its own syncIssue
naming the URL. With two runtimes, `Conductor: push failed` without a host sends you to the wrong
machine half the time.

### 3. Counts may not claim reach they do not have

`resyncAll` counts an album as `pushed` only once **every** target holds it, and returns a
per-target breakdown (`{ url, pushed, failed }`). `verify` asks every target and reports per target,
with the union as the headline — an album on one runtime and not the other is not "everywhere it
should be". A host that could not be _asked_ is reported as an `error`, never as `missing`: those
are opposite instructions, and calling an asleep Pi "missing 478 albums" sends someone to re-push a
store that may be perfectly current.

This is the part that actually cost four days. The push being wrong was one bug; the report saying
`pushed: 478, failures: []` about it is what made the bug survive daily use of the button meant to
catch exactly this.

## Consequences

- **The mixed deployment works**: desktop shell for the lights, Pi for video and audio, both fed by
  one Sync everything.
- **Config gained `assetTargets`**, always populated, so no reader needs a `?? [url]` fallback. An
  override that names a Conductor and no targets still means "push there", so every embedder and
  test that builds a config by hand is unchanged.
- **`ConductorSync` takes `clients: ConductorClient[]`.** The singular `client` is gone rather than
  kept as an alias — two ways to say one thing is how the next reader ends up pushing to one host
  and thinking they configured two.
- **Amp is still nobody's target.** It reads the directory Conductor writes and has no ingest route,
  so it is served only by sharing a disk with a Conductor. Making Amp a first-class target
  (`PUT /api/album-assets/:id` on Amp) was considered and deferred: it adds a route, auth and tests
  to a service that works today, and it is not what #306 broke. Recorded so the coupling is a known
  shape rather than a discovery.
- **Not addressed**: pushing to targets concurrently (they are sequential, and a sleeping host costs
  one connect-timeout per album on a full resync), and letting each target carry its own secret —
  the runbook's "one shared secret everywhere" still holds.
