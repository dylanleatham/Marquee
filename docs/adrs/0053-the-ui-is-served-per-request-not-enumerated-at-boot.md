# ADR 0053 — The built UI is served per request, not enumerated at boot

- **Status:** Accepted
- **Date:** 2026-08-06
- **Issue:** [#241](https://github.com/dylanleatham/Marquee/issues/241)
- **Follows:** the narrow SPA fallback added for
  [#183](https://github.com/dylanleatham/Marquee/issues/183), which is kept and now tested. That fix
  landed in code without an ADR; this one records both decisions together.

## Context

Curator serves the built React UI from `packages/curator/dist-ui` with `@fastify/static`. It was
registered with `wildcard: false`, which is not a small detail: with that option the plugin runs a
`**/**` glob **at registration** and registers **one route per file it finds**. The running process
therefore knows exactly the filenames that existed when it booted, forever.

Vite content-hashes every bundle. So a UI rebuild produces `index-BBB222.js` where the running
process only has a route for `index-AAA111.js`. `index.html` is the one file that keeps its name, so
it kept being served — pointing at assets the process would 404. The result is a **blank window**:
correct HTML, two 404s, nothing in any log that names a cause.

This is the second outage from this block, and the second whose symptom was "Marquee is blank":

- [#183](https://github.com/dylanleatham/Marquee/issues/183) — the SPA fallback answered an asset
  miss with `index.html`, so the browser executed HTML as a module script. Solid black window.
  Fixed by narrowing the fallback (`servesSpaFallback`) so a _file_ miss 404s.
- [#241](https://github.com/dylanleatham/Marquee/issues/241) — this one. The narrow fallback did its
  job: the 404s named the real filenames, which is how it was diagnosed in a single network read.
  But it only made the failure _legible_; the code comment said as much — "restarting Curator after a
  UI build is still required — this only makes forgetting it obvious."

Making a recurring footgun obvious is not the same as removing it. It fired again, at the end of a
long session, on a machine where six orphaned dev servers from two days earlier were also running —
exactly the conditions where "did you restart Curator?" is the last thing anyone checks.

The block was also **unreachable under test**: a test run has no `dist-ui`, so the whole
`if (existsSync(uiDir))` body was skipped. Both bugs shipped green.

## Decision

**Serve the UI by resolving each request against the filesystem, not from a boot-time index.**

1. `@fastify/static` is registered with **`wildcard: true`** — a single `/*` route that resolves
   against `root` per request. A file written after boot is served; a rebuild needs no restart.
2. The SPA fallback reads `index.html` **per request** instead of holding a buffer taken at
   registration. Same staleness one level up: after a rebuild, a deep link was serving HTML that
   named the previous bundle.
3. `buildServer` accepts **`opts.uiDir`**, so the static-serving block is reachable from tests.

The narrow fallback from #183 is untouched and is now covered by tests rather than by argument: a
missing _file_ still 404s, a client route still gets `index.html`, and an unknown `/api` path still
gets JSON. `wildcard: true` forwards a miss to `setNotFoundHandler`, so the two compose.

## Consequences

- **A UI rebuild no longer needs a Curator restart.** The failure mode that produced two issues and
  a blank screen is gone rather than merely legible.
- **Static resolution costs a filesystem lookup per request** instead of a routing-table hit. This is
  a localhost desktop app serving a handful of fingerprinted assets that the browser caches
  immutably; the lookup is off the OS page cache. Not a tradeoff worth the boot-time index.
- **`index.html` is read per request on the fallback path only** — one small file, on a miss, for
  client routes. Deep links now always reflect the current build.
- **The block is tested now.** `test/ui-static.test.ts` covers both historical bugs plus the
  no-`dist-ui` case, via the new `uiDir` seam. This is the durable half: the reason both bugs shipped
  was that this code could not be exercised at all.
- **Watch out for `app.ready()` in these tests.** Fastify defers plugin registration to the first
  `inject()`, so a test that writes files _before_ injecting has the glob see them and passes against
  the broken code. The first draft of the regression test did exactly that and was green on the
  unfixed server; `serverFor` awaits `ready()` for this reason.

## Alternatives considered

- **Keep `wildcard: false`, restart Curator after every UI build.** The status quo. It relies on a
  human remembering a step whose failure mode is a blank screen with no message. Rejected — it has
  now failed twice.
- **Watch `dist-ui` and re-register on change.** Solves it, but adds a watcher and a
  re-registration path to an always-on service to avoid a per-request `stat`. Complexity in the wrong
  place.
- **Have the build restart the server.** Only helps the one workflow that runs the build through
  that script, and does nothing for a packaged app or a manual `vite build`.
