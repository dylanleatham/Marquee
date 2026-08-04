// User-writable app settings, stored in the data dir (~/marquee/settings.json) rather than the app
// bundle — so the packaged desktop app (which has no repo `.env`) can be configured in-app and keep
// its config across reinstalls. Currently just Spotify credentials; more can join over time.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

export interface CuratorSettings {
  spotify?: { clientId: string; clientSecret: string };
  /** Discogs auth: a personal access token
   * ([ADR 0017](../../../docs/adrs/0017-discogs-personal-token-and-direct-images.md)) and/or OAuth
   * consumer creds (issue #59), plus an optional collection username. */
  discogs?: {
    token?: string;
    username?: string;
    consumerKey?: string;
    consumerSecret?: string;
    /**
     * Poll the collection and add new records automatically (issue #234). Off unless asked for —
     * a background job that reaches the network and writes to the library is opt-in.
     */
    autoSync?: boolean;
    /** Minutes between polls; clamped to the poller's floor. */
    autoSyncIntervalMinutes?: number;
  };
  gemini?: {
    apiKey?: string;
    /** Opt-in artifact generation (default off — prompts only). */
    generateCardArt?: boolean;
    generateVideo?: boolean;
  };
}

const settingsFile = (dataDir: string): string =>
  join(dataDir, "settings.json");

/** Read the settings file. Absent or malformed → `{}` (never throws — bad JSON must not wedge boot). */
export function readSettings(dataDir: string): CuratorSettings {
  const file = settingsFile(dataDir);
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, "utf8")) as CuratorSettings;
  } catch {
    return {};
  }
}

/**
 * Persist Spotify credentials, merged with any existing settings. Creates the data dir if needed.
 * Read-modify-write is safe here because the sole writer is the human-driven Settings form (no
 * concurrent writers); revisit with a lock if a background writer is ever added.
 */
export function writeSpotifyCreds(
  dataDir: string,
  creds: { clientId: string; clientSecret: string },
): void {
  const next: CuratorSettings = { ...readSettings(dataDir), spotify: creds };
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(settingsFile(dataDir), JSON.stringify(next, null, 2));
}

/**
 * Merge a Discogs settings patch (personal token + username, and/or OAuth consumer creds) into the
 * existing settings — so saving the token doesn't wipe the consumer creds, and vice versa (issue #59).
 * Only the fields present in the patch change; a provided-but-blank username is dropped so the client
 * falls back to resolving it from the token's identity. Same read-modify-write story as
 * `writeSpotifyCreds` (the sole writer is the Settings form).
 */
export function writeDiscogsSettings(
  dataDir: string,
  patch: {
    token?: string;
    username?: string;
    consumerKey?: string;
    consumerSecret?: string;
    autoSync?: boolean;
    autoSyncIntervalMinutes?: number;
  },
): void {
  const cur = readSettings(dataDir);
  const discogs: NonNullable<CuratorSettings["discogs"]> = { ...cur.discogs };
  if (patch.token !== undefined) discogs.token = patch.token;
  if (patch.username !== undefined) {
    if (patch.username.trim()) discogs.username = patch.username.trim();
    else delete discogs.username;
  }
  if (patch.consumerKey !== undefined) discogs.consumerKey = patch.consumerKey;
  if (patch.consumerSecret !== undefined)
    discogs.consumerSecret = patch.consumerSecret;
  if (patch.autoSync !== undefined) discogs.autoSync = patch.autoSync;
  if (patch.autoSyncIntervalMinutes !== undefined)
    discogs.autoSyncIntervalMinutes = patch.autoSyncIntervalMinutes;
  const next: CuratorSettings = { ...cur, discogs };
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(settingsFile(dataDir), JSON.stringify(next, null, 2));
}

/**
 * Merge a patch into the Gemini settings (API key and/or the opt-in generation flags), preserving
 * the rest — so toggling generation doesn't wipe the key, and vice versa. Same read-modify-write
 * story as `writeSpotifyCreds` (the sole writer is the human-driven Settings form).
 */
export function updateGeminiSettings(
  dataDir: string,
  patch: NonNullable<CuratorSettings["gemini"]>,
): void {
  const cur = readSettings(dataDir);
  const next: CuratorSettings = {
    ...cur,
    gemini: { ...cur.gemini, ...patch },
  };
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(settingsFile(dataDir), JSON.stringify(next, null, 2));
}
