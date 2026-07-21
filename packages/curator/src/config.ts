import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { parse as parseToml } from "smol-toml";
import { readSettings } from "./settings.js";

// Resolve config.toml next to the package (matches hue-conductor), not the process cwd.
const pkgDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export interface Config {
  port: number;
  host: string;
  /** Root for the album-assets store and the media store (default ~/marquee). */
  dataDir: string;
  /** Ceiling for a single multipart upload. Visualizer videos are the only large uploads. */
  maxUploadBytes: number;
  /**
   * Spotify credentials, if configured. Absent → the Spotify add/search routes 503. `clientId` +
   * `clientSecret` drive the app-only client-credentials flow; `redirectUri` is the loopback
   * callback for the user OAuth (Authorization Code + PKCE) flow (issue #23 / ADR 0014).
   */
  spotify?: { clientId: string; clientSecret: string; redirectUri: string };
  /**
   * Gemini config, if a key is set. Powers LLM prompt drafting (always on when keyed) plus the
   * *optional* artifact generation. Absent → Roadie falls back to the deterministic prompt templates
   * and the generate routes 400. `generateCardArt`/`generateVideo` are **opt-in, default off**: by
   * default Curator only drafts prompts (copy them into your own image/video tool — much cheaper
   * than metered Veo). Turn generation on per-artifact in Settings when you want it.
   */
  gemini?: {
    apiKey: string;
    generateCardArt: boolean;
    generateVideo: boolean;
    /** Model slugs, overridable so a Google model rotation is a config change, not a code change. */
    textModel?: string;
    imageModel?: string;
    videoModel?: string;
  };
  /**
   * How Curator reaches Hue Conductor for the runtime demo (the Demo Room drives real lights via
   * Conductor). `sharedSecret` is the same `X-Trigger-Secret` the other services use; absent → the
   * demo calls Conductor unauthenticated (fine only when Conductor also runs with auth disabled).
   */
  conductor: { url: string; sharedSecret?: string };
  /**
   * How Curator reaches Backdrop to sync its library (build step 9, roadie-spec §6). Absent → sync is
   * disabled (the common case with no runtime Pi running). `mediaDir` is where Backdrop reads videos
   * *on its host* — it roots the projection's filePath, so it must match Backdrop's own media dir.
   * `syncMediaLocally` copies the mp4 into that dir in-process for a single-workstation setup; leave
   * it off on the Pi, where an out-of-band rsync moves the file (runtime-overview §8).
   */
  backdrop?: {
    url: string;
    sharedSecret?: string;
    mediaDir: string;
    syncMediaLocally: boolean;
  };
}

// Upload ceiling. A compiled-in 500 MB cap rejected real 1 GB visualizer videos (issue #12), so
// this is configurable and defaults high enough for them. Uploads stream straight to a temp file
// (issue #16 / ADR 0006), so this is a disk/policy limit, not a memory-safety bound — raise it as
// far as disk allows. It's still bounded (not unlimited) so a runaway upload can't fill the disk.
const DEFAULT_MAX_UPLOAD_MB = 2048;

/**
 * Curator config from config.toml / env / defaults. Curator's own UI+API runs unauthenticated
 * on the LAN (like Home Assistant, per runtime-overview §8); the shared secret only matters for
 * the outbound pushes to Conductor/Backdrop, which arrive in a later step. `override` wins (tests).
 */
