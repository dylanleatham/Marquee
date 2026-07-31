# ADR 0041 — Attach-by-`fileId` re-keys into the album's own slot

Status: accepted · Date: 2026-07-31 · Amends: [curator-spec](../specs/curator-spec.md) (§Video and
§Card art API tables, §9 flow B, and the build-step-7 implementation note) · Closes
[#99](https://github.com/dylanleatham/Marquee/issues/99)

## Context

`POST /api/albums/:curatorId/attach-video` and `attach-card-art` take `{ fileId }`, which the
curator-spec has always described as "**either** an ID of a file already in `visualizers/`, **or** the
filename of a file in `/incoming/` (moves it)." Only the second half was ever wired. The build-step-7
note recorded that as a deliberate deferral — "the drag-drop and `/incoming/` flows cover the real
cases" — and for a while they did.

Two things made the gap start to matter. `detach-video` / `detach-card-art` leave the file on disk
unless `?delete=1`, so detach-then-reattach is a natural motion that could only be completed by
re-uploading the same bytes. And the workbench ([#92](https://github.com/dylanleatham/Marquee/issues/92))
made every station reachable at any time, so "go back to Video and put the old one back" is now an
obvious thing to try rather than a path out of the flow.

Wiring the first half raises a question the spec sentence does not answer: when `fileId` names a file
already in the store, does the asset **point at that file**, or is the file **copied into this
album's slot**? The sentence reads as if it could mean the former, and that reading is unbuildable:

- **Every media route resolves by `curatorId`, not by `visualizer.fileId`.**
  `GET /api/albums/:curatorId/video` serves `visualizers/{curatorId}.mp4`; the thumbnail and card-art
  routes are the same shape. An asset whose `fileId` named some other file would carry a visualizer
  the app cannot play — a 404 from a route that says the album has a video.
- **`detach?delete=1` deletes `visualizerFile(visualizer.fileId)`**, and Curator's UI detach always
  passes `delete=1`. Two albums sharing one file means detaching one destroys the other's visualizer.
- **Backdrop's media transfer is keyed on the same id** ([ADR 0038](0038-curator-pushes-media-over-http.md)),
  so a shared file would push one album's bytes under another album's name.

The one-file-per-album keying is not incidental; it is what three subsystems already assume.

## Decision

**`fileId` selects a _source_. Attaching always writes the album's own slot.**

1. `fileId` resolves in two places, **`/incoming/` first**: a file in the drop zone is claimed and
   moved, exactly as before. Otherwise it is looked up in `visualizers/` (video) or `card-art/`
   (either stored extension), and read without being moved or removed.
2. Either way the file is **ingested under `curatorId`** — probed, validated, brought inside the
   decode budget ([ADR 0040](0040-visualizers-carry-a-decode-budget.md)), and thumbnailed — so
   `visualizer.fileId` / `cardArt.fileId` is always the album's own id and every serving route
   resolves. A hand-dropped file is checked on the way in rather than trusted for already being in
   the store.
3. **Source may equal destination.** Re-attaching the album's own kept file ingests
   `visualizers/{curatorId}.mp4` onto itself; `ingestVideo` skips the self-copy and ignores
   `removeSrc` in that case, and a normalize still lands by writing a temp and renaming over it.
4. A `fileId` that is not a bare on-disk name is **rejected** (`400`), not sanitized — both lookups
   join it onto a media directory. A name found in neither place is `404`.

### Why `/incoming/` wins a tie

The namespaces are near-disjoint in practice: a store id is a bare `curatorId` (or `{curatorId}-v{n}`
for a generated clip), while an `/incoming/` name carries the extension it was uploaded with. A
collision needs an extension-less drop-zone file named exactly like a store id. Probing the drop zone
first means wiring the second half of the contract **cannot** change what any existing caller's
`fileId` does, which is worth more than a tidier precedence argument.

## Consequences

- **Detach without `?delete=1` is now reversible** over the API: attach the same `fileId` back. That
  is the motivating case, and it is the one where source and destination coincide.
- **A generated clip can be attached directly as the visualizer**, by passing `{curatorId}-v{n}` —
  previously a single-clip loop had to go through `video/splice`. This falls out of the copy
  semantics rather than being designed for; the clip file survives, so the gallery is unaffected.
- **The original filename is not recovered on a re-attach.** `detach` deletes the whole `visualizer`
  section, so the human-meaningful name goes with it and the re-attached section records
  `{fileId}.mp4`. Preserving it would mean keeping a tombstone of a detached section, which is a
  larger change than the label is worth.
- **Curator's own UI cannot reach this yet**, because its Detach button passes `delete=1` — there is
  nothing left on disk to put back. Making detach non-destructive is a UX decision with its own
  question ("then what lists the orphans?"), deliberately left to
  [#99](https://github.com/dylanleatham/Marquee/issues/99)'s follow-up rather than folded in here.
  The contract is honoured at the API, which is where the spec makes the promise.
- **`ingestVideo` is now safe to call with `srcPath === dest`.** That is a property worth having
  regardless — `copyFileSync` onto its own path is a no-op on POSIX and an error on Windows, so the
  old code would have failed differently on the two platforms the repo runs on.
