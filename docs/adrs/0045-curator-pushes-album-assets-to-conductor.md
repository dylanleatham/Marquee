# ADR 0045 — Curator pushes album assets to Conductor over HTTP

Status: accepted · Date: 2026-08-01 · Extends:
[ADR 0038](0038-curator-pushes-media-over-http.md) (the same argument, for video files),
[ADR 0019](0019-conductor-scan-reads-asset-store.md) (Conductor reads the synced store at scan time)
· Amends: curator-spec §Runtime push, hue-conductor-spec §8, amp-spec §Album assets,
runtime-overview §8, runbook A4.3

## Context

Conductor resolves a scan by reading `{albumAssetsDir}/{curatorId}.json` — its synced copy of
Curator's album-assets store ([ADR 0019](0019-conductor-scan-reads-asset-store.md)). Amp reads the
same directory for the Spotify URI. Neither has ever had a way to be _given_ that file. The runbook
(A4.3) tells the operator to `rsync` it.

[ADR 0038](0038-curator-pushes-media-over-http.md) made exactly this argument about **video files**
and moved them onto an authed HTTP channel. The asset store was left behind, and it failed the same
way, faster:

- On this hardware the runtime sat **six albums behind** a thirteen-album workstation for four days.
  The last rsync was 2026-07-28; nobody ran another.
- Every scan in that window logged `202 ignored: album not synced`. **No scan has ever driven the
  lights.** The one album that reached Backdrop's library played video against a dark room.
- Amp's `config.toml` had no `album_assets_dir` at all, so it defaulted to a directory nothing has
  ever written. Card scans could not have resolved an album.

The failure is silent from Curator's side, which is what makes it expensive. Curator reports each
album healthy because, from where it sits, each album _is_ healthy: art, palette, pattern, video and
tag payload are all present locally. Nothing in the product models "and the runtime has been told".

Worse, [runtime-overview §8](../specs/runtime-overview.md) claimed the opposite — _"Curator handles
this as an automatic post-save action so it feels the same as the Backdrop HTTP push"_ — describing a
feature that was never built, while the runbook said to do it by hand. Two copies of one fact,
disagreeing, and the reader with the wrong one had no reason to go looking.

## Decision

**Curator pushes the album-assets store to Conductor over the authed HTTP channel it already uses,
and Amp reads the directory Conductor writes.**

### Conductor gains an ingest API

- `PUT /api/album-assets/:curatorId` — the full asset JSON, written to `{albumAssetsDir}/{id}.json`.
  A `PUT` because it is idempotent: the same id always names the same destination.
- `GET /api/album-assets` — the ids currently held, so Curator can report drift.

Four properties are load-bearing:

- **`curatorId` is validated against `^[a-z0-9]{8}$`** — the same guard `FsAlbumAssetReader` already
  applies, for the same reason: it becomes a filename.
- **Write to a per-request-unique temp file, then rename.** A scan reading mid-write must see the old
  asset or the new one, never a partial that `JSON.parse` rejects — which the reader would degrade
  to "album not synced", i.e. exactly the bug being fixed, intermittently. The temp name carries a
  UUID rather than a fixed `.tmp`: unlike Backdrop's `Library`, there is no in-memory chokepoint
  serialising writes, so two pushes of one album would otherwise share a path.
- **Write failures map explicitly to 500.** Conductor's `setErrorHandler` defaults to `502` and
  echoes `err.message`; a local `EACCES` reaching Curator dressed as a bad gateway would be recorded
  as a network problem and send the operator to the wrong place.
- **Validation is deliberately shallow** — identity fields, `version`, `metadata`, `roadie`. Conductor
  reads a documented slice (`AlbumPaletteInput`) and Amp reads a different one; rejecting on fields
  neither reads would block albums for no reason. An album whose palette hasn't landed yet is
  _accepted_, because `/api/scan` already degrades that to `202 ignored: album not ready`.

### Curator gains a Conductor sync, shaped like the Backdrop one

`ConductorClient` + `ConductorSync` mirror `backdrop/{client,sync}.ts`, including the rule that
matters most: **sync is a side effect, never a state change.** A failure is recorded as the album's
`syncIssue` and never raised into the human action that triggered it.

The whole asset is pushed, not a projection. Conductor and Amp read different slices, so narrowing
would mean choosing for both — and an identical file on both ends is what makes "is the runtime up to
date" answerable by comparing ids.

### The push is additive; it never deletes

An album deleted in Curator leaves its file on the runtime. Deleting runtime data in response to a
transient Curator state is the worse failure. `POST /api/runtime/verify` reports the leftovers as
`extra` instead, so divergence is visible without being acted on automatically.

### Amp reads Conductor's directory

Rather than a second ingest endpoint on Amp, its `album_assets_dir` points at the same path. They are
siblings on one Pi by committed topology (runtime-overview §7), and amp-spec already described this
directory as "the same rsync target Conductor reads".

### Pushing is opt-in via an explicitly configured URL

`config.conductor.url` always has a value — it defaults to `localhost:4737` so the Demo Room proxy has
somewhere to aim. Pushing unconditionally would put an "unreachable" `syncIssue` on every album on any
workstation with no runtime, training the operator to ignore the one field meant to say the runtime is
stale. `push_assets` defaults on only when a URL was set explicitly, and overrides either way.

### `syncIssues` becomes namespaced

Two services now write one `roadie.syncIssues` array, and each replaces its own findings on every
attempt — that is how an issue clears when the next sync succeeds. A wholesale replace would make
them erase each other, so entries are tagged `"Backdrop: …"` / `"Conductor: …"` and each writer
replaces only its own slice. The field stays `string[]`: it is rendered verbatim in the UI, and a
structured shape would mean migrating every asset file on disk for nothing the UI can use.

## Consequences

- **The last manual step is gone.** Pressing verify — or the always-available per-album push, or
  "sync everything" — puts the video on Backdrop _and_ the asset on Conductor. No shell.
- **A full push is a job, not a request.** `POST /api/runtime/sync` returns `202` and a
  `runtimeSync` job. This also fixes an existing latent problem: `POST /api/backdrop/sync` ran
  `resyncAll` inline, so with `media_transfer = "push"` it held one HTTP request open for the entire
  transfer — hours on the measured link — with no progress and no cancel.
- **Verify means something stronger.** It used to _check_ Backdrop and report drift. It now makes the
  runtime true first, so "I put the sleeve on the stand and it worked" is a claim about a system that
  has actually been given the album.
- **Conductor accepts writes for the first time.** It has been read-only over HTTP apart from
  settings. The id pattern, the temp-then-rename and the explicit error mapping are what keep that
  from being a liability; all three are tested directly.
- **Amp's correctness now depends on a shared filesystem path.** Fine while they are siblings on one
  Pi, and it is the topology the specs commit to — but if Amp ever moves to its own host it needs its
  own ingest endpoint. Recorded here so that lands as a known consequence, not a surprise.
- **rsync stays supported.** Nothing stops an operator from using it for a bulk first load. It is no
  longer _required_, and no longer the only thing standing between a prepared album and a dark room.
- **Not solved here**: Conductor still has no cache to invalidate (the reader hits disk per scan), so
  a pushed asset is live immediately. If that ever changes, the push has to invalidate it.