export function loadConfig(override: Partial<Config> = {}): Config {
  const path = process.env.CURATOR_CONFIG ?? join(pkgDir, "config.toml");
  const file = existsSync(path)
    ? (parseToml(readFileSync(path, "utf8")) as Record<
        string,
        Record<string, unknown>
      >)
    : {};
  const server = file.server ?? {};
  const storage = file.storage ?? {};
  const spotifyFile = file.spotify ?? {};
  const geminiFile = file.gemini ?? {};
  const conductorFile = file.conductor ?? {};
  const backdropFile = file.backdrop ?? {};

  // Resolve the data dir first: it holds settings.json, the user-writable credential store the
  // packaged app relies on (it has no repo `.env`). config.toml/env still win, so dev is unchanged.
  const dataDir = resolve(
    String(
      storage.data_dir ??
        process.env.MARQUEE_DATA_DIR ??
        join(homedir(), "marquee"),
    ),
  );
  const settings = readSettings(dataDir);

  const clientId =
    (spotifyFile.client_id as string | undefined) ??
    process.env.SPOTIFY_CLIENT_ID ??
    settings.spotify?.clientId;
  const clientSecret =
    (spotifyFile.client_secret as string | undefined) ??
    process.env.SPOTIFY_CLIENT_SECRET ??
    settings.spotify?.clientSecret;

  const geminiApiKey =
    (geminiFile.api_key as string | undefined) ??
    process.env.GEMINI_API_KEY ??
    settings.gemini?.apiKey;

  // Opt-in generation flags (default off). A boolean anywhere in the chain wins; strings "true"/"1"
  // from env/toml count as true.
  const asBool = (v: unknown): boolean =>
    v === true || v === "true" || v === "1";
  const generateCardArt = asBool(
    geminiFile.generate_card_art ??
      process.env.GEMINI_GENERATE_CARD_ART ??
      settings.gemini?.generateCardArt,
  );
  const generateVideo = asBool(
    geminiFile.generate_video ??
      process.env.GEMINI_GENERATE_VIDEO ??
      settings.gemini?.generateVideo,
  );

  // Model slugs (optional overrides). Google rotates/retires slugs — an override here beats a code
  // change when that happens. Undefined → the GeminiClient's own current defaults.
  const geminiModels = {
    ...(geminiFile.text_model || process.env.GEMINI_TEXT_MODEL
      ? {
          textModel: String(
            geminiFile.text_model ?? process.env.GEMINI_TEXT_MODEL,
          ),
        }
      : {}),
    ...(geminiFile.image_model || process.env.GEMINI_IMAGE_MODEL
      ? {
          imageModel: String(
            geminiFile.image_model ?? process.env.GEMINI_IMAGE_MODEL,
          ),
        }
      : {}),
    ...(geminiFile.video_model || process.env.GEMINI_VIDEO_MODEL
      ? {
          videoModel: String(
            geminiFile.video_model ?? process.env.GEMINI_VIDEO_MODEL,
          ),
        }
      : {}),
  };

  // A malformed value (NaN, zero, negative) falls back to the default rather than silently
  // wedging every upload behind a nonsense ceiling.
  const maxUploadMb = Number(
    storage.max_upload_mb ??
      process.env.CURATOR_MAX_UPLOAD_MB ??
      DEFAULT_MAX_UPLOAD_MB,
  );

  const port = Number(server.port ?? process.env.CURATOR_PORT ?? 4739);
  const host = String(server.host ?? "127.0.0.1");

  // Backdrop sync (step 9). Configured only when a URL is present; absent → sync disabled. mediaDir
  // defaults to Curator's own visualizers dir — correct for a shared-root single-machine setup, and
  // meant to be overridden with Backdrop's real media path on a split (Pi) deployment.
  const backdropUrl =
    (backdropFile.url as string | undefined) ?? process.env.BACKDROP_URL;
  const backdropMediaDir = resolve(
    String(
      backdropFile.media_dir ??
        process.env.BACKDROP_MEDIA_DIR ??
        join(dataDir, "media", "visualizers"),
    ),
  );
  const backdropSecret =
    (backdropFile.shared_secret as string | undefined) ??
    process.env.TRIGGER_SHARED_SECRET;
  const backdropSyncLocal = asBool(
    backdropFile.sync_media_locally ?? process.env.BACKDROP_SYNC_MEDIA_LOCALLY,
  );

  // The OAuth callback the Spotify authorize redirect lands on. Defaults to the loopback address +
  // Curator's port (Spotify allows a 127.0.0.1 loopback with an explicit port); overridable so a
  // non-default host/port or a registered URI can be pinned. Must be registered on the Spotify app.
  const redirectUri = String(
    (spotifyFile.redirect_uri as string | undefined) ??
      process.env.SPOTIFY_REDIRECT_URI ??
      `http://${host}:${port}/api/spotify/auth/callback`,
  );

  const base: Config = {
    port,
    host,
    maxUploadBytes:
      (Number.isFinite(maxUploadMb) && maxUploadMb > 0
        ? maxUploadMb
        : DEFAULT_MAX_UPLOAD_MB) *
      1024 *
      1024,
    dataDir,
    conductor: {
      url: String(
        conductorFile.url ??
          process.env.CONDUCTOR_URL ??
          "http://localhost:4737",
      ),
      ...((conductorFile.shared_secret ?? process.env.TRIGGER_SHARED_SECRET)
        ? {
            sharedSecret: String(
              conductorFile.shared_secret ?? process.env.TRIGGER_SHARED_SECRET,
            ),
          }
        : {}),
    },
    ...(backdropUrl
      ? {
          backdrop: {
            url: backdropUrl,
            mediaDir: backdropMediaDir,
            syncMediaLocally: backdropSyncLocal,
            ...(backdropSecret ? { sharedSecret: backdropSecret } : {}),
          },
        }
      : {}),
    ...(clientId && clientSecret
      ? { spotify: { clientId, clientSecret, redirectUri } }
      : {}),
    ...(geminiApiKey
      ? {
          gemini: {
            apiKey: geminiApiKey,
            generateCardArt,
            generateVideo,
            ...geminiModels,
          },
        }
      : {}),
  };
  return { ...base, ...override };
}
