// Persistence for the Spotify user session (issue #23 / ADR 0014). The OAuth **refresh token** is
// long-lived machine-managed state, kept in its own `spotify-tokens.json` in the data dir — NOT in
// `settings.json`. Two reasons:
//   1. `settings.json` is human-editable config with a documented "sole writer is the Settings form"
//      invariant (see settings.ts); the token store is written by the async auth handshake, so
//      keeping it separate preserves that single-writer assumption.
//   2. It keeps a machine secret out of the file users open to edit their client id / API keys.
//
// At-rest protection: plaintext, matching the existing trust model (the client secret and Gemini key
// are already plaintext in `settings.json`; Curator is unauthenticated on the LAN). ADR 0014 records
// this as a deliberate choice and notes Electron `safeStorage` as future hardening.
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  rmSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";

export interface SpotifyTokens {
  /** The OAuth refresh token — exchanged for short-lived access tokens (never expires unless revoked). */
  refreshToken: string;
  /** The space-delimited scopes the user granted, so we can detect when a re-consent is needed. */
  scope: string;
  /** When the refresh token was obtained (ISO 8601) — for display / debugging only. */
  obtainedAt: string;
}

const tokensFile = (dataDir: string): string =>
  join(dataDir, "spotify-tokens.json");

/** Read the stored tokens. Absent or malformed → `undefined` (never throws — a bad file must not
 *  wedge boot; the user just re-connects). */
export function readSpotifyTokens(dataDir: string): SpotifyTokens | undefined {
  const file = tokensFile(dataDir);
  if (!existsSync(file)) return undefined;
  try {
    const parsed = JSON.parse(
      readFileSync(file, "utf8"),
    ) as Partial<SpotifyTokens>;
    if (typeof parsed.refreshToken !== "string" || !parsed.refreshToken)
      return undefined;
    return {
      refreshToken: parsed.refreshToken,
      scope: typeof parsed.scope === "string" ? parsed.scope : "",
      obtainedAt:
        typeof parsed.obtainedAt === "string"
          ? parsed.obtainedAt
          : new Date(0).toISOString(),
    };
  } catch {
    return undefined;
  }
}

/** Persist the Spotify tokens, creating the data dir if needed. Written on connect and on any
 *  refresh-token rotation. */
export function writeSpotifyTokens(
  dataDir: string,
  tokens: SpotifyTokens,
): void {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(tokensFile(dataDir), JSON.stringify(tokens, null, 2));
}

/** Remove the stored tokens (Disconnect). No-op if the file is absent. */
export function clearSpotifyTokens(dataDir: string): void {
  rmSync(tokensFile(dataDir), { force: true });
}
