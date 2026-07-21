# ADR 0015 — Curator → Backdrop sync fires on projection changes, not on every save

Status: accepted · Date: 2026-07-20 · Amends: runtime-overview §8 ("Curator → Backdrop metadata"),
roadie-spec §6 ("Backdrop sync triggers")

## Context

Build step 8 gave Backdrop the _receiving_ half of library sync: `POST /api/library/update`,
`POST /api/library/sync`, `DELETE /api/library/:uri`, `GET /api/library`. Nothing fed it. Step 9 is
the Curator side — the projection push that lets "add an album in Curator" become "it plays in
Backdrop."

Two specs describe _when_ Curator pushes, and they don't quite agree on granularity:

- **runtime-overview §8**: "Curator → Backdrop metadata: **HTTP push after each save**
  (`POST /api/library/update`)."
- **roadie-spec §6**: the ★ triggers fire on the human transitions **video attach** (★sync) and
  **verified** (★verify); "the metadata push to Backdrop's `library.json` already happened via
  Curator's post-save hook."

Taken literally, "push after each save" means every `AssetStore.save` — including the dozens Roadie
performs while an album is still `fresh … drafting_prompts`, none of which have a visualizer yet.
Backdrop's library entry requires a `filePath`; an album with no video has nothing to project. So a
literal per-save hook would fire a stream of no-op DELETEs for video-less albums and couple the
synchronous, widely-used `AssetStore.save` to an outbound network call.

Two more facts shape the decision:

- The Backdrop-relevant projection only changes at a few points: a **video is attached** (entry
  appears), a **video is detached** or the **album is deleted** (entry disappears). Palette edits,
  prompt redrafts, preview approval, etc. don't change what Backdrop plays.
- The **`verified`** transition has **no endpoint yet** — the tag-write/verify (physical) flow is
  build step 11. So ★verify-on-`verified` has nothing to hook into in step 9.

## Decision

**Curator syncs to Backdrop at the action/route layer, at the moments the projection actually
changes — not on every `AssetStore.save`.**

1. Triggers implemented in step 9 (all in `server.ts` routes, mirroring how the Demo Room calls
   Conductor at the route layer rather than inside the store):
   - **video attach** (`POST /api/videos/upload` with a curatorId, and `POST /api/albums/:id/attach-video`)
     → `syncAlbum` → upsert the entry (this is roadie-spec §6's **★sync**).
   - **video detach** (`POST /api/albums/:id/detach-video`) → the projection is now empty → remove
     the entry.
   - **album delete** (`DELETE /api/albums/:id`) → remove the entry, so a stale scan can't resolve.
   - **manual full reconcile** (`POST /api/backdrop/sync`) and **verify**
     (`POST /api/backdrop/verify-sync`) — the "run sync from Curator" recovery (runtime-overview §9)
     and a drift check.
2. `AssetStore` stays pure — it performs no I/O beyond its own files. The sync layer
   (`src/backdrop/`) owns the HTTP client, the projection, and the optional in-process file copy.
3. **Sync is a side effect, never a state change** (roadie-spec §6): every sync method is
   best-effort and records its outcome in `roadie.syncIssues` (surfaced through the derived status)
   instead of throwing into the human action that triggered it. Albums never move backward on a
   sync failure.
4. **★verify-on-`verified` is deferred** with the rest of the tag-write/verify flow (step 11): there
   is no `verified` endpoint to fire it from yet. The _capability_ ships now as the manual
   `POST /api/backdrop/verify-sync`; wiring it to the automatic transition is a one-line addition when
   that endpoint lands.

## Consequences

- **No per-save network coupling and no no-op DELETE storm** for the majority of albums (those still
  in Roadie's pipeline, with no video). Pushes happen exactly when the thing Backdrop cares about
  changes.
- **Video-file transfer is separate from metadata.** The metadata push is Curator's HTTP job. The
  mp4 itself reaches Backdrop's media dir by out-of-band rsync on a split (Pi) deployment; on a
  single workstation the opt-in `backdrop.syncMediaLocally` copies it in-process so the whole loop
  runs on one machine. This matches runtime-overview §8's "videos: rsync/syncthing" split.
- **`filePath` is built from `backdrop.mediaDir`** (Backdrop's media path on _its_ host), because
  Backdrop rejects any filePath outside its own media dir. Curator therefore carries that path in
  config; it defaults to Curator's own visualizers dir (correct for a shared-root single machine)
  and is overridden with the Pi's path on a split deployment.
- **Specs updated in this PR**: runtime-overview §8 (the "after each save" wording → "after each save
  that changes the projection"), roadie-spec §6 (the deferred note → ★sync implemented in step 9,
  ★verify pending the verified endpoint), and curator-spec §8 (the new `/api/backdrop/*` routes).
- If a future need arises to reflect _metadata-only_ changes (e.g. a renamed album) to Backdrop,
  that's a new projection field and a new trigger point — added deliberately, not by resurrecting a
  blanket per-save hook.
