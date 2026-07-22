# ADR 0019 — Conductor drives lights from raw scan events; palette mapping shared in contracts

Status: accepted · Date: 2026-07-22 · Amends: hue-conductor-spec.md (§7 Scan events — now
implemented), runtime-overview.md (§4/§5 — "Conductor reads the album-assets store" now built),
integration-contract.md (the album→payload mapping now lives in `@marquee/contracts`) ·
Implements: issue #45

## Context

Stylus (build step 10) fans a `ScanEvent` out to both Conductor and Backdrop at `/api/scan`
(runtime-overview §5 fan-out). **Backdrop's `/api/scan` existed; Conductor's did not** — Conductor
only accepted a pre-built `PalettePayload` on `/api/playback`, which is driven by Curator's Demo Room
proxy (ADR 0007). So a raw scan from the stand couldn't drive the lights: the "place sleeve → room
becomes the record" loop was missing its lights half (Backdrop already closes the video half).

hue-conductor-spec §7 already *describes* `/api/scan` ("resolves the URI to a palette+pattern from
the local asset store and applies it to the configured listening room"), and runtime-overview §5
already says "Conductor reads the album-assets store" at scan time. This is the build that makes both
true — the first time Conductor reads Curator's store rather than only accepting payloads.

Two shape questions fell out:

- **Where does the album→payload mapping live?** Curator's Demo Room already maps a stored album to a
  `PalettePayload` in `curator/src/demo/payload.ts` (`buildPalettePayload`). Conductor's scan path
  needs the *same* mapping. Duplicating it would be two copies of a cross-service rule that must agree.
- **How hard should a scan fail?** Scan events come from hardware, unattended. A scan for an album
  Conductor hasn't synced yet — or one still mid-pipeline in Roadie — must not error-storm the
  always-on service.

## Decision

**Add `POST /api/scan` to Conductor, reading the synced album-assets store, and promote the
album→payload mapping into `@marquee/contracts` so both services map identically.**

1. **`buildPalettePayload` moves to `@marquee/contracts`** (with a minimal `AlbumPaletteInput` — the
   narrow slice it needs; Curator's full `AlbumAsset` satisfies it structurally) alongside a shared
   `PaletteNotReadyError`. Curator's `demo/payload.ts` becomes a thin re-export (keeping the
   `DemoNotReadyError` name as an alias), so its callers and tests are unchanged. Contracts is the
   designated cross-service home (it already hosts `PalettePayload` + `ScanEvent`).
2. **Conductor reads the synced store** via an injectable `AlbumAssetReader`
   (`FsAlbumAssetReader` over `config.albumAssetsDir`, default `{dataDir}/album-assets` — the rsync
   target). The curatorId is shape-validated (`^[a-z0-9]{8}$`) before it's used to build a path
   (traversal guard); a missing/unparseable file returns `null`, not a throw.
3. **`POST /api/scan`** parses a `ScanEvent` (same parser shape as Backdrop's), resolves it against
   the **configured listening room** (scan carries no room), and:
   - **start** → read the album → `buildPalettePayload` → `engine.start(room, payload)` (which
     snapshots the room and arms the 90-min idle timeout — the safety net for a lost `stop`).
   - **stop** → `engine.stop(room)` (restore the pre-scan snapshot).
   - Reuses the existing playback engine, so crossfade-on-swap and snapshot/restore are identical to
     `/api/playback`. `X-Trigger-Secret` auth is already global.
4. **Graceful degradation → 202 "ignored".** A *valid* scan we can't act on — no listening room,
   album not synced, album not far enough along (no palette/pattern) — logs and returns
   `202 { ok:true, action:"ignored", reason }` rather than an error (runtime-overview §9). Only a
   *malformed* body or a non-`curator:album:` URI is a 4xx. Bridge failures bubble to the existing
   error handler (409 not paired / 502) exactly as `/api/playback` does.

`/api/playback` stays — the Demo Room still uses it (ADR 0007). `/api/scan` is the runtime
entrypoint; `/api/playback` stays the Curator-preview entrypoint.

## Consequences

- The full "place sleeve → room becomes the record" loop can now run end-to-end from a real Stylus
  scan (stylus-spec §11 milestone 5 / build step 11): Conductor drives the lights, Backdrop the video.
- Conductor gains a read dependency on the album-assets store's on-disk shape. It reads only the
  palette-relevant slice (`AlbumPaletteInput`), so most of Curator's asset schema can change without
  touching Conductor; the coupling is the shared `buildPalettePayload` in contracts.
- `config.albumAssetsDir` is new (env `ALBUM_ASSETS_DIR` / toml `[storage].album_assets_dir`),
  defaulting to `{dataDir}/album-assets`.
- **Deferred**: `/api/playback/current` + `/api/playback/history` (still in the spec table, still
  unbuilt) are unaffected by this change; a `readerId` → multi-room mapping stays out of scope (scan
  drives the single configured listening room, matching the current single-reader design).
