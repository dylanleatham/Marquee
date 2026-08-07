import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { parse as parseToml } from "smol-toml";
import { readSettings } from "./settings.js";

// Resolve config.toml next to the package (matches hue-conductor), not the process cwd.
const pkgDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** How the visualizer mp4 gets onto Backdrop's host (ADR 0038). */
export type MediaTransferMode = "none" | "local" | "push";

const MEDIA_TRANSFER_MODES: readonly MediaTransferMode[] = [
  "none",
  "local",
  "push",
];

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
   * Discogs config, if a personal access token
   * ([ADR 0017](../../../docs/adrs/0017-discogs-personal-token-and-direct-images.md)) OR OAuth
   * consumer creds (issue #59) are set. Absent → the Discogs collection/add routes 503.
   * `username` is optional — when omitted, the client resolves it from the token's identity.
   * The consumer key/secret + callback enable the 3-legged "log in with Discogs" OAuth 1.0a flow;
   * the personal token remains the simpler default.
   */
  discogs?: {
    token?: string;
    username?: string;
    consumerKey?: string;
    consumerSecret?: string;
    callbackUrl?: string;
    /**
     * Poll the collection on a timer and add new records automatically (issue #234). Opt-in,
     * default off. The manual sweep is always available regardless.
     */
    autoSync?: boolean;
    /** Minutes between polls; clamped up to the poller's floor (5 min). Default 60. */
    autoSyncIntervalMinutes?: number;
  };
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
    /**
     * Whether each flag is pinned **above** `settings.json` — set in `config.toml` or the
     * environment. Settings writes `settings.json`, the lowest link in the chain, so a pinned flag
     * cannot be changed from the UI and the screen has to say so instead of offering a checkbox
     * that silently loses ([#240](https://github.com/dylanleatham/Marquee/issues/240)).
     */
    generateCardArtPinned: boolean;
    generateVideoPinned: boolean;
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
  conductor: {
    url: string;
    sharedSecret?: string;
    /**
     * Whether to push the album-assets store to this Conductor (ADR 0045).
     *
     * Defaults on **only when a URL was explicitly configured**. The `url` above always has a value
     * (localhost:4737), so pushing unconditionally would mean every album on a workstation with no
     * runtime collecting a "Conductor unreachable" syncIssue — noise that would train you to ignore
     * the field that is supposed to tell you the runtime is out of date. Set `push_assets` to
     * override in either direction.
     */
    pushAssets: boolean;
  };
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
    /**
     * How the visualizer file reaches Backdrop's host (ADR 0038):
     * - `none`   — it doesn't; an out-of-band rsync moves it (the Pi default, and today's behaviour)
     * - `local`  — same machine, copied in-process
     * - `push`   — streamed to Backdrop over HTTP
     *
     * Always set by `loadConfig`. Optional only so a caller constructing this object directly can
     * still express the mode with the legacy `syncMediaLocally` alone; the wiring falls back to it.
     */
    mediaTransfer?: MediaTransferMode;
    /** Derived from `mediaTransfer === "local"`. Kept because it also gates path resolution (#166). */
    syncMediaLocally: boolean;
  };
  /**
   * How Curator reaches Amp for the room rehearsal's audio leg (ADR 0028). Absent → the rehearsal
   * still drives lights and video, and reports audio as unconfigured rather than failing. Same
   * `X-Trigger-Secret` as the other services.
   */
  amp?: { url: string; sharedSecret?: string };
  /**
   * How Curator reaches Stylus, for the system-status page only. Stylus *produces* scan events; it
   * never consumes them, so unlike the other three this is a read-only observability target and
   * never appears in a rehearsal fan-out. Absent → the status page reports it unconfigured.
   */
  stylus?: { url: string; sharedSecret?: string };
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
  const discogsFile = file.discogs ?? {};
  const geminiFile = file.gemini ?? {};
  const conductorFile = file.conductor ?? {};
  const backdropFile = file.backdrop ?? {};
  const ampFile = file.amp ?? {};
  const stylusFile = file.stylus ?? {};

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

  const discogsToken =
    (discogsFile.token as string | undefined) ??
    process.env.DISCOGS_TOKEN ??
    settings.discogs?.token;
  const discogsUsername =
    (discogsFile.username as string | undefined) ??
    process.env.DISCOGS_USERNAME ??
    settings.discogs?.username;
  // OAuth 1.0a consumer creds (issue #59) — enable "log in with Discogs" alongside the personal token.
  const discogsConsumerKey =
    (discogsFile.consumer_key as string | undefined) ??
    process.env.DISCOGS_CONSUMER_KEY ??
    settings.discogs?.consumerKey;
  const discogsConsumerSecret =
    (discogsFile.consumer_secret as string | undefined) ??
    process.env.DISCOGS_CONSUMER_SECRET ??
    settings.discogs?.consumerSecret;

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
  // Pinned = set above `settings.json`, which Settings is the only writer of. Computed here rather
  // than at the route because this is where the chain lives; a second copy of the precedence would
  // be a second thing to keep in step.
  const generateCardArtPinned =
    (geminiFile.generate_card_art ?? process.env.GEMINI_GENERATE_CARD_ART) !==
    undefined;
  const generateVideoPinned =
    (geminiFile.generate_video ?? process.env.GEMINI_GENERATE_VIDEO) !==
    undefined;

  // Automatic Discogs collection polling (issue #234). Opt-in like the generation flags above; the
  // interval is a hint, clamped to the poller's floor rather than trusted.
  const discogsAutoSync = asBool(
    discogsFile.auto_sync ??
      process.env.DISCOGS_AUTO_SYNC ??
      settings.discogs?.autoSync,
  );
  const discogsAutoSyncRaw =
    discogsFile.auto_sync_interval_minutes ??
    process.env.DISCOGS_AUTO_SYNC_INTERVAL_MINUTES ??
    settings.discogs?.autoSyncIntervalMinutes;
  const discogsAutoSyncMinutes =
    discogsAutoSyncRaw !== undefined &&
    Number.isFinite(Number(discogsAutoSyncRaw))
      ? Number(discogsAutoSyncRaw)
      : undefined;

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

  // Conductor asset push (ADR 0045). An explicitly-configured URL is the signal that a real runtime
  // exists to push to — the default localhost URL is only there so the Demo Room proxy has somewhere
  // to aim. `push_assets` overrides either way, for a co-located Conductor (the desktop app) or to
  // turn the push off while keeping the demo proxy pointed somewhere.
  const conductorUrl =
    (conductorFile.url as string | undefined) ?? process.env.CONDUCTOR_URL;
  // Tri-state, unlike `asBool`: "unset" has to stay distinguishable from "explicitly false", or an
  // absent setting would read as "off" and silently disable the push wherever it defaults to on.
  const rawPushAssets =
    conductorFile.push_assets ?? process.env.CURATOR_CONDUCTOR_PUSH_ASSETS;
  const conductorPushAssets =
    rawPushAssets === undefined ||
    rawPushAssets === null ||
    rawPushAssets === ""
      ? Boolean(conductorUrl)
      : asBool(rawPushAssets);

  // Backdrop sync (step 9). Configured only when a URL is present; absent → sync disabled. mediaDir
  // defaults to Curator's own visualizers dir — correct for a shared-root single-machine setup, and
  // meant to be overridden with Backdrop's real media path on a split (Pi) deployment.
  const backdropUrl =
    (backdropFile.url as string | undefined) ?? process.env.BACKDROP_URL;
  const backdropSecret =
    (backdropFile.shared_secret as string | undefined) ??
    process.env.TRIGGER_SHARED_SECRET;
  // Transfer mode (ADR 0038). `media_transfer` wins; the legacy `sync_media_locally` boolean is still
  // honoured so an existing config.toml keeps its behaviour on upgrade — silently changing how an
  // operator's media moves would be the worst way to ship this. An unrecognised mode falls back to
  // `none` rather than guessing: doing nothing is the safe wrong answer, pushing is not.
  const rawMode = String(
    backdropFile.media_transfer ?? process.env.BACKDROP_MEDIA_TRANSFER ?? "",
  ) as MediaTransferMode;
  const legacyLocal = asBool(
    backdropFile.sync_media_locally ?? process.env.BACKDROP_SYNC_MEDIA_LOCALLY,
  );
  const mediaTransfer: MediaTransferMode = MEDIA_TRANSFER_MODES.includes(
    rawMode,
  )
    ? rawMode
    : legacyLocal
      ? "local"
      : "none";
  const backdropSyncLocal = mediaTransfer === "local";
  const backdropMediaDirRaw = String(
    backdropFile.media_dir ??
      process.env.BACKDROP_MEDIA_DIR ??
      join(dataDir, "media", "visualizers"),
  );
  /**
   * `media_dir` names a location on **Backdrop's** host, and in the split deployment (runbook
   * §Topology) that is a different machine. Resolving it against Curator's filesystem is meaningless
   * there and destructive on Windows: `resolve("/home/pi/x")` yields `C:\home\pi\x`, which the
   * projection emits as `C:/home/pi/x` — a path that fails Backdrop's "must sit under media_dir"
   * check, so no album can play (issue #166).
   *
   * Resolve it only when `syncMediaLocally` says Backdrop's host *is* this machine, which is the
   * one case where it is a local path this process will itself write to.
   */
  const backdropMediaDir = backdropSyncLocal
    ? resolve(backdropMediaDirRaw)
    : backdropMediaDirRaw;

  // Stylus — the stand's reader, for the system-status page only. Read-only: Stylus *produces* scan
  // events and never consumes one, so unlike the three below it is never a fan-out target. Absent →
  // the page reports it unconfigured, which is distinct from unreachable.
  //
  // `shared_secret` is accepted for uniformity and sent as `X-Trigger-Secret`, but **Stylus's status
  // server does not check it** — `StatusService.handle` inspects only method and path (stylus-spec
  // §8.3). Harmless today and correct the day Stylus gains inbound auth; recorded here so nobody
  // reads its presence as evidence that `/status` is protected.
  const stylusUrl =
    (stylusFile.url as string | undefined) ?? process.env.STYLUS_URL;
  const stylusSecret =
    (stylusFile.shared_secret as string | undefined) ??
    process.env.TRIGGER_SHARED_SECRET;

  // Amp (ADR 0028) — the room rehearsal's audio leg. Configured only when a URL is present; absent
  // → the rehearsal reports audio as unconfigured rather than failing (lights + video still run).
  const ampUrl = (ampFile.url as string | undefined) ?? process.env.AMP_URL;
  const ampSecret =
    (ampFile.shared_secret as string | undefined) ??
    process.env.TRIGGER_SHARED_SECRET;

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
      url: String(conductorUrl ?? "http://localhost:4737"),
      pushAssets: conductorPushAssets,
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
            mediaTransfer,
            syncMediaLocally: backdropSyncLocal,
            ...(backdropSecret ? { sharedSecret: backdropSecret } : {}),
          },
        }
      : {}),
    ...(ampUrl
      ? {
          amp: {
            url: ampUrl,
            ...(ampSecret ? { sharedSecret: ampSecret } : {}),
          },
        }
      : {}),
    ...(stylusUrl
      ? {
          stylus: {
            url: stylusUrl,
            ...(stylusSecret ? { sharedSecret: stylusSecret } : {}),
          },
        }
      : {}),
    ...(clientId && clientSecret
      ? { spotify: { clientId, clientSecret, redirectUri } }
      : {}),
    ...(discogsToken || (discogsConsumerKey && discogsConsumerSecret)
      ? {
          discogs: {
            ...(discogsToken ? { token: discogsToken } : {}),
            ...(discogsUsername ? { username: discogsUsername } : {}),
            ...(discogsConsumerKey && discogsConsumerSecret
              ? {
                  consumerKey: discogsConsumerKey,
                  consumerSecret: discogsConsumerSecret,
                  callbackUrl: String(
                    (discogsFile.callback_url as string | undefined) ??
                      process.env.DISCOGS_CALLBACK_URL ??
                      `http://${host}:${port}/api/discogs/auth/callback`,
                  ),
                }
              : {}),
            ...(discogsAutoSync ? { autoSync: true } : {}),
            ...(discogsAutoSyncMinutes !== undefined
              ? { autoSyncIntervalMinutes: discogsAutoSyncMinutes }
              : {}),
          },
        }
      : {}),
    ...(geminiApiKey
      ? {
          gemini: {
            apiKey: geminiApiKey,
            generateCardArt,
            generateVideo,
            generateCardArtPinned,
            generateVideoPinned,
            ...geminiModels,
          },
        }
      : {}),
  };
  return { ...base, ...override };
}
