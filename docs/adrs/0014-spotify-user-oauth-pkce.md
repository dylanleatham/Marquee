# ADR 0014 — Spotify user login via Authorization Code + PKCE

Status: accepted · Date: 2026-07-19 · Amends: [curator-spec §8](../specs/curator-spec.md) (HTTP API),
[album-onboarding-workflow §9/§11](../specs/album-onboarding-workflow.md) · Closes #23

## Context

Curator has always talked to Spotify with the **client-credentials grant** (`SpotifyClient` in
`packages/curator/src/spotify/client.ts`): an app-only token, good for public catalog metadata and
cover art, with **no user context**. That's all onboarding needs today (search an album, read its
metadata + art).

The next step — playing a record's album straight through the user's speakers via **Spotify Connect**
when a sleeve is placed on the stand, as an alternative to the physical vinyl — needs a **logged-in
user session**. Connect's transport endpoints (`/me/player/*`) are user-scoped; client-credentials
can't reach them. Issue #23 asks for the login foundation now, with the playback work as a follow-on.

Three constraints shaped the design:

1. **Native/desktop app, no server to keep a secret.** Curator runs on the user's machine (packaged
   Electron, ADR 0008). The OAuth **Authorization Code + PKCE** flow is the native-app fit: a
   per-login `code_verifier` proves the caller, so no client secret ships in the token exchange.
2. **Curator already runs a local HTTP server.** It can host the OAuth redirect callback itself; the
   desktop shell already opens external URLs in the system browser
   (`setWindowOpenHandler` → `shell.openExternal`).
3. **Existing trust model is plaintext-local.** Curator is unauthenticated on the LAN (Home
   Assistant-style, runtime-overview §8). The Spotify client secret and Gemini API key already live
   as **plaintext** in `settings.json` in the data dir.

## Decision

**Add Spotify user login via Authorization Code + PKCE, served by Curator's local server, keeping
client-credentials as the fallback for unauthenticated catalog reads.**

1. **Flow.** `SpotifyAuth` (`packages/curator/src/spotify/auth.ts`) generates a PKCE
   verifier/`S256` challenge + a `state` nonce, and returns the authorize URL
   (`GET /api/spotify/auth/login`). The UI opens it (system browser in the desktop shell). Spotify
   redirects to the loopback callback `GET /api/spotify/auth/callback`, which validates `state`,
   exchanges the code + verifier for tokens, and persists the refresh token. Access tokens are then
   minted from the refresh token and cached until ~60s before expiry — the same cache shape as the
   app token.

2. **Redirect URI = loopback on Curator's port.** Default
   `http://127.0.0.1:4739/api/spotify/auth/callback` (Spotify permits a `127.0.0.1` loopback with an
   explicit port; `localhost` is deprecated). Overridable via `spotify.redirect_uri` /
   `SPOTIFY_REDIRECT_URI`. **Must be registered on the Spotify app.**

3. **Refresh token at rest: plaintext, in its own file.** Stored in **`spotify-tokens.json`** in the
   data dir — _not_ `settings.json`. Two reasons: (a) it matches the existing trust model (the client
   secret and Gemini key are already plaintext there); (b) `settings.json` has a documented
   "sole writer is the human Settings form" single-writer invariant, and the token store is written
   by the async auth handshake — a separate file keeps that invariant intact and keeps a machine
   secret out of the file users hand-edit. **Deliberately not** using the OS keychain: it would drag
   a native dependency (keytar) into the packaged build for a threat model that already accepts
   plaintext local secrets. Electron `safeStorage` is noted as future hardening if the model tightens.

4. **Client-credentials stays the fallback.** `SpotifyClient` takes an optional
   `getUserToken()`; requests use a connected user's token when present and fall back to the app
   token otherwise, so search/add keep working with **no user logged in**. A _broken/revoked_ session
   degrades to the app token for catalog reads (logged) rather than hard-failing; a revoked refresh
   token (`invalid_grant`) is cleared so the UI can prompt a reconnect.

5. **Scopes requested up front.** `streaming`, `user-read-playback-state`,
   `user-modify-playback-state`, `user-read-email`, `user-read-private` — the Connect/Web-Playback
   set — are requested at first login even though search doesn't need them, so linking the account
   now doesn't force a second consent when the playback follow-on lands.

6. **Login only needs the (public) clientId,** but the feature is gated on Spotify being _configured_
   (clientId **and** secret present) to keep a single "is Spotify set up?" story across the app-token
   and user-token paths.

## Consequences

- **A new credential file** (`spotify-tokens.json`) joins `settings.json` in the data dir. Connect
  and Disconnect take effect **immediately** (the `SpotifyAuth` instance mutates in place), unlike
  the boot-time credential wiring which still needs a restart.
- **Search now routes through the user session when connected.** Functionally identical for the
  catalog today; it's the seam the Connect playback work builds on. A regression test asserts search
  uses the user token when connected and the app token when not (and still succeeds when a stored
  session is revoked).
- **Fake + tests.** `@marquee/fake-spotify` gains the `authorize`→token(auth-code, PKCE-verified)→
  refresh endpoints (with their own tests); Curator tests cover the handshake, refresh/caching,
  disconnect, revocation, and the fallback.
- **Out of scope (unblocked):** Spotify Connect playback on record-place — device selection,
  transport controls, runtime/Demo Room tie-in. A separate issue.
- **Open item:** the maintainer must add the loopback redirect URI to the Spotify app registration
  before login will succeed.
