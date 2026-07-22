# ADR 0017 — Discogs integration: personal access token + the release's own cover image

Status: accepted · Date: 2026-07-21 · Amends: album-onboarding-workflow.md (source list),
curator-spec.md (§7 metadata, settings, add routes), roadie-spec.md (§6 fetch/art path),
`@marquee/contracts` album-asset.schema.json (`source` enum + Discogs fields) · Implements: issue #24

## Context

Issue #24 adds **Discogs** as a third album source alongside `spotify` and `manual`: log in to your
Discogs account, browse the albums in your **collection**, and send the ones you own to Roadie.
Discogs is where many people already catalog their physical records, so onboarding by picking from a
list beats searching Spotify by hand or typing everything in manually.

The issue flagged three decisions to make deliberately (CLAUDE.md: specs are the source of truth, and
auth/art choices get an ADR):

1. **Auth** — Discogs offers **OAuth 1.0a** (a real "log in with Discogs" 3-legged handshake) *or* a
   **personal access token** the user generates in their Discogs developer settings.
2. **Cover art / palette image** — feed **Discogs' own release image** into Palette Press directly,
   *or* **resolve the Discogs release to a Spotify album** and reuse the existing Spotify art path.
3. **Dedupe across sources** — if the same record exists via both Spotify and Discogs, block the
   second add, or allow both.

Marquee is a **single-user home app** (runtime-overview §8: Curator runs on your own workstation,
unauthenticated on the LAN like Home Assistant). That framing drives all three answers.

## Decision

### 1. Auth: personal access token

Curator authenticates to Discogs with a **personal access token** (`Authorization: Discogs
token=<token>`), stored in the data dir's `settings.json` next to the Spotify creds — the same
write-only credential story (`writeDiscogsSettings`, `GET/PUT /api/settings/discogs`). OAuth 1.0a
buys a login experience that a single-user app doesn't need, at the cost of a whole signature/handshake
subsystem. The token maps to exactly one Discogs user; the **collection username** is resolved once
from `/oauth/identity` (or set explicitly in settings) and cached for the process.

This is a **separate** auth mechanism from the Spotify user-OAuth in ADR 0014 — cross-referenced, not
shared. If a multi-user or "log in" experience is ever wanted, OAuth 1.0a is a later enhancement that
can sit behind the same `DiscogsClient`.

### 2. Cover art: use the Discogs release image directly

Roadie's Discogs path fetches the release detail (`GET /releases/{id}`), takes its **primary image**,
and downloads it straight into `generating_palette` — the same seam Spotify art uses. No Spotify
resolution, no fuzzy matching, no dependency on Spotify being configured. Discogs image hosts require
the same token + `User-Agent` as the API, which the client already sends.

Resolving Discogs → Spotify for "richer/consistent" art adds a fuzzy-match step and a hard dependency
on Spotify config for a Discogs-only feature. It stays a **later enhancement** (a Discogs album whose
art you dislike can already be fixed with the existing manual art-override).

> **Update (2026-07-22, issue #58) — the enhancement landed, as an *opt-in fallback*:** the Discogs
> metadata step now attempts a **conservative** fuzzy match to a Spotify album (artist + title both
> must match closely; year is a tiebreaker — `albums/spotify-match.ts`, `bestSpotifyMatch`). On a
> confident match with cover art, the art step downloads the **Spotify** image (reusing the Spotify
> art seam) and stamps `artwork.source: "spotify"`; otherwise it downloads the **Discogs** image
> (`artwork.source: "discogs"`). It's strictly best-effort: no Spotify client, no confident match, or
> any Spotify error → the Discogs image, so a Discogs add is **never blocked or failed** by this. The
> chosen source is surfaced on the album detail; the manual art-override still wins over both.

### 3. Dedupe: per-source, on the Discogs release id

Dedupe is **per-source**, mirroring today's per-Spotify-URI behavior: adding a Discogs release whose
`discogs:release:<id>` is already in the collection is a 409 (`findByDiscogsUri`); a Spotify + Discogs
pair of the *same* record can coexist. Cross-source dedupe needs a cross-provider match heuristic
(the same album has no shared id across the two services) — more machinery than a home collection
warrants, and the failure mode (two entries for one record) is easy to spot and delete.

## Consequences

- A new `source: "discogs"` flows through the whole pipeline. Album metadata gains
  `discogsReleaseId` (the stable dedupe key), `discogsUri` (`discogs:release:<id>`, parallel to
  `spotifyUri`), and `discogsArtUrl` (parallel to `spotifyArtUrl`).
- Roadie's `fresh` routing changes from "spotify → fetching_metadata, else → generating_palette" to
  "**manual → generating_palette, else → fetching_metadata**." Spotify *and* Discogs both fetch
  metadata + art off the request path; only manual arrives with both already on disk. The
  `fetching_metadata` and `downloading_art` steps dispatch on `metadata.source`.
- `DiscogsClient` mirrors `SpotifyClient`: injectable `fetch`, per-request timeout, its own
  `DiscogsError`, and a `@marquee/fake-discogs` network fake so tests never hit the wire.
- The collection browser is a new tab on the Add screen (`GET /api/discogs/collection`, paginated);
  "Send to Roadie" per row hits `POST /api/albums` with a `releaseId`. Absent a token, the routes
  503 and the UI points at Settings — exactly like Spotify-not-configured.
- Discogs is optional: with no token, nothing changes for Spotify/manual users.

## Alternatives considered

- **OAuth 1.0a login** — the "real" experience; rejected as disproportionate for one user. Revisit if
  multi-user ever matters.
- **Resolve to Spotify for art** — richer art, but couples a Discogs feature to Spotify and adds
  fuzzy matching. ~~Deferred.~~ **Landed as an opt-in fallback (issue #58)** — see the §2 update above.
- **Cross-source dedupe** — more correct in theory; deferred for lack of a reliable cross-provider
  identity and a low-stakes failure mode.
