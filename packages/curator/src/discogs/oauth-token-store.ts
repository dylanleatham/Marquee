// Persistence for the Discogs OAuth 1.0a user session (issue #59 / ADR 0017). Unlike the personal
// access token (which lives in settings.json as human-editable config), the OAuth access token +
// secret are machine-managed session state, kept in their own `discogs-tokens.json` in the data dir —
// mirroring the Spotify token store's rationale (single-writer settings.json; a machine secret out of
// the file users edit). Plaintext at rest, matching the existing trust model (Curator is
// unauthenticated on the LAN; ADR 0014 records Electron safeStorage as future hardening).
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  rmSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";

export interface DiscogsOAuthTokens {
  /** The OAuth 1.0a access token (long-lived unless the user revokes the app). */
  accessToken: string;
  /** The access token's secret — the second half of the PLAINTEXT signature. */
  accessTokenSecret: string;
  /** The Discogs username the token belongs to (resolved from /oauth/identity at connect). */
  username?: string;
  /** When the session was obtained (ISO 8601) — display/debugging only. */
  obtainedAt: string;
}

const tokensFile = (dataDir: string): string =>
  join(dataDir, "discogs-tokens.json");

/** Read the stored OAuth session. Absent or malformed → `undefined` (never throws — a bad file must
 *  not wedge boot; the user just re-connects). */
export function readDiscogsTokens(
  dataDir: string,
): DiscogsOAuthTokens | undefined {
  const file = tokensFile(dataDir);
  if (!existsSync(file)) return undefined;
  try {
    const parsed = JSON.parse(
      readFileSync(file, "utf8"),
    ) as Partial<DiscogsOAuthTokens>;
    if (
      typeof parsed.accessToken !== "string" ||
      !parsed.accessToken ||
      typeof parsed.accessTokenSecret !== "string" ||
      !parsed.accessTokenSecret
    )
      return undefined;
    return {
      accessToken: parsed.accessToken,
      accessTokenSecret: parsed.accessTokenSecret,
      ...(typeof parsed.username === "string"
        ? { username: parsed.username }
        : {}),
      obtainedAt:
        typeof parsed.obtainedAt === "string"
          ? parsed.obtainedAt
          : new Date(0).toISOString(),
    };
  } catch {
    return undefined;
  }
}

/** Persist the OAuth session, creating the data dir if needed. Written once on connect. */
export function writeDiscogsTokens(
  dataDir: string,
  tokens: DiscogsOAuthTokens,
): void {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(tokensFile(dataDir), JSON.stringify(tokens, null, 2));
}

/** Remove the stored session (Disconnect). No-op if the file is absent. */
export function clearDiscogsTokens(dataDir: string): void {
  rmSync(tokensFile(dataDir), { force: true });
}
