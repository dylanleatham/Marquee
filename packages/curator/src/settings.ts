// User-writable app settings, stored in the data dir (~/marquee/settings.json) rather than the app
// bundle — so the packaged desktop app (which has no repo `.env`) can be configured in-app and keep
// its config across reinstalls. Currently just Spotify credentials; more can join over time.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

export interface CuratorSettings {
  spotify?: { clientId: string; clientSecret: string };
  gemini?: { apiKey: string };
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
 * Persist the Gemini API key, merged with any existing settings (same read-modify-write story as
 * `writeSpotifyCreds` — the sole writer is the human-driven Settings form). Used by the packaged
 * app, which has no repo `.env`, to configure LLM prompt drafting + artifact generation in-app.
 */
export function writeGeminiCreds(
  dataDir: string,
  creds: { apiKey: string },
): void {
  const next: CuratorSettings = { ...readSettings(dataDir), gemini: creds };
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(settingsFile(dataDir), JSON.stringify(next, null, 2));
}
