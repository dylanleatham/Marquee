import { pathToFileURL, fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import {
  existsSync,
  readFileSync,
  createReadStream,
  createWriteStream,
  mkdirSync,
  rmSync,
} from "node:fs";
import { pipeline } from "node:stream/promises";
import { randomUUID } from "node:crypto";
import { join, resolve, dirname } from "node:path";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import { loadConfig, type Config } from "./config.js";
import { AssetStore } from "./store/asset-store.js";
import {
  addManualAlbum,
  ValidationError,
  type PaletteGenerator,
} from "./albums/add-manual.js";
import {
  addSpotifyAlbum,
  DuplicateAlbumError,
  parseAlbumId,
} from "./albums/add-spotify.js";
import { bucketFor, peerContext } from "./albums/peers.js";
import {
  addAlbumsBatch,
  regeneratePalettesRunner,
  type BatchAddItem,
} from "./albums/batch.js";
import { addDiscogsAlbum } from "./albums/add-discogs.js";
import { discogsSyncRunner } from "./albums/discogs-sync.js";
import { spotifyBackfillRunner } from "./albums/spotify-backfill.js";
import { DiscogsPoller } from "./discogs/poller.js";
import { SpotifyClient, SpotifyError } from "./spotify/client.js";
import { SpotifyAuth, SpotifyAuthError } from "./spotify/auth.js";
import { DeskAudio } from "./spotify/desk-audio.js";
import { DiscogsClient, DiscogsError } from "./discogs/client.js";
import { DiscogsOAuth, DiscogsOAuthError } from "./discogs/oauth.js";
import { GeminiClient } from "./gemini/client.js";
import {
  writeSpotifyCreds,
  writeDiscogsSettings,
  updateGeminiSettings,
  readSettings,
} from "./settings.js";
import { Roadie } from "./roadie/worker.js";
import { isCuratorId } from "./ids.js";
import {
  TransitionError,
  type AlbumAsset,
  type AlbumMetadata,
  type RoadieState,
} from "./albums/asset.js";
import * as actions from "./albums/actions.js";
import {
  NotFoundError,
  PaletteConflictError,
  type ActionDeps,
} from "./albums/actions.js";
import type { PaletteEditColor } from "./albums/palette.js";
import {
  GenerationJobs,
  FileJobStore,
  type GenerationJob,
  type JobKind,
} from "./jobs/manager.js";
import {
  flipperNfcFile,
  isTagObject,
  tagUri,
  TAG_OBJECTS,
  type TagObject,
} from "./tags/flipper-nfc.js";
import { pendingCsv } from "./tags/pending-csv.js";
import {
  pushToFlipper,
  appendToFlipper,
  FLIPPER_PENDING_PATH,
  type FlipperPusher,
  type FlipperAppender,
} from "./tags/flipper-push.js";
import { tagQrDataUrl } from "./tags/qr.js";
import {
  curatorUri,
  scanIgnoredReason,
  type PatternType,
} from "@marquee/contracts";
import {
  ffmpegProber,
  ffmpegAvailable,
  VideoError,
  type VideoProber,
} from "./media/video.js";
import { ImageError } from "./media/images.js";
import { PrintError, renderCardArtPrint } from "./media/print.js";
import * as artwork from "./albums/artwork.js";
import { resolvedArtworkFile } from "./albums/artwork.js";
import { buildPalettePayload, DemoNotReadyError } from "./demo/payload.js";
import type { PromptType } from "./roadie/prompts.js";
import { BackdropClient } from "./backdrop/client.js";
import {
  BackdropSync,
  disabledBackdropSync,
  localCopyTransfer,
  httpPushTransfer,
  effectiveMediaTransferMode,
  type BackdropSyncLike,
} from "./backdrop/sync.js";
import { ConductorClient } from "./conductor/client.js";
import {
  ConductorSync,
  disabledConductorSync,
  type ConductorSyncLike,
} from "./conductor/sync.js";
import { AmpClient } from "./amp/client.js";
import { probeService } from "./runtime/probe.js";
import { describeFetchFailure } from "./net/fetch-failure.js";
import { buildSystemStatus } from "./runtime/system-status.js";
import { createLogger } from "@marquee/observability";

export interface BuildOptions {
  config?: Partial<Config>;
  store?: AssetStore;
  /**
   * Where the built UI lives. Prod resolves `../dist-ui` from this module; tests point it at a
   * temp dir so the static-serving block runs at all. It used to be unreachable under test — no
   * `dist-ui` in a test run — which is how both #183 and #241 shipped uncaught.
   */
  uiDir?: string;
  /** Injected palette generator (tests pass a fake; prod uses real Palette Press). */
  generate?: PaletteGenerator;
  /** Injected Spotify client (tests pass one backed by fake-spotify); prod builds from config. */
  spotify?: SpotifyClient;
  /** Injected Spotify user-auth (tests pass one backed by fake-spotify); prod builds from config. */
  spotifyAuth?: SpotifyAuth;
  /** Injected Discogs client (tests pass one backed by fake-discogs); prod builds from config. */
  discogs?: DiscogsClient;
  /** Injected Discogs OAuth manager (tests pass one with an injected fetch); prod builds from config. */
  discogsAuth?: DiscogsOAuth;
  /** Injected Discogs auto-sync poller (tests pass one with fake timers); prod builds from config. */
  discogsPoller?: DiscogsPoller;
  /** Injected Gemini client (tests pass one backed by fake-gemini); prod builds from config. */
  gemini?: GeminiClient;
  /** Override the opt-in generation flags (tests); prod reads them from config.gemini. */
  generateCardArt?: boolean;
  generateVideo?: boolean;
  /** Injected Roadie (tests pass one with fake time); prod builds one from store/spotify/generate. */
  roadie?: Roadie;
  /** Injected video prober (tests pass a fake); prod uses ffprobe/ffmpeg. */
  prober?: VideoProber;
  /** Injected Backdrop sync (tests point it at a stub Backdrop); prod builds one from config.backdrop. */
  backdrop?: BackdropSyncLike;
  /** Injected Conductor asset push (tests point it at a stub); prod builds one from config.conductor. */
  conductorSync?: ConductorSyncLike;
  /** Injected generation-job manager (tests may pass one with a fake clock); prod builds its own. */
  jobs?: GenerationJobs;
  /** Injected Amp client (tests pass one with a fake fetch); prod builds one from config.amp. */
  amp?: AmpClient;
  /** Injected desk audio (tests point it at a stub Spotify); prod builds one from the user session. */
  deskAudio?: DeskAudio;
  /** Injected Flipper push (tests pass a fake); prod writes to the USB-attached Flipper. */
  flipperPush?: FlipperPusher;
  /** Injected Flipper append (tests pass a fake); prod merges into the list already on the card. */
  flipperAppend?: FlipperAppender;
}

/**
 * One row of `GET /api/albums`.
 *
 * The second half of this — from `year` down — exists for the collection screen (ADR 0052). That
 * screen shows every record at once and labels each with the *first thing it still needs*, which is
 * a predicate over the assets (is a visualizer attached? are both tags written and checked?) rather
 * than a reading of `roadie.state`. Deriving it needs those facts in the list response; fetching
 * forty assets to answer one grid is not a trade worth making.
 *
 * Deliberately facts, not a verdict: the client derives the need through one shared pure module
 * (`ui/src/needs.ts`) so the collection and the record page cannot disagree about it.
 */
const summary = (a: AlbumAsset) => ({
  curatorId: a.curatorId,
  title: a.metadata.name,
  artist: a.metadata.artist,
  source: a.metadata.source,
  state: a.roadie.state,
  createdAt: a.createdAt,
  artwork: a.artwork?.resolvedPath ?? null,
  paletteColors: a.palette?.colors.length ?? 0,
  paletteInsufficient: a.roadie.flags.palette_insufficient,
  // The Demo Room lists albums with a video to swap between; palette drives the lights either way.
  hasVideo: Boolean(a.visualizer),

  year: a.metadata.year ?? null,
  genres: a.metadata.genres ?? [],
  /** In order — `[0]` is the dominant. The collection draws its art placeholder from these. */
  paletteHexes: a.palette?.colors.map((c) => c.hex) ?? [],
  hasCardArt: Boolean(a.cardArt),
  /** Both tags burned. One of two is not "written" — the record still needs a trip to the Flipper. */
  tagsWritten: Boolean(a.tag?.sleeve?.written && a.tag?.card?.written),
  previewApprovedAt: a.verification?.previewApprovedAt ?? null,
  physicallyVerifiedAt: a.verification?.physicallyVerifiedAt ?? null,
  /** What Roadie is doing right now, so the grid can narrate ("finding the sleeve") in place. */
  subState: a.roadie.subState,
  lastError: a.roadie.lastError,
});

// A newly-added album has only been queued — palette/prompts land later, off the request path.
const created = (reply: FastifyReply, curatorId: string, asset: AlbumAsset) =>
  reply.code(201).send({
    curatorId,
    source: asset.metadata.source,
    state: asset.roadie.state,
  });

// Map a SpotifyError to an HTTP status: pass through 404/504, everything else is a bad gateway.
const spotifyStatus = (err: SpotifyError): number =>
  err.status === 404 ? 404 : err.status === 504 ? 504 : 502;

// Map a DiscogsError to an HTTP status (same policy as Spotify): pass through 404/504, else 502.
const discogsStatus = (err: DiscogsError): number =>
  err.status === 404 ? 404 : err.status === 504 ? 504 : 502;

// For the read-only GET routes: send DiscogsErrors, rethrow anything else.
const discogsErr = (err: unknown, reply: FastifyReply) => {
  if (err instanceof DiscogsError)
    return reply.code(discogsStatus(err)).send({ error: err.message });
  throw err;
};

// For the read-only GET routes: send SpotifyErrors, rethrow anything else.
const spotifyErr = (err: unknown, reply: FastifyReply) => {
  if (err instanceof SpotifyError)
    return reply.code(spotifyStatus(err)).send({ error: err.message });
  throw err;
};

// The tiny page the OAuth redirect lands on. Self-contained (the callback is hit in the system
// browser, outside the SPA), and it escapes the message since it can carry a provider error string.
const escapeHtml = (s: string): string =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );

const callbackHtml = (message: string, ok = false): string =>
  `<!doctype html><html><head><meta charset="utf-8"><title>Marquee — Spotify</title>` +
  `<style>body{font-family:system-ui,sans-serif;background:#14110f;color:#f4efe9;` +
  `display:grid;place-items:center;height:100vh;margin:0}main{max-width:28rem;text-align:center;` +
  `padding:2rem}h1{font-size:1.25rem}p{color:#b8afaf}</style></head><body><main>` +
  `<h1>${ok ? "✓ Connected" : "Spotify"}</h1><p>${escapeHtml(message)}</p></main></body></html>`;

// Map an onboarding-action error to a status: not found → 404, bad input → 400, illegal state
// transition → 409, rejected media → 422, over the upload ceiling → 413; anything else is an
// unexpected 500. `maxUploadBytes` is only needed by the multipart handlers, so it's optional.
const actionError = (
  err: unknown,
  reply: FastifyReply,
  req: FastifyRequest,
  maxUploadBytes?: number,
) => {
  if (err instanceof NotFoundError)
    return reply.code(404).send({ error: err.message });
  if (err instanceof ValidationError)
    return reply.code(400).send({ error: err.message });
  if (err instanceof TransitionError || err instanceof PaletteConflictError)
    return reply.code(409).send({ error: err.message });
  if (err instanceof VideoError || err instanceof ImageError)
    return reply.code(422).send({ error: err.message });
  // The card-art print render (ADR 0042). Two failures, two codes: no ffmpeg on this workstation is a
  // 503 (the art is fine, the pipeline isn't); ffmpeg rejecting the art is a 422, like any other bad
  // media. `reason` carries ffmpeg's own words so the UI can show what actually went wrong.
  if (err instanceof PrintError)
    return reply.code(err.kind === "unavailable" ? 503 : 422).send({
      error:
        err.kind === "unavailable"
          ? "print rendering needs ffmpeg, which isn't available"
          : "could not render the print version",
      reason: err.message,
    });
  // @fastify/multipart aborts an over-ceiling file mid-stream. That's the caller sending too much,
  // not a server fault — answer 413 and name the limit so they know what to aim under (issue #12).
  if ((err as { code?: string }).code === "FST_REQ_FILE_TOO_LARGE")
    return reply.code(413).send({
      error: maxUploadBytes
        ? `file too large — the upload limit is ${Math.round(maxUploadBytes / 1024 / 1024)} MB`
        : "file too large",
    });
  req.log.error(err);
  return reply.code(500).send({ error: (err as Error).message });
};

/**
 * Stream a multipart request to disk (issue #16): plain fields are collected in memory, but the
 * single file part is piped straight to a temp file under /incoming/ rather than buffered — so a
 * multi-GB visualizer video is bytes-to-disk, not a heap allocation, and the upload ceiling is a
 * disk/policy limit instead of a memory-safety knob. The returned temp file belongs to the *caller*,
 * which must remove it (the routes do so in a `finally`). An over-ceiling file is truncated
 * mid-stream by @fastify/multipart (`part.file.truncated`); we surface that as its 413 error so the
 * caller sees a clean "too large" and the partial temp is cleaned up (issue #12).
 */
