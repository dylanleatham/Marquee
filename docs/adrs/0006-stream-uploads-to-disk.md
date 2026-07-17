# ADR 0006 — Stream multipart uploads to disk instead of buffering them in memory

Status: accepted · Date: 2026-07-16 · Amends: curator-spec §9 ("Upload ceiling") · Closes: [#16](https://github.com/dylanleatham/Marquee/issues/16)

## Context

Curator accepts visualizer videos and card art as multipart uploads. Until now the request handler
(`readUpload` in `packages/curator/src/server.ts`) read each file part fully into a `Buffer` via
`part.toBuffer()`, and the callers (`attachVideoUpload`, `saveIncoming`, `attachCardArtUpload`) took
that `Buffer`. `attachVideoUpload` even staged the bytes to a temp file purely because `ffprobe`
needs a _path_, not a buffer.

So a 2 GB visualizer video was a ~2 GB heap/`arrayBuffers` allocation before a single byte reached
disk — transiently ~2× during the `Buffer.concat`.

[Issue #12](https://github.com/dylanleatham/Marquee/issues/12) raised the ceiling 500 MB → 2048 MB
and made it operator-configurable (`CURATOR_MAX_UPLOAD_MB` / `storage.max_upload_mb`) with no upper
bound. The `runtime` review agent flagged (while reviewing #12) that the ceiling was now both 4×
higher and freely configurable while the memory model was unchanged: set it to 8192 and a single
upload can OOM the box. The cap existed _only_ as a proxy for "how much can we safely hold in
memory." This wasn't a live crash — verified fine at 1.2 GB on a workstation — but it capped how
high the ceiling could safely go.

## Decision

**Stream the file part straight to a temp file on disk; never buffer it.**

1. `readUpload` pipes the single file part to a temp file under `/incoming/`
   (`pipeline(part.file, createWriteStream(tmp))`) and returns the **path**, not a buffer. The temp
   name is `.upload-<uuid>` — the leading dot keeps it out of the `/api/incoming` listing (which
   already skips dotfiles as in-flight uploads).
2. The **route owns the temp file's lifecycle**: it removes the temp in a `finally`, so the file is
   cleaned up on every exit — success, a rejected codec (422), a wrong-state attach (409), or the
   413 path. (This also plugged a pre-existing leak: the old `attachVideoUpload` left its staging
   temp behind whenever `validateVideo` threw.)
3. The action callers take a path instead of a buffer:
   - `attachVideoUpload(deps, curatorId, srcPath, filename)` — `ingestVideo` copies the path into
     `visualizers/`; it no longer removes the source (the route does).
   - `saveIncoming(store, filename, srcPath)` — a same-directory `renameSync` of the temp into
     `/incoming/<name>`, not a re-copy of a multi-GB file.
   - `attachCardArtUpload(deps, curatorId, srcPath, filename)` — **card art keeps buffering**
     internally (`readFileSync(srcPath)`), because it's cover-sized; the memory concern is the video
     path. Only the plumbing changed to a path.
4. **The 413 behavior is unchanged.** `@fastify/multipart` still enforces `limits.fileSize`: an
   over-ceiling file is truncated mid-stream and flagged as `part.file.truncated`, which we surface
   as its `RequestFileTooLargeError` (`FST_REQ_FILE_TOO_LARGE` → 413). The partial temp is discarded.

**The ceiling stays, but changes meaning.** It's no longer a memory-safety knob — it's a plain
disk/policy limit. It remains bounded (not unlimited) so a runaway upload can't silently fill the
disk, but it can now be raised as far as disk allows without OOM risk.

## Consequences

- **Memory is now flat in the file size.** A large upload holds only in-flight chunks (bounded by
  stream backpressure), not the whole file. The guard is an integration test
  (`test/upload-streaming.test.ts`) that uploads 150 MB over a real socket and asserts
  `process.memoryUsage().arrayBuffers` at `ffprobe` time grew by less than half the file — it fails
  (~2× the file) against the buffering implementation and passes streaming.
- **Disk I/O shape changed** for the no-`curatorId` path: `saveIncoming` renames rather than writes,
  so the bytes hit disk once (the stream), not twice.
- **Card art still buffers**, deliberately — small files, simpler code. If card art ever grows
  (multi-image sheets?), it moves to the same streaming path.
- **The upper bound on the ceiling is now disk, not RAM.** Operators raising
  `CURATOR_MAX_UPLOAD_MB` past physical memory is now safe; the spec §9 note records this.
- Follows the precedent of [ADR 0002](0002-hue-conductor-v4-and-dev-auth.md) /
  [ADR 0003](0003-palette-press-dominant-first-ordering.md): a code change that shifts what a spec
  says, landed with the matching spec edit in the same PR.
