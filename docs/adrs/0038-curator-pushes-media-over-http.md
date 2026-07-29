# ADR 0038 — Curator pushes visualizer media to Backdrop over HTTP

Status: accepted · Date: 2026-07-29 · Extends:
[ADR 0015](0015-backdrop-sync-triggered-at-projection-changes.md) (sync fires at projection changes),
[ADR 0019](0019-conductor-scan-reads-asset-store.md) (the sibling store-sync problem) · Amends:
curator-spec §Backdrop sync, backdrop-spec §5, roadie-spec §6, runbook A4.3

## Context

Backdrop needs two things to play an album: a **library entry** mapping the scan URI to a file path,
and **the file itself**. Curator has only ever owned the first.

The second was deferred to the operator. `runbook` A4.3 says to `rsync` the visualizer directory to
the Pi by hand; `syncMediaLocally` covers the single-workstation case with an in-process
`copyFileSync`. Between those two sits the actual deployment — Curator on a workstation, Backdrop on
a Pi — where nothing moves the file automatically.

That gap is silent. `POST /api/backdrop/sync` reports `{"pushed":5,"failures":[]}` when it has pushed
five _metadata_ entries, regardless of whether any video exists on the other end. Sync succeeds, the
album shows healthy, and the screen stays black. On this hardware the live library held five entries
and one file.

It is also the last manual step in an otherwise in-app workflow: every other part of preparing an
album — art, palette, pattern, video attach, tag payload — happens in Curator.

## Decision

**Curator can put the file on Backdrop's host itself, over the authed HTTP channel it already uses.**

### Backdrop gains a media upload route

`PUT /api/media/:fileId` — same `X-Trigger-Secret` auth as every other `/api/*` route, body streamed
straight to `{mediaDir}/{fileId}.mp4`. It is a `PUT` because it is idempotent: the same `fileId`
always names the same destination, and re-sending replaces it.

Four properties are load-bearing rather than incidental:

- **`fileId` is validated against `^[a-z0-9]{8}$`.** It becomes a filename; anything else is a path
  traversal into a service that then serves files to a browser.
- **The body streams; it is never buffered.** These files are ~240 MB and Backdrop runs on a Pi.
- **Write to a temp file, then rename.** A dropped connection must not leave a truncated mp4 that
  Backdrop will happily hand to the kiosk. Rename within the same directory is atomic.
- **It lands under `mediaDir`.** Backdrop refuses to resolve any `filePath` outside it
  (backdrop-spec §5); an upload that landed elsewhere would be unplayable by its own rule.

### Curator gains a second `MediaTransfer`

`MediaTransfer` already exists as a one-method interface with `localCopyTransfer` as its only
implementation. `httpPushTransfer` is the second. No caller changes: `transferMedia` already runs
whatever transfer it is given, and already skips when given none.

### The mode becomes explicit

`sync_media_locally` was a boolean when there were two states. There are now three — nothing
(out-of-band rsync), local copy, HTTP push — so it becomes `media_transfer = "none" | "local" |
"push"`. The boolean is still honoured for one release and maps to `local`.

### Curator computes a content hash

`buildLibraryEntry` omits `contentHash` today, deliberately: the contract's field means a _video_
hash and Curator had none, so it omitted rather than lied. Curator now computes it, which makes
`skip if unchanged` possible. Without it every resync re-uploads every file — on a slow link that is
the difference between a usable feature and an unusable one.

## Consequences

- **The whole album workflow is now in-app.** Attach a video in Curator and it reaches the Pi; the
  rsync step becomes a fallback for bulk/offline moves, not a required step.
- **`sync` stops over-reporting.** A push failure is a real failure, recorded as a `syncIssue` like
  any other, so "synced" stops meaning "the metadata went".
- **Backdrop accepts writes for the first time.** It has been read-only over HTTP apart from library
  updates. The `fileId` pattern and the temp-then-rename are what keep that from being a liability;
  both are tested directly, not assumed.
- **rsync stays supported and stays documented.** For a first bulk load over a good link it is still
  faster, and `media_transfer = "none"` preserves exactly today's behaviour.
- **The transport was never the bottleneck.** The Pi this was built against sits on Wi-Fi at −72 dBm
  with `eth0` down; a 239 MB `scp` took ~90 minutes, and an HTTP push is subject to the same link.
  This ADR does not make transfers fast — it makes them automatic. The UI must therefore report
  progress honestly, because a slow network must not read as a broken feature.
- **Not solved here**: resumable/chunked upload. A dropped 240 MB push restarts from zero. Worth
  revisiting if the link stays poor, but it is a substantial addition and the atomic-rename property
  already prevents the dangerous failure (a half-file that looks whole).