async function readUpload(
  req: FastifyRequest,
  store: AssetStore,
): Promise<{
  fields: Record<string, string>;
  file?: { path: string; filename: string; size: number };
}> {
  mkdirSync(store.paths.incoming, { recursive: true });
  const tmp = store.paths.incomingFile(`.upload-${randomUUID()}`);
  const fields: Record<string, string> = {};
  let file: { path: string; filename: string; size: number } | undefined;
  try {
    for await (const part of req.parts()) {
      if (part.type === "file") {
        const sink = createWriteStream(tmp);
        await pipeline(part.file, sink);
        if (part.file.truncated)
          throw new req.server.multipartErrors.RequestFileTooLargeError();
        file = { path: tmp, filename: part.filename, size: sink.bytesWritten };
      } else fields[part.fieldname] = String(part.value);
    }
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
  return { fields, file };
}

/** Minimal per-album row for the queue view, with the timestamp it entered its current state. */
const queueEntry = (a: AlbumAsset) => ({
  curatorId: a.curatorId,
  title: a.metadata.name,
  artist: a.metadata.artist,
  artwork: a.artwork?.resolvedPath ?? null,
  state: a.roadie.state,
  subState: a.roadie.subState,
  enteredStateAt: a.roadie.history.at(-1)?.at ?? a.createdAt,
  lastError: a.roadie.lastError,
  flags: a.roadie.flags,
});

const DONE_RECENTLY_CAP = 20;

/** Group every album by the human-facing bucket the queue view renders (roadie-spec §11). */
function buildQueue(store: AssetStore) {
  const groups: Record<string, ReturnType<typeof queueEntry>[]> = {
    awaiting_review: [],
    awaiting_video: [],
    awaiting_preview: [],
    awaiting_tag_write: [],
    awaiting_verify: [],
    processing: [],
    errored: [],
    needs_manual: [],
    done_recently: [],
  };
  // Bucketing is shared with the peer walk (issue #94) so "next album at this state" can never
  // disagree with the list you were just looking at.
  for (const asset of store.list())
    groups[bucketFor(asset.roadie.state)]!.push(queueEntry(asset));
  groups.done_recently = groups.done_recently!.slice(0, DONE_RECENTLY_CAP);
  return groups;
}

/** The buckets that count as "needs you right now" — drives the browser-tab badge (spec §10). */
const NEEDS_YOU = [
  "awaiting_review",
  "awaiting_video",
  "awaiting_preview",
  "awaiting_tag_write",
  "awaiting_verify",
] as const;

/** Per-bucket counts + the "needs you right now" total for the tab-title indicator (spec §10). */
function queueCounts(store: AssetStore) {
  const groups = buildQueue(store);
  const counts = Object.fromEntries(
    Object.entries(groups).map(([k, v]) => [k, v.length]),
  );
  const needsYou = NEEDS_YOU.reduce((n, k) => n + (counts[k] ?? 0), 0);
  return { counts, needsYou };
}

/**
 * Should an unmatched request be answered with `index.html` (a client-side route) or a real 404?
 *
 * Only client routes get the fallback. Anything that looks like a **file** must 404, because the
 * alternative is silent and catastrophic: answering an asset miss with `index.html` makes the browser
 * execute HTML as a module script — React never mounts and Curator renders a solid black window with
 * nothing in any log ([#183](https://github.com/dylanleatham/Marquee/issues/183)). A 404 puts the real
 * filename in the console instead.
 *
 * Pure and exported so it is unit-testable, and now covered end-to-end besides: `opts.uiDir` lets
 * `test/ui-static.test.ts` exercise the `if (existsSync(uiDir))` block that used to be skipped
 * entirely under test (no `dist-ui` in a test run) — which is how #183 shipped uncaught, and #241
 * after it.
 *
 * **Restarting Curator after a UI build is no longer required** ([ADR 0053](../../../docs/adrs/0053-the-ui-is-served-per-request-not-enumerated-at-boot.md)):
 * static files and `index.html` are both resolved per request. Forgetting to restart used to mean a
 * blank window, which is the bug this note previously only made *obvious* rather than prevented.
 */
export function servesSpaFallback(method: string, url: string): boolean {
  if (method !== "GET") return false;
  const path = url.split("?")[0] ?? "";
  if (path.startsWith("/api")) return false;
  // A client route never carries a file extension; every static asset does.
  if (/\.[a-z0-9]+$/i.test(path)) return false;
  return true;
}

export function buildServer(opts: BuildOptions = {}) {
  const config = loadConfig(opts.config);
  const store = opts.store ?? new AssetStore(config.dataDir);
  const gemini =
    opts.gemini ??
    (config.gemini ? new GeminiClient(config.gemini) : undefined);
  const app = Fastify({
    logger: { level: process.env.NODE_ENV === "test" ? "silent" : "info" },
  });

  // Spotify user login (issue #23): the auth manager owns the PKCE handshake + refresh token; the
  // client prefers a connected user's token and falls back to the app (client-credentials) token.
  const spotifyAuth =
    opts.spotifyAuth ??
    (config.spotify
      ? new SpotifyAuth({
          clientId: config.spotify.clientId,
          redirectUri: config.spotify.redirectUri,
          dataDir: config.dataDir,
        })
      : undefined);
  // A connected user's token, or undefined to fall back to app-token catalog reads. A broken/expired
  // session degrades to the fallback (logged) rather than hard-failing an otherwise-public read.
  const userTokenOrNull = async (): Promise<string | undefined> => {
    if (!spotifyAuth) return undefined;
    try {
      return await spotifyAuth.userAccessToken();
    } catch (err) {
      app.log.warn(
        `Spotify user token unavailable, falling back to app token: ${(err as Error).message}`,
      );
      return undefined;
    }
  };
  const spotify =
    opts.spotify ??
    (config.spotify
      ? new SpotifyClient({ ...config.spotify, getUserToken: userTokenOrNull })
      : undefined);
  // Desk audio for bench preview (ADR 0037): the same user session, used for Connect transport
  // rather than catalog reads. Built whenever a session *could* exist — "not connected" is a reason
  // the route reports, not a reason to omit the feature.
  const deskAudio =
    opts.deskAudio ??
    (spotifyAuth
      ? new DeskAudio({ getUserToken: userTokenOrNull })
      : undefined);
  // Discogs OAuth 1.0a "log in with Discogs" (issue #59): built whenever consumer creds are
  // configured. The client prefers a connected OAuth session's signed header and falls back to the
  // personal token
  // ([ADR 0017](../../../docs/adrs/0017-discogs-personal-token-and-direct-images.md)) — so both
  // auth mechanisms coexist behind one DiscogsClient.
  const discogsAuth =
    opts.discogsAuth ??
    (config.discogs?.consumerKey &&
    config.discogs?.consumerSecret &&
    config.discogs?.callbackUrl
      ? new DiscogsOAuth({
          consumerKey: config.discogs.consumerKey,
          consumerSecret: config.discogs.consumerSecret,
          callbackUrl: config.discogs.callbackUrl,
          dataDir: config.dataDir,
        })
      : undefined);
  // Absent both token and OAuth → the collection/add routes 503.
  const discogs =
    opts.discogs ??
    (config.discogs && (config.discogs.token || discogsAuth)
      ? new DiscogsClient({
          ...(config.discogs.token ? { token: config.discogs.token } : {}),
          ...(discogsAuth
            ? { authHeader: () => discogsAuth.apiAuthHeader() }
            : {}),
        })
      : undefined);
  // Resolve the collection username once: the configured value wins; otherwise ask the token's
  // identity and cache it (a token maps to exactly one user, so this never changes at runtime).
  let discogsUsername: string | undefined = config.discogs?.username;
  const resolveDiscogsUsername = async (): Promise<string> => {
    if (discogsUsername) return discogsUsername;
    if (!discogs) throw new DiscogsError("Discogs not configured", 503);
    discogsUsername = (await discogs.getIdentity()).username;
    return discogsUsername;
  };
  const roadie =
    opts.roadie ??
    new Roadie({
      store,
      spotify,
      discogs,
      gemini,
      generate: opts.generate,
      logger: {
        info: (m) => app.log.info(m),
        warn: (m) => app.log.warn(m),
        error: (m) => app.log.error(m),
      },
    });
  const prober = opts.prober ?? ffmpegProber;
  // Opt-in generation flags (default off). Prod reads config.gemini; tests may override.
  const genCardArt =
    opts.generateCardArt ?? config.gemini?.generateCardArt ?? false;
  const genVideo = opts.generateVideo ?? config.gemini?.generateVideo ?? false;
  const actionDeps: ActionDeps = {
    store,
    prober,
    gemini,
    generate: opts.generate,
    generateCardArt: genCardArt,
    generateVideo: genVideo,
  };
  // Background jobs for the long-running AI generation actions (issue #30 / ADR 0018): the generate
  // routes enqueue here and return a jobId instead of holding the request open for minutes. Persisted
  // to a small on-disk log (issue #57) so recent jobs survive a restart — a job left running when the
  // process died is restored as failed (its runner is gone), not a zombie.
  const jobs =
    opts.jobs ??
    new GenerationJobs({
      store: new FileJobStore(join(config.dataDir, "generation-jobs.json")),
    });
  // Backdrop sync (step 9). Off unless a Backdrop URL is configured — then video attach/detach and
  // the manual resync/verify routes push Curator's library projection to Backdrop (roadie-spec §6).
  const backdrop: BackdropSyncLike =
    opts.backdrop ??
    (config.backdrop
      ? (() => {
          const backdropClient = new BackdropClient({
            url: config.backdrop.url,
            ...(config.backdrop.sharedSecret
              ? { sharedSecret: config.backdrop.sharedSecret }
              : {}),
          });
          // ADR 0038: `none` leaves the file to an out-of-band rsync (unchanged), `local` copies it
          // on this machine, `push` streams it to Backdrop.
          //
          // `loadConfig` always sets `mediaTransfer`, but a caller building a config object directly
          // (tests, embedders) may still set only the legacy `syncMediaLocally`. Falling back to it
          // keeps the ADR's promise that the boolean goes on working — a config that says "copy
          // locally" and is silently ignored is worse than one that is rejected.
          const mode = effectiveMediaTransferMode(config.backdrop);
          const transfer =
            mode === "local"
              ? localCopyTransfer(config.backdrop.mediaDir)
              : mode === "push"
                ? httpPushTransfer(backdropClient)
                : undefined;
          return new BackdropSync({
            store,
            client: backdropClient,
            backdropMediaDir: config.backdrop.mediaDir,
            ...(transfer ? { mediaTransfer: transfer } : {}),
            logger: {
              info: (m) => app.log.info(m),
              warn: (m) => app.log.warn(m),
            },
          });
        })()
      : disabledBackdropSync);
  // Conductor asset push (ADR 0045). Off unless a Conductor URL was explicitly configured — the
  // `conductor.url` default exists for the Demo Room proxy, and pushing to it on a workstation with
  // no runtime would put an unreachable-syncIssue on every album.
  const conductorSync: ConductorSyncLike =
    opts.conductorSync ??
    (config.conductor.pushAssets
      ? new ConductorSync({
          store,
          client: new ConductorClient({
            url: config.conductor.url,
            ...(config.conductor.sharedSecret
              ? { sharedSecret: config.conductor.sharedSecret }
              : {}),
          }),
          logger: {
            info: (m) => app.log.info(m),
            warn: (m) => app.log.warn(m),
          },
        })
      : disabledConductorSync);
  // Amp — the room rehearsal's audio leg (ADR 0028). Absent unless an Amp URL is configured; the
  // rehearsal then reports audio as unconfigured rather than failing (lights + video still run).
  const amp: AmpClient | undefined =
    opts.amp ??
    (config.amp
      ? new AmpClient({
          url: config.amp.url,
          ...(config.amp.sharedSecret
            ? { sharedSecret: config.amp.sharedSecret }
            : {}),
        })
      : undefined);
  // Upload ceiling comes from config (default 2 GB) — visualizer videos are the large uploads;
  // cover/card art are tiny. Over-ceiling uploads surface as a 413 via actionError (issue #12).
  app.register(multipart, { limits: { fileSize: config.maxUploadBytes } });

  // `service` / `instance` / `dataDir` are the desktop shell's identity check (issue #229): a 200
  // only proves something is listening, so the shell needs to know *which* Curator this is and
  // which collection it is rooted at before it will drive it. `instance` is null for any Curator
  // not started by a shell — hand-run dev servers, the Pi — which is exactly the "not ours" answer.
  app.get("/healthz", async () => ({
    ok: true,
    service: "curator",
    instance: process.env.MARQUEE_INSTANCE_ID ?? null,
    dataDir: config.dataDir,
    albums: store.list().length,
    spotify: Boolean(spotify),
    discogs: Boolean(discogs),
    gemini: Boolean(gemini),
    roadie: roadie.status(),
  }));

  app.get("/api/albums", async () => ({ albums: store.list().map(summary) }));

  app.get("/api/albums/:curatorId", async (req, reply) => {
    const { curatorId } = req.params as { curatorId: string };
    const asset = store.read(curatorId);
    return asset ?? reply.code(404).send({ error: "not found" });
  });

  // Flipper Zero tag authoring (issue #67, "Route A"): download a ready-to-write `.nfc` for an album,
  // and list the albums awaiting a tag write so you know which to fetch. Drop the `.nfc` on the
  // Flipper's SD card and write it to a blank NTAG213 via the stock NFC app (Saved → Write).
  const pendingRows = () =>
    store
      .list()
      .filter((a) => a.roadie.state === "awaiting_tag_write")
      .map((a) => ({
        curatorId: a.curatorId,
        name: a.metadata.name,
        artist: a.metadata.artist,
      }));

  app.get("/api/tags/pending", async () => ({ pending: pendingRows() }));

  // The same list as a CSV for the Flipper app (issue #68, "Route B"): download it and drop it at
  // /ext/apps_data/marquee_tag_writer/pending.csv on the Flipper's SD card, and the app lists those
  // albums on-device. Spec: docs/specs/flipper-tag-writer.md §3.
  app.get("/api/tags/pending.csv", async (_req, reply) => {
    reply.header("content-disposition", 'attachment; filename="pending.csv"');
    reply.type("text/csv; charset=utf-8");
    return pendingCsv(pendingRows());
  });

  // One click instead of download-then-drag: write that same CSV straight onto the SD card of a
  // Flipper attached to this machine over USB. 503 (not 500) when there is no Flipper or the port is
  // busy — nothing is wrong with Curator, the hardware just isn't there, and the message says so.
  const flipperPush = opts.flipperPush ?? pushToFlipper;

  /**
   * **Add** one album to the list on the Flipper, from its Ship tab. Appends rather than replaces —
   * working through records one at a time builds the on-device menu up, and the batch route below is
   * what you use when you mean "the list is exactly this". Re-sending the same album updates its row
   * instead of duplicating it.
   *
   * Deliberately not state-filtered the way the batch route is: you named this album, so one that
   * hasn't reached `awaiting_tag_write` can still be sent.
   */
  const flipperAppend = opts.flipperAppend ?? appendToFlipper;
  app.post("/api/albums/:curatorId/push-to-flipper", async (req, reply) => {
    const { curatorId } = req.params as { curatorId: string };
    const asset = store.read(curatorId);
    if (!asset) return reply.code(404).send({ error: "not found" });
    try {
      const result = await flipperAppend([
        {
          curatorId,
          name: asset.metadata.name,
          artist: asset.metadata.artist,
        },
      ]);
      return { ok: true, ...result };
    } catch (err) {
      return reply.code(503).send({
        ok: false,
        error: (err as Error).message,
        path: FLIPPER_PENDING_PATH,
      });
    }
  });

  app.post("/api/tags/push-to-flipper", async (_req, reply) => {
    const rows = pendingRows();
    try {
      const result = await flipperPush(pendingCsv(rows));
      return { ok: true, albums: rows.length, ...result };
    } catch (err) {
      return reply.code(503).send({
        ok: false,
        error: (err as Error).message,
        path: FLIPPER_PENDING_PATH,
      });
    }
  });

  /**
   * `?object=card` writes a card tag (`curator:card:<id>`), `?object=demo` a demo tag
   * (`curator:demo:<id>`, ADR 0058); anything else — including a typo — is the sleeve. Falling back
   * rather than 400ing is deliberate and predates the demo kind: this URL is typed by hand and
   * pasted into a browser, and the sleeve is the safe default. The `?object=` value is echoed in the
   * filename, so a mistyped one is visible in the download rather than silently substituted.
   */
  app.get("/api/albums/:curatorId/tag.nfc", async (req, reply) => {
    const { curatorId } = req.params as { curatorId: string };
    const requested = (req.query as { object?: string }).object;
    const object: TagObject = isTagObject(requested) ? requested : "sleeve";
    if (!store.read(curatorId))
      return reply.code(404).send({ error: "not found" });
    const filename =
      object === "sleeve" ? `${curatorId}.nfc` : `${curatorId}-${object}.nfc`;
    reply.header("content-disposition", `attachment; filename="${filename}"`);
    reply.type("application/octet-stream");
    return flipperNfcFile(curatorId, object);
  });

  /**
   * The exact string to burn into a sticker, plus a QR of it (issue #102). Both tag-writing paths
   * are first class: the Flipper takes the `.nfc` above, and a phone points at this QR to land the
   * URI in NFC Tools without anyone retyping an 8-character base32 id — a mistake that fails
   * *silently*, since the tag writes fine and simply never resolves at scan time.
   *
   * Composed server-side so there is one source of truth for the string; the UI no longer builds it.
   */
  app.get("/api/albums/:curatorId/tag-payload", async (req, reply) => {
    const { curatorId } = req.params as { curatorId: string };
    const requested = (req.query as { object?: string }).object;
    const object: TagObject = isTagObject(requested) ? requested : "sleeve";
    const asset = store.read(curatorId);
    if (!asset) return reply.code(404).send({ error: "not found" });
    // A sleeve keeps any payload already recorded on the asset, so a tag written before this route
    // existed still round-trips; card and demo are always derived (ADR 0034 / ADR 0058).
    const payload =
      object === "sleeve"
        ? (asset.tag?.payload ?? curatorUri("album", curatorId))
        : tagUri(curatorId, object);
    return {
      object,
      payload,
      qrDataUrl: await tagQrDataUrl(payload),
    };
  });

  app.delete("/api/albums/:curatorId", async (req, reply) => {
    const { curatorId } = req.params as { curatorId: string };
    if (!store.delete(curatorId))
      return reply.code(404).send({ error: "not found" });
    // Drop it from Backdrop too so a stale scan doesn't resolve to a now-deleted album (best-effort).
    await backdrop.removeAlbum(curatorId);
    return { deleted: curatorId };
  });

  // Serve an album's cover art (the UI shows a thumbnail per row, polled every 2s). Validate the
  // id shape ourselves — no path-traversal surface — and stream the bytes rather than a synchronous
  // read, so this hot path never blocks the event loop Roadie also runs on. 404 until art exists.
  app.get("/api/albums/:curatorId/artwork", async (req, reply) => {
    const { curatorId } = req.params as { curatorId: string };
    if (!isCuratorId(curatorId))
      return reply.code(404).send({ error: "not found" });
    const asset = store.read(curatorId);
    // The *active* cover: an uploaded override wins over the fetched art (issue #100).
    const file = asset
      ? resolvedArtworkFile(store, asset)
      : store.paths.artworkFile(curatorId);
    if (!existsSync(file))
      return reply.code(404).send({ error: "artwork not available yet" });
    return reply
      .header(
        "content-type",
        file.endsWith(".png") ? "image/png" : "image/jpeg",
      )
      .header("cache-control", "no-cache")
      .send(createReadStream(file));
  });

  /**
   * Upload a cover that takes precedence over the fetched one (issue #100, milestone 15).
   *
   * `regeneratePalette` decides what happens to the palette. It defaults to **true**, except when the
   * palette was hand-edited — there the default is to keep the edit, because curator-spec §12 is
   * explicit that a hand-edit is never discarded without user action. The UI asks first and sends the
   * answer, so the confirm happens before the upload rather than as a failed round-trip.
   */
  app.post("/api/albums/:curatorId/artwork/override", async (req, reply) => {
    const { curatorId } = req.params as { curatorId: string };
    if (!req.isMultipart())
      return reply.code(400).send({ error: "expected multipart/form-data" });
    try {
      const existing = store.read(curatorId);
      if (!existing) return reply.code(404).send({ error: "not found" });
      const { fields, file } = await readUpload(req, store);
      try {
        if (!file || file.size === 0)
          return reply.code(400).send({ error: "an image file is required" });
        const asset = artwork.applyArtworkOverride(
          store,
          curatorId,
          readFileSync(file.path),
        );
        const handEdited = existing.palette?.handEdited === true;
        const wants =
          fields.regeneratePalette === undefined
            ? !handEdited
            : fields.regeneratePalette !== "false";
        if (!wants)
          return reply
            .code(201)
            .send({ artwork: asset.artwork, paletteRegenerated: false });
        const regenerated = await actions.regeneratePalette(
          actionDeps,
          curatorId,
          true,
        );
        return reply.code(201).send({
          artwork: regenerated.artwork,
          palette: regenerated.palette,
          paletteRegenerated: true,
        });
      } finally {
        if (file) rmSync(file.path, { force: true });
      }
    } catch (err) {
      return actionError(err, reply, req, config.maxUploadBytes);
    }
  });

  /** Drop the override and fall back to the fetched cover, re-deriving the palette from it. */
  app.delete("/api/albums/:curatorId/artwork/override", async (req, reply) => {
    const { curatorId } = req.params as { curatorId: string };
    const { regeneratePalette } = (req.query ?? {}) as {
      regeneratePalette?: string;
    };
    try {
      const asset = artwork.removeArtworkOverride(store, curatorId);
      if (!asset)
        return reply
          .code(404)
          .send({ error: "this album has no artwork override" });
      // Same hand-edit protection as the upload path, expressed as a query param.
      if (regeneratePalette === "false" || !asset.artwork)
        return reply.send({
          artwork: asset.artwork,
          paletteRegenerated: false,
        });
      const regenerated = await actions.regeneratePalette(
        actionDeps,
        curatorId,
        true,
      );
      return reply.send({
        artwork: regenerated.artwork,
        palette: regenerated.palette,
        paletteRegenerated: true,
      });
    } catch (err) {
      return actionError(err, reply, req);
    }
  });

  // Stream a media file by absolute path, or 404. `download` sets a Content-Disposition attachment.
  const sendFile = (
    reply: FastifyReply,
    file: string,
    contentType: string,
    download?: string,
  ) => {
    if (!existsSync(file))
      return reply.code(404).send({ error: "not available yet" });
    reply
      .header("content-type", contentType)
      .header("cache-control", "no-cache");
    if (download)
      reply.header("content-disposition", `attachment; filename="${download}"`);
    return reply.send(createReadStream(file));
  };

  app.get("/api/albums/:curatorId/video", async (req, reply) => {
    const { curatorId } = req.params as { curatorId: string };
    if (!isCuratorId(curatorId))
      return reply.code(404).send({ error: "not found" });
    return sendFile(reply, store.paths.visualizerFile(curatorId), "video/mp4");
  });

  app.get("/api/albums/:curatorId/thumbnail", async (req, reply) => {
    const { curatorId } = req.params as { curatorId: string };
    if (!isCuratorId(curatorId))
      return reply.code(404).send({ error: "not found" });
    return sendFile(reply, store.paths.thumbnailFile(curatorId), "image/jpeg");
  });

  // A generated visualizer clip + its poster (fileId = {curatorId}-v{index}).
  app.get("/api/albums/:curatorId/video/clip/:index", async (req, reply) => {
    const { curatorId, index } = req.params as {
      curatorId: string;
      index: string;
    };
    const asset = store.read(curatorId);
    const clip = asset?.videoClips?.find((c) => c.index === Number(index));
    if (!clip) return reply.code(404).send({ error: "no such clip" });
    return sendFile(
      reply,
      store.paths.visualizerFile(clip.fileId),
      "video/mp4",
      // A download filename so the clip-gallery download links save a sensible name.
      (req.query as { download?: string }).download
        ? `${curatorId}-clip-${clip.index}.mp4`
        : undefined,
    );
  });

  app.get(
    "/api/albums/:curatorId/video/clip/:index/thumbnail",
    async (req, reply) => {
      const { curatorId, index } = req.params as {
        curatorId: string;
        index: string;
      };
      const asset = store.read(curatorId);
      const clip = asset?.videoClips?.find((c) => c.index === Number(index));
      if (!clip) return reply.code(404).send({ error: "no such clip" });
      return sendFile(
        reply,
        store.paths.thumbnailFile(clip.fileId),
        "image/jpeg",
      );
    },
  );

  app.get("/api/albums/:curatorId/card-art", async (req, reply) => {
    const { curatorId } = req.params as { curatorId: string };
    const asset = store.read(curatorId);
    if (!asset?.cardArt) return reply.code(404).send({ error: "no card art" });
    const { ext } = asset.cardArt;
    return sendFile(
      reply,
      store.paths.cardArtFile(curatorId, ext),
      ext === "png" ? "image/png" : "image/jpeg",
    );
  });

  // A generated candidate image (before one is promoted to the attached card art).
  app.get(
    "/api/albums/:curatorId/card-art/candidate/:index",
    async (req, reply) => {
      const { curatorId, index } = req.params as {
        curatorId: string;
        index: string;
      };
      const asset = store.read(curatorId);
      const candidate = asset?.cardArtCandidates?.find(
        (c) => c.index === Number(index),
      );
      if (!candidate)
        return reply.code(404).send({ error: "no such candidate" });
      return sendFile(
        reply,
        store.paths.cardArtFile(candidate.fileId, candidate.ext),
        candidate.ext === "png" ? "image/png" : "image/jpeg",
      );
    },
  );

  /**
   * Print version: the stored art rendered to business-card dimensions at 300 DPI — 1050x600 (or
   * 600x1050 for portrait art), `?bleed=1` for the 1125x675 version with the printer's trim
   * allowance. Off-size art is scaled to cover and centre-cropped ([ADR 0042](docs/adrs), issue #98).
   *
   * Failures go through `actionError` like every other action: a missing ffmpeg is a 503, ffmpeg
   * rejecting the art is a 422 (see the PrintError branch there). Reporting a missing dependency as
   * a bad file sends you looking in the wrong place.
   */
  app.get("/api/albums/:curatorId/card-art/print", async (req, reply) => {
    const { curatorId } = req.params as { curatorId: string };
    const asset = store.read(curatorId);
    if (!asset?.cardArt) return reply.code(404).send({ error: "no card art" });
    const file = store.paths.cardArtFile(curatorId, asset.cardArt.ext);
    // No `existsSync` precheck: the render opens the file anyway, so a check here would only add a
    // window in which a concurrent `detach-card-art?delete=1` turns a 404 into a 422. ENOENT from the
    // open *is* the missing-file answer.
    // `CardArtSection.ext` is a plain string on the asset; narrow the same way the sibling routes
    // pick a content type — png is png, anything else is treated as JPEG.
    const ext = asset.cardArt.ext === "png" ? "png" : "jpg";
    // Matches the `?download=1` convention on the clip routes: present-and-1 is on, anything else off.
    const bleed = (req.query as { bleed?: string }).bleed === "1";
    try {
      const print = await renderCardArtPrint({}, { file, ext, bleed });
      return reply
        .header("content-type", print.contentType)
        .header("cache-control", "no-cache")
        .header(
          "content-disposition",
          `attachment; filename="${curatorId}-card-print${bleed ? "-bleed" : ""}.${print.ext}"`,
        )
        .send(print.bytes);
    } catch (err) {
      // The art the asset points at isn't on disk (or a concurrent detach deleted it) — the same 404
      // the other media routes give via sendFile's existsSync. Kept local rather than folded into
      // actionError: teaching every action route that ENOENT means 404 would hide real faults.
      if ((err as NodeJS.ErrnoException).code === "ENOENT")
        return reply.code(404).send({ error: "not available yet" });
      return actionError(err, reply, req);
    }
  });

  // --- Palette actions (curator-spec §Palettes) ---
  // Set a hand-edited palette (order is authoritative — first swatch is the dominant/primary).
  app.put("/api/albums/:curatorId/palette", async (req, reply) => {
    const { curatorId } = req.params as { curatorId: string };
    const { colors } = (req.body ?? {}) as { colors?: unknown };
    try {
      const asset = actions.editPalette(
        actionDeps,
        curatorId,
        colors as PaletteEditColor[],
      );
      return { palette: asset.palette };
    } catch (err) {
      return actionError(err, reply, req);
    }
  });

  /**
   * Override this album's motion with one of the seven pattern types, or return it to the derived
   * pattern with `{ type: null }` (ADR 0039). The derived `pattern` is untouched either way — this
   * is a choice stored beside it, not an edit of it. See actions.setPatternOverride.
   */
  app.put("/api/albums/:curatorId/pattern-override", async (req, reply) => {
    const { curatorId } = req.params as { curatorId: string };
    const body = (req.body ?? {}) as { type?: unknown; params?: unknown };
    try {
      const asset = actions.setPatternOverride(
        actionDeps,
        curatorId,
        (body.type ?? null) as PatternType | null,
        // Distinguish "params omitted" (leave tuning alone) from "params: {}" (reset to defaults),
        // so a caller flipping the type doesn't have to restate the knobs.
        "params" in body ? body.params : undefined,
      );
      return {
        patternOverride: asset.patternOverride ?? null,
        patternOverrideParams: asset.patternOverrideParams ?? {},
        pattern: asset.pattern,
      };
    } catch (err) {
      return actionError(err, reply, req);
    }
  });

  // Drop the hand-edit flag without changing colors (a later generate/batch may then replace it).
  app.post("/api/albums/:curatorId/palette/reset", async (req, reply) => {
    const { curatorId } = req.params as { curatorId: string };
    try {
      const asset = actions.resetPalette(actionDeps, curatorId);
      return { palette: asset.palette };
    } catch (err) {
      return actionError(err, reply, req);
    }
  });

  // Re-run Palette Press from the cover art. Skips a hand-edited palette unless ?force=1 (→ 409).
  /**
   * Propose colours from how the album *sounds* (ADR 0030 / issue #105). Two Gemini calls, invoked
   * by a button press — never by the pipeline or a sweep (ADR 0027). Stores candidates and changes
   * nothing else, so pressing it can't cost you the palette you have.
   */
  app.post("/api/albums/:curatorId/palette/feeling", async (req, reply) => {
    const { curatorId } = req.params as { curatorId: string };
    try {
      const asset = await actions.proposeFeelingPalette(actionDeps, curatorId);
      return { candidates: asset.paletteCandidates };
    } catch (err) {
      return actionError(err, reply, req);
    }
  });

  /**
   * Apply one of the offered palettes (ADR 0030). `cover` re-extracts and drops the protection —
   * the true undo; `feeling`/`blend` take the stored candidate and mark the palette chosen, so the
   * library sweep leaves it alone. Motion is re-derived from whichever palette wins (ADR 0033).
   */
  app.post("/api/albums/:curatorId/palette/choose", async (req, reply) => {
    const { curatorId } = req.params as { curatorId: string };
    const { source } = (req.body ?? {}) as { source?: string };
    if (source !== "cover" && source !== "feeling" && source !== "blend")
      return reply
        .code(400)
        .send({ error: "source must be cover, feeling or blend" });
    try {
      const asset = await actions.choosePalette(actionDeps, curatorId, source);
      return { palette: asset.palette, pattern: asset.pattern };
    } catch (err) {
      return actionError(err, reply, req);
    }
  });

  app.post("/api/albums/:curatorId/palette/generate", async (req, reply) => {
    const { curatorId } = req.params as { curatorId: string };
    const force = (req.query as { force?: string }).force === "1";
    try {
      const asset = await actions.regeneratePalette(
        actionDeps,
        curatorId,
        force,
      );
      return { palette: asset.palette, pattern: asset.pattern };
    } catch (err) {
      return actionError(err, reply, req);
    }
  });

  // --- Prompt actions (curator-spec §Prompts) ---
  app.post(
    "/api/albums/:curatorId/prompts/:type/copied",
    async (req, reply) => {
      const { curatorId, type } = req.params as {
        curatorId: string;
        type: PromptType;
      };
      try {
        const asset = actions.markPromptCopied(actionDeps, curatorId, type);
        return { state: asset.roadie.state };
      } catch (err) {
        return actionError(err, reply, req);
      }
    },
  );

  // Choose which drafted variant is active (the one Copy hands off / generation uses).
  app.post(
    "/api/albums/:curatorId/prompts/:type/select",
    async (req, reply) => {
      const { curatorId, type } = req.params as {
        curatorId: string;
        type: PromptType;
      };
      const { index } = (req.body ?? {}) as { index?: number };
      try {
        const asset = actions.selectPromptVariant(
          actionDeps,
          curatorId,
          type,
          Number(index),
        );
        return { promptDrafts: asset.promptDrafts };
      } catch (err) {
        return actionError(err, reply, req);
      }
    },
  );

  // Draft a prompt type on demand — the lazy replacement for Roadie's old `drafting_prompts` step
  // (ADR 0027). Prefers Gemini, falls back to templates, so it can't fail on a missing key.
  app.post("/api/albums/:curatorId/prompts/:type/draft", async (req, reply) => {
    const { curatorId, type } = req.params as {
      curatorId: string;
      type: PromptType;
    };
    try {
      const asset = await actions.draftPrompt(actionDeps, curatorId, type);
      return { promptDrafts: asset.promptDrafts };
    } catch (err) {
      return actionError(err, reply, req);
    }
  });

  // Regenerate one prompt as a fresh grounded LLM variant set (on-demand "Regenerate with AI").
  app.post(
    "/api/albums/:curatorId/prompts/:type/regenerate-ai",
    async (req, reply) => {
      const { curatorId, type } = req.params as {
        curatorId: string;
        type: PromptType;
      };
      try {
        const asset = await actions.regeneratePromptWithAI(
          actionDeps,
          curatorId,
          type,
        );
        return { promptDrafts: asset.promptDrafts };
      } catch (err) {
        return actionError(err, reply, req);
      }
    },
  );

  // --- Video: upload / incoming / attach / detach ---
  /**
   * ★sync after a video change (roadie-spec §6), split so the request never waits on the file
   * (issue #177). The metadata goes now — it is small and it is what makes the album resolvable —
   * and the transfer, which can take an hour over a poor link to a Pi, runs as a background job the
   * UI can watch and cancel. Returns that job so the route can hand back its id.
   *
   * Best-effort throughout: a sync failure is recorded on the album as a syncIssue, never a 5xx on
   * the human action that triggered it.
   */
  const syncAlbumToRuntime = async (asset: AlbumAsset) => {
    // Cancel any transfer still in flight for this album, **before** anything else and regardless of
    // whether this change owes a new one.
    //
    // Two distinct bugs live here. `jobs.start` dedups on album+kind — right for generation, where
    // pressing the button twice should reattach — but wrong for a transfer: a second video attached
    // while the first is still going is not the same work, and `start` would hand back the stale job
    // so the new file never got scheduled.
    //
    // And a running job holds a *snapshot* of the album from when it started. On **detach** there is
    // no new transfer to owe, so an early return would leave that job running — and on completion it
    // re-upserts the entry detach just removed, leaving Backdrop playing a video the user
    // deliberately took away. Either way the in-flight transfer is obsolete the moment the album's
    // video changes, so it is cancelled first and unconditionally.
    for (const stale of jobs.forAlbum(asset.curatorId, "mediaTransfer")) {
      if (stale.status === "running") jobs.cancel(stale.id);
    }

    // Conductor reads the whole asset, not Backdrop's projection, so any album change has to reach
    // it too. Best-effort and recorded like the Backdrop half — an unreachable Conductor must not
    // fail the human action that triggered this.
    //
    // Concurrent, not sequential: the two legs are independent, each records its own namespaced
    // syncIssue, and neither reads the other's result — so running them in series only added both
    // services' latency to every attach, detach and verify. Safe against the write race (#38)
    // because `AssetStore.update` is a fully synchronous read-mutate-save, which the event loop
    // cannot interleave.
    const [conductor, backdropRes] = await Promise.all([
      conductorSync.syncAlbum(asset),
      backdrop.syncMetadata(asset),
    ]);
    const transferJob = backdropRes.transferNeeded
      ? jobs.start("mediaTransfer", asset.curatorId, async (ctx) => {
          const out = await backdrop.transferMediaInBackground(asset, ctx);
          if (!out.ok) throw new Error(out.error ?? "media transfer failed");
          return {};
        })
      : undefined;

    return { conductor, backdrop: backdropRes, transferJob };
  };

  /** The video routes only ever wanted the transfer job; keep that shape for them. */
  const syncVideoChange = async (asset: AlbumAsset) =>
    (await syncAlbumToRuntime(asset)).transferJob;

  /**
   * Push one album to the whole runtime, as an API response: the asset to Conductor (which Amp reads
   * from the same directory) and the projection + video to Backdrop.
   *
   * This is the reusable counterpart to `verify-physical`. Verification is a one-way terminal
   * transition, so hanging the push off it alone would leave a verified album with no in-Curator way
   * to re-push after, say, a re-attached video — which is how this became a shell command in the
   * first place.
   */
  const pushAlbumToRuntime = async (asset: AlbumAsset) => {
    const {
      conductor,
      backdrop: bd,
      transferJob,
    } = await syncAlbumToRuntime(asset);
    const leg = (r: { ok: boolean; skipped?: boolean; error?: string }) => ({
      ok: r.ok,
      ...(r.skipped ? { skipped: true } : {}),
      ...(r.error ? { error: r.error } : {}),
    });
    return {
      conductor: leg(conductor),
      backdrop: leg(bd),
      ...(transferJob ? { transferJobId: transferJob.id } : {}),
    };
  };

  app.post("/api/videos/upload", async (req, reply) => {
    if (!req.isMultipart())
      return reply.code(400).send({ error: "expected multipart/form-data" });
    try {
      const { fields, file } = await readUpload(req, store);
      try {
        if (!file || file.size === 0)
          return reply.code(400).send({ error: "a video file is required" });
        if (fields.curatorId) {
          const asset = await actions.attachVideoUpload(
            actionDeps,
            fields.curatorId,
            file.path,
            file.filename,
          );
          // ★sync (roadie-spec §6): a playable video just landed. Metadata now, file in the
          // background (#177) — attaching a video must not block on a 240 MB transfer.
          const transfer = await syncVideoChange(asset);
          return reply.code(201).send({
            curatorId: fields.curatorId,
            state: asset.roadie.state,
            ...(transfer ? { transferJobId: transfer.id } : {}),
          });
        }
        const { name } = actions.saveIncoming(store, file.filename, file.path);
        return reply.code(201).send({ incoming: name });
      } finally {
        // The temp file is ours; remove it whatever happened (ingest/saveIncoming may already have
        // consumed it — `force` makes the double-remove a no-op, and it plugs the leak on a rejected
        // codec or a wrong-state attach, where the action throws before consuming the file).
        if (file) rmSync(file.path, { force: true });
      }
    } catch (err) {
      return actionError(err, reply, req, config.maxUploadBytes);
    }
  });

  // `GET /api/incoming` used to list the staging dir for an "Incoming" browser screen. That screen
  // was specced but never built, and the route had no caller — so it went with the spec section
  // (2026-07-25 spec reconcile). `/incoming/` itself stays: an upload that names no album still
  // lands there, and attach-by-filename still claims from it.
  //
  // `fileId` names either an /incoming/ filename or a video already in `visualizers/` — including this
  // album's own, which is how a detach that kept the file is undone (issue #99 / ADR 0041).
  app.post("/api/albums/:curatorId/attach-video", async (req, reply) => {
    const { curatorId } = req.params as { curatorId: string };
    const { fileId } = (req.body ?? {}) as { fileId?: string };
    if (!fileId) return reply.code(400).send({ error: "fileId is required" });
    try {
      const asset = await actions.attachVideoByFileId(
        actionDeps,
        curatorId,
        fileId,
      );
      // ★sync (roadie-spec §6): the album now has a playable video — push it to Backdrop. Best-effort;
      // a sync failure is recorded on the album, not raised, so the attach still succeeds.
      const transfer = await syncVideoChange(asset);
      return {
        state: asset.roadie.state,
        visualizer: asset.visualizer,
        ...(transfer ? { transferJobId: transfer.id } : {}),
      };
    } catch (err) {
      return actionError(err, reply, req);
    }
  });

  app.post("/api/albums/:curatorId/detach-video", async (req, reply) => {
    const { curatorId } = req.params as { curatorId: string };
    const del = (req.query as { delete?: string }).delete === "1";
    try {
      const asset = actions.detachVideo(actionDeps, curatorId, del);
      // No visualizer left → drop the album from Backdrop's library so a scan degrades to "not synced".
      await syncVideoChange(asset);
      return { state: asset.roadie.state };
    } catch (err) {
      return actionError(err, reply, req);
    }
  });

  // Splice the generated clips into one loop and attach it as the visualizer (issue #29). Body:
  // { order?: number[] } — the ordered clip indices to join (default: all, in index order).
  app.post("/api/albums/:curatorId/video/splice", async (req, reply) => {
    const { curatorId } = req.params as { curatorId: string };
    const { order, crossfadeSec } = (req.body ?? {}) as {
      order?: number[];
      crossfadeSec?: number;
    };
    // Opt-in seam crossfade (issue #56): a positive, bounded duration → xfade at the seams; anything
    // else → a plain concat. Cap it so a silly value can't eat most of a short clip.
    const crossfade =
      typeof crossfadeSec === "number" && crossfadeSec > 0
        ? { durationSec: Math.min(crossfadeSec, 2) }
        : undefined;
    try {
      const asset = await actions.spliceVisualizer(
        actionDeps,
        curatorId,
        order,
        {
          crossfade,
        },
      );
      // ★sync (roadie-spec §6): the album now has a playable video — push it to Backdrop.
      const transfer = await syncVideoChange(asset);
      return {
        state: asset.roadie.state,
        visualizer: asset.visualizer,
        ...(transfer ? { transferJobId: transfer.id } : {}),
      };
    } catch (err) {
      return actionError(err, reply, req);
    }
  });

  // Generate a set of visualizer clips from the drafted video prompts (Veo/"Omni"). Long-running, so
  // it runs as a background job (issue #30 / ADR 0018): precheck synchronously (misconfig → 4xx now),
  // then enqueue and return 202 { jobId }. The UI polls GET /api/jobs/:id.
  app.post("/api/albums/:curatorId/video/generate", async (req, reply) => {
    const { curatorId } = req.params as { curatorId: string };
    try {
      actions.assertGenerable(actionDeps, curatorId, "video");
    } catch (err) {
      return actionError(err, reply, req);
    }
    const job = jobs.start(
      "video",
      curatorId,
      async ({ onProgress, signal }) => {
        const asset = await actions.generateVideoSet(actionDeps, curatorId, {
          onProgress,
          signal,
        });
        return { videoClips: asset.videoClips };
      },
    );
    return reply.code(202).send(job);
  });

  // Generate a single clip from one drafted video prompt variant (ADR 0022). Like the set it's a
  // multi-minute Omni call, so it's a background job too — but keyed on the prompt index, so a
  // per-clip run and the set (or another clip) don't shadow each other. Precheck (incl. index range)
  // → 4xx now; else enqueue → 202 { jobId }. The per-prompt "Generate clip" buttons drive this.
  app.post(
    "/api/albums/:curatorId/video/generate/:index",
    async (req, reply) => {
      const { curatorId, index } = req.params as {
        curatorId: string;
        index: string;
      };
      const i = Number(index);
      try {
        actions.assertGenerable(actionDeps, curatorId, "video", i);
      } catch (err) {
        return actionError(err, reply, req);
      }
      const job = jobs.start(
        "video",
        curatorId,
        async ({ onProgress, signal }) => {
          const asset = await actions.generateVideoOne(
            actionDeps,
            curatorId,
            i,
            {
              onProgress,
              signal,
            },
          );
          return { videoClips: asset.videoClips };
        },
        i,
      );
      return reply.code(202).send(job);
    },
  );

  // --- Card art: upload / attach / detach ---
  app.post("/api/card-art/upload", async (req, reply) => {
    if (!req.isMultipart())
      return reply.code(400).send({ error: "expected multipart/form-data" });
    try {
      const { fields, file } = await readUpload(req, store);
      try {
        if (!file || file.size === 0)
          return reply.code(400).send({ error: "an image file is required" });
        if (fields.curatorId) {
          const asset = actions.attachCardArtUpload(
            actionDeps,
            fields.curatorId,
            file.path,
            file.filename,
          );
          return reply
            .code(201)
            .send({ curatorId: fields.curatorId, cardArt: asset.cardArt });
        }
        const { name } = actions.saveIncoming(store, file.filename, file.path);
        return reply.code(201).send({ incoming: name });
      } finally {
        if (file) rmSync(file.path, { force: true });
      }
    } catch (err) {
      return actionError(err, reply, req, config.maxUploadBytes);
    }
  });

  // Same two forms as attach-video: an /incoming/ filename, or an image already in `card-art/`.
  app.post("/api/albums/:curatorId/attach-card-art", async (req, reply) => {
    const { curatorId } = req.params as { curatorId: string };
    const { fileId } = (req.body ?? {}) as { fileId?: string };
    if (!fileId) return reply.code(400).send({ error: "fileId is required" });
    try {
      const asset = actions.attachCardArtByFileId(
        actionDeps,
        curatorId,
        fileId,
      );
      return { cardArt: asset.cardArt };
    } catch (err) {
      return actionError(err, reply, req);
    }
  });

  app.post("/api/albums/:curatorId/detach-card-art", async (req, reply) => {
    const { curatorId } = req.params as { curatorId: string };
    const del = (req.query as { delete?: string }).delete === "1";
    try {
      actions.detachCardArt(actionDeps, curatorId, del);
      return { detached: curatorId };
    } catch (err) {
      return actionError(err, reply, req);
    }
  });

  // Generate a set of card-art candidates from the drafted prompt variants (Nano Banana). Background
  // job like video generation (issue #30 / ADR 0018): precheck → 4xx now, else enqueue → 202 { jobId }.
  app.post("/api/albums/:curatorId/card-art/generate", async (req, reply) => {
    const { curatorId } = req.params as { curatorId: string };
    try {
      actions.assertGenerable(actionDeps, curatorId, "cardArt");
    } catch (err) {
      return actionError(err, reply, req);
    }
    const job = jobs.start(
      "cardArt",
      curatorId,
      async ({ onProgress, signal }) => {
        const asset = await actions.generateCardArtSet(actionDeps, curatorId, {
          onProgress,
          signal,
        });
        return { cardArtCandidates: asset.cardArtCandidates };
      },
    );
    return reply.code(202).send(job);
  });

  // Generate a single card-art candidate from one drafted prompt variant (Nano Banana). One bounded
  // image call, so it runs synchronously (unlike the whole-set background job) and returns the merged
  // candidate list. The per-prompt "Generate art" buttons drive this (ADR 0021).
  app.post(
    "/api/albums/:curatorId/card-art/generate/:index",
    async (req, reply) => {
      const { curatorId, index } = req.params as {
        curatorId: string;
        index: string;
      };
      try {
        const asset = await actions.generateCardArtOne(
          actionDeps,
          curatorId,
          Number(index),
        );
        return { cardArtCandidates: asset.cardArtCandidates };
      } catch (err) {
        return actionError(err, reply, req);
      }
    },
  );

  // Poll a generation job's status/progress/result (issue #30). 404 once unknown/expired.
  app.get("/api/jobs/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const job = jobs.get(id);
    return job ?? reply.code(404).send({ error: "job not found" });
  });

  // Cancel an in-flight generation job (issue #57): abort the runner (stopping the Gemini fetch) and
  // mark it cancelled. Idempotent — cancelling a terminal job returns it unchanged; unknown → 404.
  app.post("/api/jobs/:id/cancel", async (req, reply) => {
    const { id } = req.params as { id: string };
    const job = jobs.cancel(id);
    return job ?? reply.code(404).send({ error: "job not found" });
  });

  // Active + recent generation jobs for an album — lets the detail page re-attach to a running job
  // after a reload (the original "a reload loses the result" failure mode, issue #30). Optional
  // ?kind=video|cardArt filter.
  app.get("/api/albums/:curatorId/jobs", async (req) => {
    const { curatorId } = req.params as { curatorId: string };
    const kind = (req.query as { kind?: string }).kind;
    // Whitelisted rather than cast: an unknown ?kind must mean "no filter", not a filter that
    // silently matches nothing. `mediaTransfer` joined the list with issue #177 — leaving it out
    // would have made the transfer job invisible to a UI asking for it by name.
    const filter =
      kind === "video" || kind === "cardArt" || kind === "mediaTransfer"
        ? kind
        : undefined;
    return { jobs: jobs.forAlbum(curatorId, filter) };
  });

  // Everything currently in flight, album-scoped and library-scoped alike — the standalone answer to
  // "what is this machine doing right now". `GET /api/jobs` deliberately cannot answer that (it
  // requires a `kind`) and polling per album does not scale with the library. Running only; finished
  // jobs are the per-album route's business.
  //
  // The system-status page does *not* call this: it gets `jobs` inside `/api/system/status`, so the
  // job list belongs to the same instant as the service health it sits beside. This route is for
  // callers that want the jobs alone — curl during a long sync, and anything that shouldn't pay for
  // a full runtime fan-out to find out whether something is running.
  app.get("/api/jobs/active", async () => ({ jobs: jobs.active() }));

  // Library-scoped jobs of a kind, newest first — how the batch panel reattaches to a sweep that was
  // already running when the window reloaded (ADR 0029). Per-album jobs live at the route above and
  // are deliberately not returned here; `kind` is required so this can never become "all jobs".
  app.get("/api/jobs", async (req, reply) => {
    const kind = (req.query as { kind?: string }).kind;
    const LIBRARY_JOB_KINDS: JobKind[] = [
      "paletteBatch",
      "runtimeSync",
      "discogsSync",
      "spotifyBackfill",
    ];
    if (!kind || !LIBRARY_JOB_KINDS.includes(kind as JobKind))
      return reply.code(400).send({
        error: `kind must be one of ${LIBRARY_JOB_KINDS.join(", ")}`,
      });
    return { jobs: jobs.library(kind as JobKind) };
  });

  // Promote a generated candidate to the attached card art.
  app.post("/api/albums/:curatorId/card-art/select", async (req, reply) => {
    const { curatorId } = req.params as { curatorId: string };
    const { index } = (req.body ?? {}) as { index?: number };
    try {
      const asset = actions.selectCardArt(actionDeps, curatorId, Number(index));
      return { cardArt: asset.cardArt };
    } catch (err) {
      return actionError(err, reply, req);
    }
  });

  // --- Preview: approve / reject ---
  app.post("/api/albums/:curatorId/preview/approve", async (req, reply) => {
    const { curatorId } = req.params as { curatorId: string };
    try {
      const asset = actions.approvePreview(actionDeps, curatorId);
      return { state: asset.roadie.state };
    } catch (err) {
      return actionError(err, reply, req);
    }
  });

  app.post("/api/albums/:curatorId/preview/reject", async (req, reply) => {
    const { curatorId } = req.params as { curatorId: string };
    const { to } = (req.body ?? {}) as {
      to?: "awaiting_review" | "awaiting_video";
    };
    if (to !== "awaiting_review" && to !== "awaiting_video")
      return reply
        .code(400)
        .send({ error: 'to must be "awaiting_review" or "awaiting_video"' });
    try {
      const asset = actions.rejectPreview(actionDeps, curatorId, to);
      return { state: asset.roadie.state };
    } catch (err) {
      return actionError(err, reply, req);
    }
  });

  /**
   * **Name this album on Spotify by hand** (ADR 0059) — the escape hatch behind the "add the album's
   * Spotify URI" the picker suggests, for the two cases the matcher can't serve: it found nothing,
   * or it found something it deliberately won't play from.
   *
   * Accepts the `spotify:album:…` URI *or* an `open.spotify.com/album/…` share link, because the
   * share button is where anyone actually gets this. `{ spotifyUri: null }` clears it, which also
   * clears the demo cut — that named a track on an album we just disowned.
   */
  app.put("/api/albums/:curatorId/spotify-uri", async (req, reply) => {
    const { curatorId } = req.params as { curatorId: string };
    const { spotifyUri } = (req.body ?? {}) as { spotifyUri?: string | null };
    try {
      const asset = actions.setSpotifyUri(
        actionDeps,
        curatorId,
        spotifyUri ?? null,
      );
      return {
        spotifyUri: asset.metadata.spotifyUri ?? null,
        demoTrack: asset.demoTrack ?? null,
      };
    } catch (err) {
      return actionError(err, reply, req);
    }
  });

  // --- The demo track (ADR 0058) ---

  /**
   * Why this record has no tracklist, said accurately (ADR 0059). Three different situations that a
   * single "isn't on Spotify" used to flatten into one wrong sentence:
   *
   * - a **manual** album, which genuinely has no streaming identity;
   * - a Discogs album Curator matched only **closely** — it found something and deliberately won't
   *   play from a guess, so the sentence names what it found;
   * - a Discogs album it has never matched, where the honest answer is "not matched yet", plus the
   *   thing to do about it.
   */
  const unmatchedReason = (metadata: AlbumMetadata): string => {
    if (metadata.source === "manual")
      return "This record was added by hand, so there's no Spotify album behind it to list songs from";
    const match = metadata.spotifyMatch;
    if (match?.confidence === "close")
      return `Curator only found a near match on Spotify (“${match.artist} — ${match.name}”), so it won't play from it. Songs stay unavailable until that is confirmed`;
    return "Curator hasn't matched this to a Spotify album yet — run the Spotify backfill from Settings, or add the album's Spotify URI";
  };

  /**
   * The album's tracklist, for the demo-track picker.
   *
   * **Always 200**, with an empty list and a `reason` for every way this can come back with nothing:
   * no Spotify credentials, an album Curator has no Spotify URI for, or Spotify being down. The
   * picker renders the reason in place — a record with no tracklist is an ordinary state of this
   * screen, not a failure of it, and a 4xx here would make the panel look broken for a manual album
   * that is working exactly as designed.
   *
   * **The reason distinguishes "we don't know" from "it isn't there"** (ADR 0059). Saying "this
   * record isn't on Spotify" about a Discogs pressing was simply false — it usually is, Curator just
   * hadn't kept the identity — and it sent this project's own user looking for a bug in the picker.
   *
   * Not cached and not stored: see `DemoTrack` for why the choice lives on the asset and the list
   * does not.
   */
  app.get("/api/albums/:curatorId/tracks", async (req, reply) => {
    const { curatorId } = req.params as { curatorId: string };
    const asset = store.read(curatorId);
    if (!asset) return reply.code(404).send({ error: "not found" });
    if (!spotify)
      return {
        tracks: [],
        reason:
          "Spotify isn't set up — add credentials in Settings to see this record's songs",
      };
    const spotifyId = parseAlbumId({ spotifyUri: asset.metadata.spotifyUri });
    if (!spotifyId)
      return { tracks: [], reason: unmatchedReason(asset.metadata) };
    try {
      return { tracks: await spotify.getAlbumTracks(spotifyId) };
    } catch (err) {
      return { tracks: [], reason: (err as Error).message };
    }
  });

  /**
   * Choose the track a demo tag plays — or clear it with `{ track: null }`, which returns the tag to
   * card behaviour (the whole album from track 1) rather than making it silent.
   *
   * One route for set and clear because they are the same decision at two values, and a DELETE would
   * imply the demo track is a resource that can be absent versus present; it is a field.
   */
  app.put("/api/albums/:curatorId/demo-track", async (req, reply) => {
    const { curatorId } = req.params as { curatorId: string };
    const { track } = (req.body ?? {}) as {
      track?: actions.DemoTrackChoice | null;
    };
    try {
      const asset = actions.setDemoTrack(actionDeps, curatorId, track ?? null);
      return { demoTrack: asset.demoTrack ?? null };
    } catch (err) {
      return actionError(err, reply, req);
    }
  });

  // --- Tag write / verify (step 11, curator-spec §7) ---
  // Record that a physical sticker was written. Writing the sleeve (scanned on the stand) advances
  // awaiting_tag_write → awaiting_verify; the card and demo tags are independent bookkeeping.
  // Optional tagUid.
  app.post("/api/albums/:curatorId/tag-written", async (req, reply) => {
    const { curatorId } = req.params as { curatorId: string };
    const { object, tagUid } = (req.body ?? {}) as {
      object?: TagObject;
      tagUid?: string;
    };
    if (!isTagObject(object))
      return reply.code(400).send({
        error: `object must be one of ${TAG_OBJECTS.map((o) => `"${o}"`).join(", ")}`,
      });
    try {
      const asset = actions.markTagWritten(
        actionDeps,
        curatorId,
        object,
        tagUid,
      );
      return { state: asset.roadie.state, tag: asset.tag };
    } catch (err) {
      return actionError(err, reply, req);
    }
  });

  /**
   * **Tags verified** (ADR 0052) — the record page's one button for the whole tag step: both
   * stickers recorded as written, and the physical check recorded, in one action.
   *
   * Shares `verify-physical`'s tail exactly (push to the runtime, then ★verify), because the *claim*
   * being made is identical — "I put the sleeve on the stand and it worked" — and that claim is only
   * honest about a runtime that has actually been given the album.
   */
  app.post("/api/albums/:curatorId/tags-verified", async (req, reply) => {
    const { curatorId } = req.params as { curatorId: string };
    try {
      const asset = actions.verifyTags(actionDeps, curatorId);
      const push = await pushAlbumToRuntime(asset);
      const verify = await backdrop.verifyAlbum(asset).catch((err) => ({
        ok: false,
        discrepancies: [`verify failed — ${(err as Error).message}`],
      }));
      return { state: asset.roadie.state, push, verify };
    } catch (err) {
      return actionError(err, reply, req);
    }
  });

  // Mark the album physically verified: awaiting_verify → verified, record physicallyVerifiedAt, then
  // fire the ★verify Backdrop reconcile (roadie-spec §6 / ADR 0015) — the last human step of onboarding.
  app.post("/api/albums/:curatorId/verify-physical", async (req, reply) => {
    const { curatorId } = req.params as { curatorId: string };
    try {
      const asset = actions.verifyPhysical(actionDeps, curatorId);
      // Push before verifying (ADR 0045). Verifying used to *check* Backdrop and report drift; now
      // the last human step of onboarding also makes the runtime true, so "I put the sleeve on the
      // stand and it worked" is a claim about a system that has actually been given the album.
      const push = await pushAlbumToRuntime(asset);
      // ★verify-on-verified: confirm Backdrop carries this album; discrepancies surface as syncIssues
      // (non-blocking — the album is verified regardless of Backdrop reachability).
      const verify = await backdrop.verifyAlbum(asset).catch((err) => ({
        ok: false,
        discrepancies: [`verify failed — ${(err as Error).message}`],
      }));
      return { state: asset.roadie.state, push, verify };
    } catch (err) {
      return actionError(err, reply, req);
    }
  });

  // --- Demo / runtime preview: drive the real Hue lights via Conductor (runtime-overview §6) ---
  // Curator proxies Conductor so the browser never holds the shared secret and there's no CORS.
  // See ADR 0007. `fetch`/`Response` are Node 22 globals; type via the fetch signature to avoid
  // naming DOM lib types the server tsconfig doesn't pull in.
  type FetchInit = Parameters<typeof fetch>[1];
  type FetchResponse = Awaited<ReturnType<typeof fetch>>;

  /** How long a proxied demo call waits. Named so the timeout and the message that reports it
   *  can't drift apart — the operator is told the budget the call was actually given. */
  const CONDUCTOR_PROXY_TIMEOUT_MS = 5000;

  const callConductor = (path: string, init?: FetchInit) => {
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    if (config.conductor.sharedSecret)
      headers["x-trigger-secret"] = config.conductor.sharedSecret;
    return fetch(`${config.conductor.url}${path}`, {
      ...init,
      // Cap the call so a wedged (not just down) Conductor can't hang a /api/demo/* request; the
      // abort surfaces as a fetch rejection → conductorDown → 502 (review: runtime).
      signal: AbortSignal.timeout(CONDUCTOR_PROXY_TIMEOUT_MS),
      headers: { ...headers, ...(init?.headers as Record<string, string>) },
    });
  };

  // Forward a Conductor response (status + JSON body) straight back to the browser.
  const forwardConductor = async (reply: FastifyReply, res: FetchResponse) => {
    const body = await res.json().catch(() => ({}));
    return reply.code(res.status).send(body);
  };

  // A fetch that throws means the call did not complete — a clean 502 the UI can render.
  //
  // It used to read `not reachable at <url> — is it running?`, which asserted a cause this code has
  // no way to know. On 2026-08-08 it said exactly that about a Conductor that was running and
  // answering in 60ms, over a link dropping 12% of packets, and it sent the afternoon to journalctl
  // on a healthy service (issue #270). Name the failure and the address; diagnose nothing.
  // `includeCode` because this backs the System page's stop control, which curator-ui-ux §8.5 calls
  // "the one place a raw error code belongs" — paraphrasing alone would take away the string you
  // paste into a search. The sentence says what happened; the code stays greppable.
  const conductorDown = (reply: FastifyReply, err: unknown) =>
    reply.code(502).send({
      error: `Hue Conductor: ${describeFetchFailure(err, config.conductor.url, CONDUCTOR_PROXY_TIMEOUT_MS, { includeCode: true })}`,
    });

  // Start (or crossfade to) an album's palette+pattern on the configured listening room.
  app.post("/api/demo/play", async (req, reply) => {
    const { curatorId } = (req.body ?? {}) as { curatorId?: string };
    if (!curatorId)
      return reply.code(400).send({ error: "curatorId is required" });
    const asset = store.read(curatorId);
    if (!asset) return reply.code(404).send({ error: "not found" });
    let payload;
    try {
      payload = buildPalettePayload(asset);
    } catch (err) {
      if (err instanceof DemoNotReadyError)
        return reply.code(409).send({ error: err.message });
      throw err;
    }
    try {
      return forwardConductor(
        reply,
        await callConductor("/api/playback", {
          method: "POST",
          body: JSON.stringify({ palette: payload }),
        }),
      );
    } catch (err) {
      return conductorDown(reply, err);
    }
  });

  // Lift the sleeve: stop playback and let Conductor restore the room's pre-demo lighting.
  app.post("/api/demo/stop", async (_req, reply) => {
    try {
      return forwardConductor(
        reply,
        await callConductor("/api/playback/stop", {
          method: "POST",
          body: "{}",
        }),
      );
    } catch (err) {
      return conductorDown(reply, err);
    }
  });

  // The rooms/zones Conductor sees — for the first-run room picker.
  app.get("/api/demo/rooms", async (_req, reply) => {
    try {
      return forwardConductor(reply, await callConductor("/api/rooms"));
    } catch (err) {
      return conductorDown(reply, err);
    }
  });

  // Choose the listening room (persisted in Conductor's settings).
  app.put("/api/demo/room", async (req, reply) => {
    const { roomId } = (req.body ?? {}) as { roomId?: string | null };
    try {
      return forwardConductor(
        reply,
        await callConductor("/api/settings", {
          method: "PUT",
          body: JSON.stringify({ listeningRoomId: roomId ?? null }),
        }),
      );
    } catch (err) {
      return conductorDown(reply, err);
    }
  });

  // Aggregate status for the Demo Room header: reachable? paired? which room is set? Conductor being
  // down is a normal state to render (reachable:false), not a Curator error — hence 200 either way.
  app.get("/api/demo/status", async () => {
    try {
      const [statusRes, settingsRes] = await Promise.all([
        callConductor("/api/bridge/status"),
        callConductor("/api/settings"),
      ]);
      const status = (await statusRes.json().catch(() => ({}))) as {
        paired?: boolean;
      };
      const settings = (await settingsRes.json().catch(() => ({}))) as {
        listeningRoomId?: string | null;
      };
      return {
        reachable: true,
        paired: Boolean(status.paired),
        listeningRoomId: settings.listeningRoomId ?? null,
      };
    } catch {
      return { reachable: false, paired: false, listeningRoomId: null };
    }
  });

  // Audio leg of the rehearsal (ADR 0028): proxy to Amp so the browser never holds the shared
  // secret — same rationale as the Conductor rows above. Amp-unconfigured/unreachable is reported,
  // not an error: the rehearsal degrades to lights + video.
  app.post("/api/demo/audio", async (req, reply) => {
    const { curatorId } = (req.body ?? {}) as { curatorId?: string };
    if (!curatorId)
      return reply.code(400).send({ error: "curatorId is required" });
    const asset = store.read(curatorId);
    if (!asset) return reply.code(404).send({ error: "not found" });
    if (!amp)
      return reply.code(200).send({
        played: false,
        reason:
          "Amp isn't configured — set [amp] url to hear audio in a rehearsal",
      });
    const uri = asset.metadata.spotifyUri;
    if (!uri)
      return reply.code(200).send({
        played: false,
        reason: "This album has no Spotify URI, so Amp has nothing to stream",
      });
    try {
      await amp.play(uri);
      return { played: true };
    } catch (err) {
      return reply
        .code(200)
        .send({ played: false, reason: (err as Error).message });
    }
  });

  // --- Desk audio for bench preview (ADR 0037, issue #93) ---
  // Bench preview's audio leg. Proxied here for the same reason as the runtime services: the browser
  // never holds the Spotify token. Unlike the rehearsal rows this touches no hardware — DeskAudio
  // only ever targets a local `Computer` device, and the browser cannot name one.
  //
  // 200 with `played:false` + a reason for anything that merely didn't happen (no session, no
  // desktop client, not Premium, album not on Spotify, Spotify down): bench preview degrades to
  // silent, which is what it shipped as. Only an unknown album is a 4xx.
  app.post("/api/albums/:curatorId/desk-audio", async (req, reply) => {
    const { curatorId } = req.params as { curatorId: string };
    const asset = store.read(curatorId);
    if (!asset) return reply.code(404).send({ error: "not found" });
    if (!deskAudio)
      return {
        played: false,
        reason:
          "Spotify isn't set up — add credentials in Settings to hear desk audio",
      };
    const uri = asset.metadata.spotifyUri;
    if (!uri)
      return {
        played: false,
        reason: "This album has no Spotify URI, so there's nothing to play",
      };
    return deskAudio.play(uri);
  });

  app.delete("/api/albums/:curatorId/desk-audio", async (req, reply) => {
    const { curatorId } = req.params as { curatorId: string };
    if (!store.read(curatorId))
      return reply.code(404).send({ error: "not found" });
    if (!deskAudio) return { paused: true };
    return deskAudio.pause();
  });

  // --- Room rehearsal: the real runtime path minus the physical tag (ADR 0028) ---
  // Fans a scan event out to Conductor and Backdrop exactly as Stylus would, and drives Amp via its
  // documented admin override. Every leg is best-effort and independently reported, so one dead
  // service degrades the rehearsal instead of failing it (runtime-overview §8 error philosophy).
  const scanEvent = (curatorId: string, event: "start" | "stop") => ({
    event,
    ...(event === "start"
      ? { uri: `curator:album:${curatorId}`, tagUid: "00:00:00:00:00:00:00" }
      : {}),
    readerId: "curator-rehearsal",
    at: new Date().toISOString(),
  });

  /**
   * POST a scan event to a sibling service. Bounded like every other outbound call (5s).
   *
   * A 2xx is not proof the room did anything. Conductor accepts a scan it cannot act on and says so
   * in the body — `202 {ok:true, action:"ignored", reason}` for `no listening room`,
   * `album not synced` and `album not ready` (ADR 0019). Treating that as success reported
   * "Lights running" over a dark room and sent every diagnosis down the wrong path (issue #164), so
   * an explicitly-ignored scan throws its own reason and lands on the leg as a failure.
   *
   * The check lives here, in the shared helper, rather than at the Conductor call site: Backdrop
   * posts through the same function and may grow the same degrade shape. A service that simply
   * accepts (Backdrop's `202 {accepted:true}`) has no `action` and stays a success.
   */
  const callScan = async (
    base: string,
    secret: string | undefined,
    body: unknown,
  ) => {
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    if (secret) headers["x-trigger-secret"] = secret;
    const res = await fetch(`${base}/api/scan`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`${res.status}`);
    // A non-JSON or unreadable body is not evidence of a no-op — only an explicit `ignored` is.
    const ignored = scanIgnoredReason(await res.json().catch(() => null));
    if (ignored) throw new Error(ignored);
  };

  /**
   * Run one rehearsal leg, collapsing any failure into a reportable reason. `skip` is the reason a
   * leg didn't run at all (unconfigured, opted out, nothing to play) — distinct from a leg that ran
   * and failed, so the UI can say "no Amp configured" rather than implying the call broke.
   */
  const leg = async (
    name: string,
    skip: string | null,
    run: () => Promise<unknown>,
  ): Promise<{ service: string; ok: boolean; reason?: string }> => {
    if (skip) return { service: name, ok: false, reason: skip };
    try {
      await run();
      return { service: name, ok: true };
    } catch (err) {
      return { service: name, ok: false, reason: (err as Error).message };
    }
  };

  app.post("/api/albums/:curatorId/simulate-scan", async (req, reply) => {
    const { curatorId } = req.params as { curatorId: string };
    const asset = store.read(curatorId);
    if (!asset) return reply.code(404).send({ error: "not found" });
    const { audio = true } = (req.body ?? {}) as { audio?: boolean };
    const body = scanEvent(curatorId, "start");

    const services = await Promise.all([
      leg("conductor", null, () =>
        callScan(config.conductor.url, config.conductor.sharedSecret, body),
      ),
      leg("backdrop", config.backdrop ? null : "not configured", () =>
        callScan(config.backdrop!.url, config.backdrop!.sharedSecret, body),
      ),
      leg(
        "amp",
        !amp
          ? "not configured"
          : !audio
            ? "audio opted out"
            : !asset.metadata.spotifyUri
              ? "album has no Spotify URI"
              : null,
        () => amp!.play(asset.metadata.spotifyUri!),
      ),
    ]);
    return { services };
  });

  app.post("/api/albums/:curatorId/simulate-scan/stop", async (req, reply) => {
    const { curatorId } = req.params as { curatorId: string };
    if (!store.read(curatorId))
      return reply.code(404).send({ error: "not found" });
    const body = scanEvent(curatorId, "stop");
    const services = await Promise.all([
      leg("conductor", null, () =>
        callScan(config.conductor.url, config.conductor.sharedSecret, body),
      ),
      leg("backdrop", config.backdrop ? null : "not configured", () =>
        callScan(config.backdrop!.url, config.backdrop!.sharedSecret, body),
      ),
      leg("amp", amp ? null : "not configured", () => amp!.stop()),
    ]);
    return { services };
  });

  /**
   * "Is the thing I configured actually reachable?" for the Settings screen (issue #101).
   *
   * One route rather than three test-connection buttons hitting three shapes: each service reports
   * the same `{ configured, reachable, detail? }`, so the UI renders one list and an unconfigured
   * service reads differently from a dead one. Probes run in parallel and are bounded like every
   * other outbound call — a wedged service must not hold the request open.
   */
  app.get("/api/settings/service-health", async () => {
    const services = await Promise.all([
      // Conductor's bridge status doubles as its health check — it says whether the Hue bridge is
      // paired, which is the thing that actually stops lights working.
      probeService("conductor", config.conductor, "/api/bridge/status"),
      probeService("backdrop", config.backdrop, "/healthz"),
      probeService("amp", config.amp, "/api/status"),
      probeService("stylus", config.stylus, "/healthz"),
    ]);
    return { services };
  });

  /**
   * Everything at once: "what is the system actually doing right now" (the system-status page).
   *
   * Distinct from `service-health` above, which answers only "is what I configured reachable". This
   * one also compares — which albums the runtime holds against which Curator has, whether a library
   * entry has bytes behind it — because every failure worth catching here is a *disagreement*
   * between hosts, not a service's own self-report.
   *
   * Always 200. An unreachable service degrades its own section to null; a status page that errors
   * because something is down is reporting the one thing it exists to show, as a failure.
   */
  app.get("/api/system/status", async () =>
    buildSystemStatus({
      conductor: config.conductor,
      backdrop: config.backdrop,
      amp: config.amp,
      stylus: config.stylus,
      albums: store.list(),
      jobs: jobs.active(),
    }),
  );

  // --- Backdrop sync (step 9, roadie-spec §6) — push Curator's library projection to Backdrop ---
  // Video attach/detach already sync automatically; these are the manual full-reconcile + verify
  // controls (curator-spec §9 "run sync from Curator" recovery, and the ★verify check).
  // `mediaTransfer` is here because "will a sync move my videos?" was otherwise only answerable by
  // reading `.env` — and with the default (`none`) a sync reports success having moved nothing (#187).
  app.get("/api/backdrop/status", async () => ({
    enabled: backdrop.enabled,
    mediaTransfer: backdrop.mediaTransferMode,
  }));

  // Full library reconcile (curator-spec §8 "run sync from Curator" recovery). Push every videoed
  // album as the complete library, transferring each file first.
  app.post("/api/backdrop/sync", async (_req, reply) => {
    if (!backdrop.enabled)
      return reply.code(409).send({ error: "no Backdrop is configured" });
    return backdrop.resyncAll(store.list());
  });

  // Compare Curator's expected projection against Backdrop's live library; return the diff (roadie-spec
  // §6 verify). Read-only, but POST to match the spec's committed name.
  app.post("/api/backdrop/verify-sync", async (_req, reply) => {
    if (!backdrop.enabled)
      return reply.code(409).send({ error: "no Backdrop is configured" });
    try {
      return await backdrop.verify(store.list());
    } catch (err) {
      return reply.code(502).send({
        error: `verify failed — ${(err as Error).message}`,
      });
    }
  });

  // --- Runtime push (ADR 0045) — Curator is the one place data leaves the workstation -------------
  // The Backdrop routes above cover half the runtime; these cover all of it, including the
  // album-assets store Conductor and Amp read, which until now moved only by a hand-run rsync.

  /** Push one album everywhere. Available at any state, unlike the one-way `verify-physical`. */
  app.post("/api/albums/:curatorId/push", async (req, reply) => {
    const { curatorId } = req.params as { curatorId: string };
    const asset = store.read(curatorId);
    if (!asset) return reply.code(404).send({ error: "album not found" });
    return pushAlbumToRuntime(asset);
  });

  /**
   * Push the whole library. Returns **202 + a job** rather than doing the work inline: with
   * `media_transfer = "push"` this streams every visualizer, which is hours over a poor link, and
   * `POST /api/backdrop/sync` holding a request open for that long is the thing this replaces.
   *
   * Progress is albums, not bytes — the per-video byte progress belongs to each `mediaTransfer` job,
   * which the status page shows alongside this one.
   */
  app.post("/api/runtime/sync", async (_req, reply) => {
    if (!conductorSync.enabled && !backdrop.enabled)
      return reply
        .code(409)
        .send({ error: "no runtime services are configured" });

    const job = jobs.start("runtimeSync", undefined, async (ctx) => {
      const assets = store.list();
      // Progress counts **album-legs**: each album is pushed once per configured service, so the
      // total is one tick per album per enabled leg. Counting only one leg would show the bar
      // finishing while the slow half — the videos — had not started; counting a disabled leg would
      // leave the bar permanently short, since a no-op sync never reports progress.
      const conductorLegs = conductorSync.enabled ? assets.length : 0;
      const backdropLegs = backdrop.enabled ? assets.length : 0;
      const total = conductorLegs + backdropLegs;
      const phase = (offset: number) => (done: number) =>
        ctx.onProgress(offset + done, total);

      // Conductor first: it is small, fast, and it is what makes an album resolvable at all. A
      // library whose videos are still uploading but whose palettes have landed is a working room.
      const conductor = await conductorSync.resyncAll(assets, {
        onProgress: phase(0),
        signal: ctx.signal,
      });
      if (ctx.signal.aborted) return { runtimeSync: { conductor } };
      const backdropRes = backdrop.enabled
        ? await backdrop.resyncAll(assets, {
            onProgress: phase(conductorLegs),
            // The visualizer in flight, on its own channel. Without it the bar advances once per
            // album and a 66 MB upload over a poor link looks identical to a wedged sync for
            // minutes at a time — which is how a 47-minute push went unnoticed on 2026-08-08.
            onTransfer: ctx.onTransfer,
            signal: ctx.signal,
          })
        : undefined;
      return {
        runtimeSync: {
          conductor,
          ...(backdropRes ? { backdrop: backdropRes } : {}),
        },
      };
    });
    return reply.code(202).send(job);
  });

  /** Read-only drift report across the runtime — what the status page's "out of sync" count uses. */
  app.post("/api/runtime/verify", async (_req, reply) => {
    const assets = store.list();
    const [conductor, backdropCheck] = await Promise.all([
      conductorSync
        .verify(assets)
        .catch((err: Error) => ({ ok: false, error: err.message })),
      backdrop.enabled
        ? backdrop
            .verify(assets)
            .catch((err: Error) => ({ ok: false, error: err.message }))
        : Promise.resolve(undefined),
    ]);
    return reply.send({
      conductor,
      ...(backdropCheck ? { backdrop: backdropCheck } : {}),
    });
  });

  // --- Roadie: queue view + observability + controls (roadie-spec §10/§11/§12) ---
  app.get("/api/agent/queue", async () => buildQueue(store));

  /**
   * Where this album sits among the others at the same state, and who is either side (issue #94).
   * Server-side so the neighbours are the queue's, in the queue's order — deriving them on the
   * detail page would be a second implementation of that ordering, free to drift.
   */
  app.get("/api/albums/:curatorId/peers", async (req, reply) => {
    const { curatorId } = req.params as { curatorId: string };
    const peers = peerContext(store.list(), curatorId);
    return peers ?? reply.code(404).send({ error: "album not found" });
  });

  // Just the counts — backs the browser-tab "needs you right now" badge (curator-spec §10).
  app.get("/api/agent/queue/counts", async () => queueCounts(store));

  app.get("/api/agent/status", async () => roadie.status());

  app.post("/api/agent/retry/:curatorId", async (req, reply) => {
    const { curatorId } = req.params as { curatorId: string };
    const result = roadie.retry(curatorId);
    if (result.ok) return { retried: curatorId, resumedFrom: result.state };
    return reply.code(result.error === "not found" ? 404 : 409).send({
      error: result.error,
      state: result.state,
    });
  });

  app.post("/api/agent/pause", async () => {
    roadie.pause();
    return roadie.status();
  });

  app.post("/api/agent/resume", async () => {
    roadie.resume();
    return roadie.status();
  });

  // --- Settings: Spotify credentials ---
  // The packaged desktop app has no repo `.env`, so credentials are entered in-app and persisted to
  // the data dir (settings.json). Curator's UI is unauthenticated on the LAN (like Home Assistant),
  // same trust model as the rest of these routes. clientId is not a secret (it's a public OAuth id);
  // the client secret is write-only — never returned.
  app.get("/api/settings/spotify", async () => ({
    configured: Boolean(spotify),
    clientId: config.spotify?.clientId ?? null,
  }));

  // Gemini settings: same trust model + settings.json store as Spotify. The key is write-only (never
  // returned); `configured` + the opt-in generation flags are the read-back so the UI can reflect them.
  /**
   * What the flags will be **after the next restart** — which is what a control bound to them has to
   * show. `genCardArt`/`genVideo` are captured at boot and drive the running pipeline; answering with
   * those meant a PUT was never reflected, so Settings' checkboxes snapped back on the next poll and
   * the setting looked broken ([#240](https://github.com/dylanleatham/Marquee/issues/240)).
   *
   * `settings.json` is the *lowest* link in the boot chain (config.ts), so a flag pinned in
   * `config.toml` or the environment still answers with the pinned value, and says it is pinned —
   * a click on it genuinely cannot take effect, and the screen must say so rather than lose quietly.
   */
  app.get("/api/settings/gemini", async () => {
    const stored = readSettings(config.dataDir).gemini ?? {};
    const cardArtPinned = config.gemini?.generateCardArtPinned ?? false;
    const videoPinned = config.gemini?.generateVideoPinned ?? false;
    return {
      configured: Boolean(gemini),
      generateCardArt: cardArtPinned
        ? genCardArt
        : (opts.generateCardArt ?? stored.generateCardArt ?? genCardArt),
      generateVideo: videoPinned
        ? genVideo
        : (opts.generateVideo ?? stored.generateVideo ?? genVideo),
      generateCardArtPinned: cardArtPinned,
      generateVideoPinned: videoPinned,
    };
  });

  // Update the key and/or the generation toggles. Any provided field is applied (the others are
  // preserved), so you can toggle generation without re-entering the key. Everything is built once
  // at boot, so changes take effect on restart.
  app.put("/api/settings/gemini", async (req, reply) => {
    const { apiKey, generateCardArt, generateVideo } = (req.body ?? {}) as {
      apiKey?: string;
      generateCardArt?: boolean;
      generateVideo?: boolean;
    };
    const patch: {
      apiKey?: string;
      generateCardArt?: boolean;
      generateVideo?: boolean;
    } = {};
    if (apiKey !== undefined) {
      if (!apiKey.trim())
        return reply.code(400).send({ error: "apiKey cannot be blank" });
      patch.apiKey = apiKey.trim();
    }
    if (typeof generateCardArt === "boolean")
      patch.generateCardArt = generateCardArt;
    if (typeof generateVideo === "boolean") patch.generateVideo = generateVideo;
    if (Object.keys(patch).length === 0)
      return reply
        .code(400)
        .send({ error: "provide apiKey and/or generateCardArt/generateVideo" });
    updateGeminiSettings(config.dataDir, patch);
    return { ok: true, restartRequired: true };
  });

  app.put("/api/settings/spotify", async (req, reply) => {
    const { clientId, clientSecret } = (req.body ?? {}) as {
      clientId?: string;
      clientSecret?: string;
    };
    if (!clientId?.trim() || !clientSecret?.trim())
      return reply
        .code(400)
        .send({ error: "clientId and clientSecret are required" });
    writeSpotifyCreds(config.dataDir, {
      clientId: clientId.trim(),
      clientSecret: clientSecret.trim(),
    });
    // The Spotify client + Roadie are built once at boot, so new creds take effect on restart.
    return { ok: true, restartRequired: true };
  });

  // --- Settings: Discogs personal access token + OAuth consumer creds (issue #59) ---
  // Token auth per
  // [ADR 0017](../../../docs/adrs/0017-discogs-personal-token-and-direct-images.md).
  // Same trust model + settings.json store as Spotify. Secrets are write-only (never returned);
  // `configured` (token), `oauthConfigured` (consumer creds present), and the (optional) username are
  // the read-back so the UI can reflect them.
  app.get("/api/settings/discogs", async () => ({
    configured: Boolean(discogs),
    oauthConfigured: Boolean(discogsAuth),
    username: config.discogs?.username ?? null,
    // The poller's live state, not the stored setting: after a toggle they agree, and when Discogs
    // isn't configured the poller is the one telling the truth about whether anything is polling.
    autoSync: discogsPoller.enabled,
    autoSyncIntervalMinutes: Math.round(discogsPoller.intervalMs / 60_000),
  }));

  app.put("/api/settings/discogs", async (req, reply) => {
    const {
      token,
      username,
      consumerKey,
      consumerSecret,
      autoSync,
      autoSyncIntervalMinutes,
    } = (req.body ?? {}) as {
      token?: string;
      username?: string;
      consumerKey?: string;
      consumerSecret?: string;
      autoSync?: boolean;
      autoSyncIntervalMinutes?: number;
    };
    // Accept a personal token, OAuth consumer creds, or both — but not an empty save.
    const hasToken = Boolean(token?.trim());
    const hasConsumer = Boolean(consumerKey?.trim() && consumerSecret?.trim());
    const hasAutoSync =
      autoSync !== undefined || autoSyncIntervalMinutes !== undefined;
    if (!hasToken && !hasConsumer && username === undefined && !hasAutoSync)
      return reply
        .code(400)
        .send({ error: "provide a token and/or OAuth consumer key + secret" });
    if (
      autoSyncIntervalMinutes !== undefined &&
      (!Number.isFinite(autoSyncIntervalMinutes) ||
        autoSyncIntervalMinutes <= 0)
    )
      return reply
        .code(400)
        .send({ error: "autoSyncIntervalMinutes must be a positive number" });
    writeDiscogsSettings(config.dataDir, {
      ...(hasToken ? { token: token!.trim() } : {}),
      ...(username !== undefined ? { username } : {}),
      ...(hasConsumer
        ? {
            consumerKey: consumerKey!.trim(),
            consumerSecret: consumerSecret!.trim(),
          }
        : {}),
      ...(autoSync !== undefined ? { autoSync } : {}),
      ...(autoSyncIntervalMinutes !== undefined
        ? { autoSyncIntervalMinutes }
        : {}),
    });
    // Auto-sync is only a timer, so it takes effect now — a toggle that meant "restart Curator"
    // would be a broken toggle. Credentials still need a restart: the Discogs client and OAuth
    // manager are built once at boot.
    if (hasAutoSync)
      discogsPoller.reconfigure({
        enabled: Boolean(discogs) && (autoSync ?? discogsPoller.enabled),
        intervalMs:
          (autoSyncIntervalMinutes ?? discogsPoller.intervalMs / 60_000) *
          60_000,
      });
    return { ok: true, restartRequired: hasToken || hasConsumer };
  });

  // --- Discogs OAuth 1.0a "log in with Discogs" (issue #59) — mirrors the Spotify auth routes ---
  // Start a login: hand the SPA the authorize URL to open. Request token + secret are held server-side.
  app.get("/api/discogs/auth/login", async (_req, reply) => {
    if (!discogsAuth)
      return reply.code(503).send({
        error: "Discogs OAuth not configured (set consumer key + secret)",
      });
    try {
      return { authorizeUrl: await discogsAuth.buildAuthorizeUrl() };
    } catch (err) {
      const msg =
        err instanceof DiscogsOAuthError ? err.message : "unexpected error";
      return reply.code(502).send({ error: msg });
    }
  });

  // The redirect target. Hit directly in the browser (not the SPA), so it answers with HTML.
  app.get("/api/discogs/auth/callback", async (req, reply) => {
    const { oauth_token, oauth_verifier, denied } = req.query as {
      oauth_token?: string;
      oauth_verifier?: string;
      denied?: string;
    };
    reply.type("text/html");
    if (!discogsAuth)
      return reply
        .code(503)
        .send(callbackHtml("Discogs OAuth is not configured."));
    if (denied) return reply.send(callbackHtml("Discogs login was cancelled."));
    if (!oauth_token || !oauth_verifier)
      return reply
        .code(400)
        .send(callbackHtml("Missing OAuth token or verifier."));
    try {
      await discogsAuth.handleCallback(oauth_token, oauth_verifier);
      return reply.send(
        callbackHtml(
          "Discogs connected. You can close this tab and return to Marquee.",
          true,
        ),
      );
    } catch (err) {
      const msg =
        err instanceof DiscogsOAuthError ? err.message : "unexpected error";
      return reply.code(400).send(callbackHtml(`Login failed: ${msg}.`));
    }
  });

  app.get(
    "/api/discogs/auth/status",
    async () => discogsAuth?.status() ?? { connected: false },
  );

  app.post("/api/discogs/auth/disconnect", async (_req, reply) => {
    if (!discogsAuth)
      return reply.code(503).send({ error: "Discogs OAuth not configured" });
    discogsAuth.disconnect();
    return { ok: true };
  });

  // --- Discogs collection (read-only browse; add happens through POST /api/albums) ---
  // Paginated: the UI reads `page`/`pages` to fetch the rest. The username is resolved once (from
  // config or the token's identity) and cached.
  app.get("/api/discogs/collection", async (req, reply) => {
    if (!discogs)
      return reply.code(503).send({ error: "Discogs not configured" });
    const q = req.query as { page?: string; perPage?: string };
    const page = q.page ? Number(q.page) : 1;
    const perPage = q.perPage ? Number(q.perPage) : 50;
    if (!Number.isFinite(page) || page < 1)
      return reply.code(400).send({ error: "page must be a positive integer" });
    try {
      const username = await resolveDiscogsUsername();
      return await discogs.getCollection(username, { page, perPage });
    } catch (err) {
      return discogsErr(err, reply);
    }
  });

  /**
   * Sweep the whole Discogs collection into the library (issue #234) — the "Sync collection" button,
   * and the same call the auto-poller makes. 202 + a job, never inline: a large collection is minutes
   * of paging and then hours of Roadie, which no HTTP request should hold open.
   *
   * This one route is both the initial import and every later refresh. Dedupe is on the Discogs
   * release id, so re-running only adds what's new, and `jobs.start` dedupes library-scoped jobs of a
   * kind — pressing the button during a running sweep reattaches to it.
   *
   * Costs no LLM credits: the sweep only enqueues, and Roadie's pipeline ends at `awaiting_review`
   * (ADR 0027). Prompt drafting and generation stay deliberate per-album actions.
   */
  const startDiscogsSync = (): GenerationJob | undefined => {
    if (!discogs) return undefined;
    return jobs.start(
      "discogsSync",
      undefined,
      discogsSyncRunner({
        store,
        roadie,
        discogs,
        resolveUsername: resolveDiscogsUsername,
        logger: {
          info: (m) => app.log.info(m),
          warn: (m) => app.log.warn(m),
        },
      }),
    );
  };

  /**
   * **Backfill the Spotify identity of Discogs albums** (ADR 0059).
   *
   * Curator has matched Discogs releases to Spotify since issue #58 to borrow the cover, and threw
   * the identity away — so a Discogs-swept library holds albums Curator can name but nothing can
   * play. The onboarding step now keeps it; this re-runs the match for everything already on disk.
   *
   * A job rather than a request: one Spotify search per album, so a real collection is minutes of
   * network that no HTTP request should hold open. `jobs.start` dedupes library-scoped jobs of a
   * kind, so pressing it twice reattaches rather than starting a second sweep.
   *
   * Never overwrites an existing `spotifyUri`, and only an `exact` match sets one — a `close` match
   * still just lends its cover.
   */
  app.post("/api/albums/spotify-backfill", async (_req, reply) => {
    if (!spotify)
      return reply.code(503).send({ error: "Spotify not configured" });
    const job = jobs.start(
      "spotifyBackfill",
      undefined,
      spotifyBackfillRunner({
        store,
        spotify,
        logger: {
          info: (m) => app.log.info(m),
          warn: (m) => app.log.warn(m),
        },
      }),
    );
    return reply.code(202).send(job);
  });

  app.post("/api/discogs/sync", async (_req, reply) => {
    const job = startDiscogsSync();
    if (!job) return reply.code(503).send({ error: "Discogs not configured" });
    return reply.code(202).send(job);
  });

  // Auto-sync status — what the Settings screen shows next to the toggle ("last checked at …").
  app.get("/api/discogs/sync/status", async () => discogsPoller.status());

  /**
   * The auto-poller (issue #234): fires the sweep above on a timer so records added on Discogs turn
   * up without anyone pressing anything. Opt-in, and only meaningful when Discogs is configured.
   * Stopped on app close so a test server (or a closed desktop window) leaves no timer behind.
   */
  const discogsPoller =
    opts.discogsPoller ??
    new DiscogsPoller({
      trigger: startDiscogsSync,
      enabled: Boolean(discogs) && Boolean(config.discogs?.autoSync),
      ...(config.discogs?.autoSyncIntervalMinutes !== undefined
        ? { intervalMs: config.discogs.autoSyncIntervalMinutes * 60_000 }
        : {}),
      logger: { info: (m) => app.log.info(m), warn: (m) => app.log.warn(m) },
    });
  discogsPoller.start();
  app.addHook("onClose", async () => {
    discogsPoller.stop();
  });

  // --- Spotify (read-only preview; add happens through POST /api/albums) ---
  app.get("/api/spotify/search-albums", async (req, reply) => {
    if (!spotify)
      return reply.code(503).send({ error: "Spotify not configured" });
    const q = (req.query as { q?: string }).q;
    if (!q) return reply.code(400).send({ error: "q is required" });
    try {
      return { results: await spotify.searchAlbums(q) };
    } catch (err) {
      return spotifyErr(err, reply);
    }
  });

  app.get("/api/spotify/album/:spotifyId", async (req, reply) => {
    if (!spotify)
      return reply.code(503).send({ error: "Spotify not configured" });
    try {
      return await spotify.getAlbum(
        (req.params as { spotifyId: string }).spotifyId,
      );
    } catch (err) {
      return spotifyErr(err, reply);
    }
  });

  // --- Spotify user login (Authorization Code + PKCE, issue #23 / ADR 0014) ---
  // Log in as a real Spotify user so calls run through the user session (personalized search now,
  // Spotify Connect playback later). The desktop app opens `authorizeUrl` in the system browser;
  // Spotify redirects back to the loopback callback below, which completes the token exchange.
  // Login only needs the (public) clientId, but we gate on `spotifyAuth` — built whenever creds are
  // configured — to keep one "Spotify configured?" story.

  // Start a login: hand the SPA the authorize URL to open. (State + PKCE are held server-side.)
  app.get("/api/spotify/auth/login", async (_req, reply) => {
    if (!spotifyAuth)
      return reply.code(503).send({ error: "Spotify not configured" });
    return { authorizeUrl: spotifyAuth.buildAuthorizeUrl() };
  });

  // The redirect target. Hit directly in the browser (not via the SPA), so it answers with HTML.
  app.get("/api/spotify/auth/callback", async (req, reply) => {
    const { code, state, error } = req.query as {
      code?: string;
      state?: string;
      error?: string;
    };
    reply.type("text/html");
    if (!spotifyAuth)
      return reply.code(503).send(callbackHtml("Spotify is not configured."));
    // Spotify sends `error=access_denied` when the user declines consent.
    if (error)
      return reply.send(
        callbackHtml(`Spotify login was cancelled (${error}).`),
      );
    if (!code || !state)
      return reply
        .code(400)
        .send(callbackHtml("Missing authorization code or state."));
    try {
      await spotifyAuth.handleCallback(code, state);
      return reply.send(
        callbackHtml(
          "Spotify connected. You can close this tab and return to Marquee.",
          true,
        ),
      );
    } catch (err) {
      const msg =
        err instanceof SpotifyAuthError ? err.message : "unexpected error";
      return reply.code(400).send(callbackHtml(`Login failed: ${msg}.`));
    }
  });

  // Whether a user is connected + the granted scopes (backs the Settings connect/disconnect UI).
  app.get(
    "/api/spotify/auth/status",
    async () => spotifyAuth?.status() ?? { connected: false },
  );

  // Disconnect: forget the refresh token. Takes effect immediately (no restart).
  app.post("/api/spotify/auth/disconnect", async (_req, reply) => {
    if (!spotifyAuth)
      return reply.code(503).send({ error: "Spotify not configured" });
    spotifyAuth.disconnect();
    return { ok: true };
  });

  // --- Add an album. Multipart → manual entry (with cover upload); JSON → Spotify. ---
  app.post("/api/albums", async (req, reply) => {
    if (req.isMultipart()) {
      try {
        // Parse inside the try so multipart/busboy errors get a clean 4xx.
        const fields: Record<string, string> = {};
        let artwork: Buffer | undefined;
        for await (const part of req.parts()) {
          if (part.type === "file") artwork = await part.toBuffer();
          else fields[part.fieldname] = String(part.value);
        }
        const { curatorId, asset } = await addManualAlbum(
          { store, roadie },
          {
            name: fields.name ?? "",
            artist: fields.artist ?? "",
            year: fields.year ? Number(fields.year) : undefined,
            genres: fields.genres
              ?.split(",")
              .map((s) => s.trim())
              .filter(Boolean),
            artwork: artwork ?? Buffer.alloc(0),
          },
        );
        return created(reply, curatorId, asset);
      } catch (err) {
        if (err instanceof ValidationError)
          return reply.code(400).send({ error: err.message });
        const status = (err as { statusCode?: number }).statusCode;
        if (status && status >= 400 && status < 500)
          return reply.code(status).send({ error: (err as Error).message });
        req.log.error(err);
        return reply.code(500).send({ error: (err as Error).message });
      }
    }

    // JSON body → Spotify or Discogs add, dispatched on the payload shape.
    const body = (req.body ?? {}) as {
      spotifyUri?: string;
      spotifyId?: string;
      releaseId?: number;
      discogsReleaseId?: number;
      title?: string;
      artist?: string;
      year?: number;
      genres?: string[];
      coverImage?: string;
    };

    // Discogs add: a release id (from the collection browser).
    const releaseId = body.releaseId ?? body.discogsReleaseId;
    if (releaseId !== undefined) {
      if (!discogs)
        return reply.code(503).send({ error: "Discogs not configured" });
      try {
        const { curatorId, asset } = await addDiscogsAlbum(
          { store, roadie },
          {
            releaseId,
            ...(body.title !== undefined ? { title: body.title } : {}),
            ...(body.artist !== undefined ? { artist: body.artist } : {}),
            ...(body.year !== undefined ? { year: body.year } : {}),
            ...(body.genres !== undefined ? { genres: body.genres } : {}),
            ...(body.coverImage !== undefined
              ? { coverImage: body.coverImage }
              : {}),
          },
        );
        return created(reply, curatorId, asset);
      } catch (err) {
        if (err instanceof DuplicateAlbumError)
          return reply
            .code(409)
            .send({ error: err.message, curatorId: err.curatorId });
        if (err instanceof ValidationError)
          return reply.code(400).send({ error: err.message });
        req.log.error(err);
        return reply.code(500).send({ error: (err as Error).message });
      }
    }

    // Otherwise → Spotify add.
    if (!spotify) {
      return reply.code(503).send({
        error: "Spotify not configured (set SPOTIFY_CLIENT_ID/SECRET)",
      });
    }
    try {
      const { curatorId, asset } = await addSpotifyAlbum(
        { store, roadie },
        body,
      );
      return created(reply, curatorId, asset);
    } catch (err) {
      if (err instanceof DuplicateAlbumError)
        return reply
          .code(409)
          .send({ error: err.message, curatorId: err.curatorId });
      if (err instanceof ValidationError)
        return reply.code(400).send({ error: err.message });
      if (err instanceof SpotifyError)
        return reply.code(spotifyStatus(err)).send({ error: err.message });
      req.log.error(err);
      return reply.code(500).send({ error: (err as Error).message });
    }
  });

  /**
   * Add a pasted list in one call (curator-spec §8, issue #104). Always 200 for a well-formed
   * request: partial success is the normal outcome of pasting twenty lines, so per-item outcomes go
   * in the body rather than one status code standing for all of them. A malformed *envelope* (not an
   * array, empty, over the cap) is still a 400 — that's a client bug, not a bad line.
   */
  app.post("/api/albums/batch", async (req, reply) => {
    if (!spotify)
      return reply.code(503).send({
        error: "Spotify not configured (set SPOTIFY_CLIENT_ID/SECRET)",
      });
    const { items } = (req.body ?? {}) as { items?: BatchAddItem[] };
    try {
      return await addAlbumsBatch({ store, roadie }, items as BatchAddItem[]);
    } catch (err) {
      if (err instanceof ValidationError)
        return reply.code(400).send({ error: err.message });
      req.log.error(err);
      return reply.code(500).send({ error: (err as Error).message });
    }
  });

  /**
   * Re-derive every algorithmic palette (curator-spec §Palettes). A library-scoped background job on
   * the ADR 0018 manager, not the SSE stream the spec originally assumed — see ADR 0029. `?force=1`
   * includes hand-edited palettes, which the sweep otherwise skips. Starting it twice reattaches to
   * the running sweep rather than walking the collection again.
   *
   * Sends the job as the body, like every other job-starting route — `202` means "here is your job."
   */
  app.post("/api/batch/regenerate-palettes", async (req, reply) => {
    if (!actionDeps.generate)
      return reply
        .code(503)
        .send({ error: "palette generator isn't available" });
    const force = (req.query as { force?: string }).force === "1";
    const job = jobs.start(
      "paletteBatch",
      undefined,
      regeneratePalettesRunner(actionDeps, { force }),
    );
    return reply.code(202).send(job);
  });

  // Serve the built React UI (packages/curator/dist-ui) when present. It's absent in dev/test —
  // there the Vite dev server serves the UI and proxies /api here (see ui/vite.config.ts). Same
  // path resolves from src/ (tsx) and dist/ (prod): both sit one level under packages/curator/.
  const uiDir =
    opts.uiDir ?? fileURLToPath(new URL("../dist-ui", import.meta.url));
  if (existsSync(uiDir)) {
    /*
     * `wildcard: true` — one `/*` route that resolves against the filesystem per request, rather
     * than a route per file enumerated by a glob at registration ([ADR 0053](../../../docs/adrs/0053-the-ui-is-served-per-request-not-enumerated-at-boot.md)).
     *
     * Enumerating meant the running process only ever knew the filenames that existed when it
     * booted. Vite content-hashes every build, so a rebuild produced names it had no route for: the
     * freshly-built `index.html` was served (that one file kept its name) while every asset it
     * pointed at 404'd, and Curator came up blank ([#241](https://github.com/dylanleatham/Marquee/issues/241)).
     * A miss still reaches `setNotFoundHandler`, so #183's narrow fallback below is unaffected —
     * that is what the tests in `test/ui-static.test.ts` pin down.
     */
    app.register(fastifyStatic, { root: uiDir, wildcard: true });
    // SPA fallback: a non-/api GET for a *client route* returns index.html so routes like
    // /albums/:id deep-link and reload correctly. An asset miss must 404 — see `servesSpaFallback`.
    //
    // Read per request, for the same reason: a buffer taken at registration meant that after a
    // rebuild a deep link served HTML naming the *previous* bundle, which is the blank screen again
    // by a slower route. It is one small file off the OS page cache, on a miss only.
    const indexHtmlPath = join(uiDir, "index.html");
    app.setNotFoundHandler((req, reply) => {
      if (servesSpaFallback(req.method, req.url)) {
        return reply.type("text/html").send(readFileSync(indexHtmlPath));
      }
      return reply.code(404).send({ error: "not found" });
    });
  }

  // Resume any album left mid-processing by a previous run (roadie-spec §5 crash resilience).
  roadie.recover();

  return { app, config, store, spotify, spotifyAuth, discogs, roadie, jobs };
}

/**
 * Load the repo-root `.env` into process.env before config is read, so Spotify creds (and any other
 * secrets kept there) work in both `dev` and the built server with no `--env-file` flag or
 * `config.toml`. Missing/malformed `.env` is fine — we fall back to the real environment.
 */
function loadRootEnv(): void {
  const load = (process as { loadEnvFile?: (p: string) => void }).loadEnvFile;
  if (typeof load !== "function") return; // older Node — skip silently
  const envPath = join(
    resolve(dirname(fileURLToPath(import.meta.url)), "../../.."),
    ".env",
  );
  if (!existsSync(envPath)) return;
  try {
    load(envPath);
  } catch {
    /* malformed .env — ignore and use the real environment */
  }
}

/** Best-effort "open the app in the browser" for the `--open` convenience flag. */
function openBrowser(url: string): void {
  const win = process.platform === "win32";
  const cmd = win ? "cmd" : process.platform === "darwin" ? "open" : "xdg-open";
  const args = win ? ["/c", "start", "", url] : [url];
  try {
    spawn(cmd, args, { stdio: "ignore", detached: true }).unref();
  } catch {
    /* no browser / headless — the logged URL is enough */
  }
}

async function start(): Promise<void> {
  loadRootEnv();
  const { app, config } = buildServer();
  // Probe ffmpeg *before* listening: it's a synchronous spawn, so doing it once we're serving would
  // block the event loop (and every in-flight request) if the binary hangs.
  const haveFfmpeg = ffmpegAvailable();

  await app.listen({ port: config.port, host: config.host });
  const url = `http://${config.host}:${config.port}`;
  app.log.info(`Curator ready → ${url}  (data: ${config.dataDir})`);
  if (!config.spotify)
    app.log.warn(
      "Spotify not configured — search + add-by-URI disabled (manual add still works). " +
        "Set SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET in .env or config.toml.",
    );
  if (!haveFfmpeg)
    app.log.warn(
      "ffmpeg not found — video attach will fail. Install ffmpeg on PATH, or set FFPROBE_PATH / FFMPEG_PATH.",
    );
  if (process.argv.includes("--open")) openBrowser(url);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  start().catch((err) => {
    // Structured, fingerprinted (issue #142) — the shell captures this stream into the
    // rotating log (issue #141), and a boot failure is exactly what needs to survive it.
    createLogger({ service: "curator" }).error("Failed to start", err);
    process.exit(1);
  });
}
