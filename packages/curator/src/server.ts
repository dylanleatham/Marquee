import { pathToFileURL, fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import {
  existsSync,
  readFileSync,
  createReadStream,
  createWriteStream,
  mkdirSync,
  rmSync,
  readdirSync,
  statSync,
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
import { addSpotifyAlbum, DuplicateAlbumError } from "./albums/add-spotify.js";
import { addDiscogsAlbum } from "./albums/add-discogs.js";
import { SpotifyClient, SpotifyError } from "./spotify/client.js";
import { SpotifyAuth, SpotifyAuthError } from "./spotify/auth.js";
import { DiscogsClient, DiscogsError } from "./discogs/client.js";
import { DiscogsOAuth, DiscogsOAuthError } from "./discogs/oauth.js";
import { GeminiClient } from "./gemini/client.js";
import {
  writeSpotifyCreds,
  writeDiscogsSettings,
  updateGeminiSettings,
} from "./settings.js";
import { Roadie } from "./roadie/worker.js";
import { isCuratorId } from "./ids.js";
import {
  TransitionError,
  type AlbumAsset,
  type RoadieState,
} from "./albums/asset.js";
import * as actions from "./albums/actions.js";
import { NotFoundError, type ActionDeps } from "./albums/actions.js";
import { GenerationJobs } from "./jobs/manager.js";
import { flipperNfcFile } from "./tags/flipper-nfc.js";
import {
  ffmpegProber,
  ffmpegAvailable,
  VideoError,
  type VideoProber,
} from "./media/video.js";
import { ImageError } from "./media/images.js";
import { buildPalettePayload, DemoNotReadyError } from "./demo/payload.js";
import type { PromptType } from "./roadie/prompts.js";
import { BackdropClient } from "./backdrop/client.js";
import {
  BackdropSync,
  disabledBackdropSync,
  localCopyTransfer,
  type BackdropSyncLike,
} from "./backdrop/sync.js";

export interface BuildOptions {
  config?: Partial<Config>;
  store?: AssetStore;
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
  /** Injected generation-job manager (tests may pass one with a fake clock); prod builds its own. */
  jobs?: GenerationJobs;
}

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
  if (err instanceof TransitionError)
    return reply.code(409).send({ error: err.message });
  if (err instanceof VideoError || err instanceof ImageError)
    return reply.code(422).send({ error: err.message });
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
  for (const asset of store.list()) {
    const state = asset.roadie.state as RoadieState;
    if (state === "verified") groups.done_recently!.push(queueEntry(asset));
    else if (state in groups) groups[state]!.push(queueEntry(asset));
    else groups.processing!.push(queueEntry(asset)); // fresh + all fetching/downloading/… states
  }
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
  // Discogs OAuth 1.0a "log in with Discogs" (issue #59): built whenever consumer creds are
  // configured. The client prefers a connected OAuth session's signed header and falls back to the
  // personal token (ADR 0016) — so both auth mechanisms coexist behind one DiscogsClient.
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
    generateCardArt: genCardArt,
    generateVideo: genVideo,
  };
  // Background jobs for the long-running AI generation actions (issue #30 / ADR 0018): the generate
  // routes enqueue here and return a jobId instead of holding the request open for minutes.
  const jobs = opts.jobs ?? new GenerationJobs();
  // Backdrop sync (step 9). Off unless a Backdrop URL is configured — then video attach/detach and
  // the manual resync/verify routes push Curator's library projection to Backdrop (roadie-spec §6).
  const backdrop: BackdropSyncLike =
    opts.backdrop ??
    (config.backdrop
      ? new BackdropSync({
          store,
          client: new BackdropClient({
            url: config.backdrop.url,
            ...(config.backdrop.sharedSecret
              ? { sharedSecret: config.backdrop.sharedSecret }
              : {}),
          }),
          backdropMediaDir: config.backdrop.mediaDir,
          ...(config.backdrop.syncMediaLocally
            ? { mediaTransfer: localCopyTransfer(config.backdrop.mediaDir) }
            : {}),
          logger: {
            info: (m) => app.log.info(m),
            warn: (m) => app.log.warn(m),
          },
        })
      : disabledBackdropSync);
  // Upload ceiling comes from config (default 2 GB) — visualizer videos are the large uploads;
  // cover/card art are tiny. Over-ceiling uploads surface as a 413 via actionError (issue #12).
  app.register(multipart, { limits: { fileSize: config.maxUploadBytes } });

  app.get("/healthz", async () => ({
    ok: true,
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
  app.get("/api/tags/pending", async () => ({
    pending: store
      .list()
      .filter((a) => a.roadie.state === "awaiting_tag_write")
      .map((a) => ({
        curatorId: a.curatorId,
        name: a.metadata.name,
        artist: a.metadata.artist,
      })),
  }));

  app.get("/api/albums/:curatorId/tag.nfc", async (req, reply) => {
    const { curatorId } = req.params as { curatorId: string };
    if (!store.read(curatorId))
      return reply.code(404).send({ error: "not found" });
    reply.header(
      "content-disposition",
      `attachment; filename="${curatorId}.nfc"`,
    );
    reply.type("application/octet-stream");
    return flipperNfcFile(curatorId);
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
    const file = store.paths.artworkFile(curatorId);
    if (!existsSync(file))
      return reply.code(404).send({ error: "artwork not available yet" });
    return reply
      .header("content-type", "image/jpeg")
      .header("cache-control", "no-cache")
      .send(createReadStream(file));
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

  // Print version: same image as a download. TODO: embed 300-DPI metadata / resize once we add an
  // image pipeline (curator-spec recommends 1050x600 @ 300 DPI); v1 serves the stored art verbatim.
  app.get("/api/albums/:curatorId/card-art/print", async (req, reply) => {
    const { curatorId } = req.params as { curatorId: string };
    const asset = store.read(curatorId);
    if (!asset?.cardArt) return reply.code(404).send({ error: "no card art" });
    const { ext } = asset.cardArt;
    return sendFile(
      reply,
      store.paths.cardArtFile(curatorId, ext),
      ext === "png" ? "image/png" : "image/jpeg",
      `${curatorId}-card.${ext}`,
    );
  });

  // --- Prompt actions (curator-spec §Prompts) ---
  app.post(
    "/api/albums/:curatorId/prompts/:type/redraft",
    async (req, reply) => {
      const { curatorId, type } = req.params as {
        curatorId: string;
        type: PromptType;
      };
      const { template } = (req.body ?? {}) as { template?: string };
      try {
        const asset = actions.redraftPrompt(
          actionDeps,
          curatorId,
          type,
          template,
        );
        return { promptDrafts: asset.promptDrafts };
      } catch (err) {
        return actionError(err, reply, req);
      }
    },
  );

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
          // ★sync (roadie-spec §6): a playable video just landed — push it to Backdrop (best-effort).
          await backdrop.syncAlbum(asset);
          return reply
            .code(201)
            .send({ curatorId: fields.curatorId, state: asset.roadie.state });
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

  app.get("/api/incoming", async () => {
    if (!existsSync(store.paths.incoming)) return { files: [] };
    const files = readdirSync(store.paths.incoming)
      .filter((n) => !n.startsWith(".")) // skip in-flight upload temp files
      .map((name) => ({
        name,
        sizeBytes: statSync(store.paths.incomingFile(name)).size,
      }));
    return { files };
  });

  app.post("/api/albums/:curatorId/attach-video", async (req, reply) => {
    const { curatorId } = req.params as { curatorId: string };
    const { fileId } = (req.body ?? {}) as { fileId?: string };
    if (!fileId) return reply.code(400).send({ error: "fileId is required" });
    try {
      const asset = await actions.attachVideoIncoming(
        actionDeps,
        curatorId,
        fileId,
      );
      // ★sync (roadie-spec §6): the album now has a playable video — push it to Backdrop. Best-effort;
      // a sync failure is recorded on the album, not raised, so the attach still succeeds.
      await backdrop.syncAlbum(asset);
      return { state: asset.roadie.state, visualizer: asset.visualizer };
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
      await backdrop.syncAlbum(asset);
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
      const asset = await actions.spliceVisualizer(actionDeps, curatorId, order, {
        crossfade,
      });
      // ★sync (roadie-spec §6): the album now has a playable video — push it to Backdrop.
      await backdrop.syncAlbum(asset);
      return { state: asset.roadie.state, visualizer: asset.visualizer };
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
    const job = jobs.start("video", curatorId, async ({ onProgress }) => {
      const asset = await actions.generateVideoSet(actionDeps, curatorId, {
        onProgress,
      });
      return { videoClips: asset.videoClips };
    });
    return reply.code(202).send(job);
  });

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

  app.post("/api/albums/:curatorId/attach-card-art", async (req, reply) => {
    const { curatorId } = req.params as { curatorId: string };
    const { fileId } = (req.body ?? {}) as { fileId?: string };
    if (!fileId) return reply.code(400).send({ error: "fileId is required" });
    try {
      const asset = actions.attachCardArtIncoming(
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
    const job = jobs.start("cardArt", curatorId, async ({ onProgress }) => {
      const asset = await actions.generateCardArtSet(actionDeps, curatorId, {
        onProgress,
      });
      return { cardArtCandidates: asset.cardArtCandidates };
    });
    return reply.code(202).send(job);
  });

  // Poll a generation job's status/progress/result (issue #30). 404 once unknown/expired.
  app.get("/api/jobs/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const job = jobs.get(id);
    return job ?? reply.code(404).send({ error: "job not found" });
  });

  // Active + recent generation jobs for an album — lets the detail page re-attach to a running job
  // after a reload (the original "a reload loses the result" failure mode, issue #30). Optional
  // ?kind=video|cardArt filter.
  app.get("/api/albums/:curatorId/jobs", async (req) => {
    const { curatorId } = req.params as { curatorId: string };
    const kind = (req.query as { kind?: string }).kind;
    const filter = kind === "video" || kind === "cardArt" ? kind : undefined;
    return { jobs: jobs.forAlbum(curatorId, filter) };
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

  // --- Tag write / verify (step 11, curator-spec §7) ---
  // Record that a physical sticker was written. Writing the sleeve (scanned on the stand) advances
  // awaiting_tag_write → awaiting_verify; the card is independent bookkeeping. Optional tagUid.
  app.post("/api/albums/:curatorId/tag-written", async (req, reply) => {
    const { curatorId } = req.params as { curatorId: string };
    const { object, tagUid } = (req.body ?? {}) as {
      object?: "sleeve" | "card";
      tagUid?: string;
    };
    if (object !== "sleeve" && object !== "card")
      return reply
        .code(400)
        .send({ error: 'object must be "sleeve" or "card"' });
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

  // Mark the album physically verified: awaiting_verify → verified, record physicallyVerifiedAt, then
  // fire the ★verify Backdrop reconcile (roadie-spec §6 / ADR 0015) — the last human step of onboarding.
  app.post("/api/albums/:curatorId/verify-physical", async (req, reply) => {
    const { curatorId } = req.params as { curatorId: string };
    try {
      const asset = actions.verifyPhysical(actionDeps, curatorId);
      // ★verify-on-verified: confirm Backdrop carries this album; discrepancies surface as syncIssues
      // (non-blocking — the album is verified regardless of Backdrop reachability).
      const verify = await backdrop.verifyAlbum(asset).catch((err) => ({
        ok: false,
        discrepancies: [`Backdrop verify unreachable: ${(err as Error).message}`],
      }));
      return { state: asset.roadie.state, verify };
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
      signal: AbortSignal.timeout(5000),
      headers: { ...headers, ...(init?.headers as Record<string, string>) },
    });
  };

  // Forward a Conductor response (status + JSON body) straight back to the browser.
  const forwardConductor = async (reply: FastifyReply, res: FetchResponse) => {
    const body = await res.json().catch(() => ({}));
    return reply.code(res.status).send(body);
  };

  // A fetch that throws means Conductor is down/unreachable — a clean 502 the UI can render.
  const conductorDown = (reply: FastifyReply, err: unknown) =>
    reply.code(502).send({
      error: `Hue Conductor not reachable at ${config.conductor.url} — is it running? (${(err as Error).message})`,
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

  // --- Backdrop sync (step 9, roadie-spec §6) — push Curator's library projection to Backdrop ---
  // Video attach/detach already sync automatically; these are the manual full-reconcile + verify
  // controls (curator-spec §9 "run sync from Curator" recovery, and the ★verify check).
  app.get("/api/backdrop/status", async () => ({ enabled: backdrop.enabled }));

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
        error: `Backdrop not reachable: ${(err as Error).message}`,
      });
    }
  });

  // --- Roadie: queue view + observability + controls (roadie-spec §10/§11/§12) ---
  app.get("/api/agent/queue", async () => buildQueue(store));

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
  app.get("/api/settings/gemini", async () => ({
    configured: Boolean(gemini),
    generateCardArt: genCardArt,
    generateVideo: genVideo,
  }));

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

  // --- Settings: Discogs personal access token (ADR 0016) + OAuth consumer creds (issue #59) ---
  // Same trust model + settings.json store as Spotify. Secrets are write-only (never returned);
  // `configured` (token), `oauthConfigured` (consumer creds present), and the (optional) username are
  // the read-back so the UI can reflect them.
  app.get("/api/settings/discogs", async () => ({
    configured: Boolean(discogs),
    oauthConfigured: Boolean(discogsAuth),
    username: config.discogs?.username ?? null,
  }));

  app.put("/api/settings/discogs", async (req, reply) => {
    const { token, username, consumerKey, consumerSecret } = (req.body ??
      {}) as {
      token?: string;
      username?: string;
      consumerKey?: string;
      consumerSecret?: string;
    };
    // Accept a personal token, OAuth consumer creds, or both — but not an empty save.
    const hasToken = Boolean(token?.trim());
    const hasConsumer = Boolean(consumerKey?.trim() && consumerSecret?.trim());
    if (!hasToken && !hasConsumer && username === undefined)
      return reply
        .code(400)
        .send({ error: "provide a token and/or OAuth consumer key + secret" });
    writeDiscogsSettings(config.dataDir, {
      ...(hasToken ? { token: token!.trim() } : {}),
      ...(username !== undefined ? { username } : {}),
      ...(hasConsumer
        ? {
            consumerKey: consumerKey!.trim(),
            consumerSecret: consumerSecret!.trim(),
          }
        : {}),
    });
    // The Discogs client + auth are built once at boot, so new creds take effect on restart.
    return { ok: true, restartRequired: true };
  });

  // --- Discogs OAuth 1.0a "log in with Discogs" (issue #59) — mirrors the Spotify auth routes ---
  // Start a login: hand the SPA the authorize URL to open. Request token + secret are held server-side.
  app.get("/api/discogs/auth/login", async (_req, reply) => {
    if (!discogsAuth)
      return reply
        .code(503)
        .send({ error: "Discogs OAuth not configured (set consumer key + secret)" });
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
      return reply.code(503).send(callbackHtml("Discogs OAuth is not configured."));
    if (denied)
      return reply.send(callbackHtml("Discogs login was cancelled."));
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

  // Serve the built React UI (packages/curator/dist-ui) when present. It's absent in dev/test —
  // there the Vite dev server serves the UI and proxies /api here (see ui/vite.config.ts). Same
  // path resolves from src/ (tsx) and dist/ (prod): both sit one level under packages/curator/.
  const uiDir = fileURLToPath(new URL("../dist-ui", import.meta.url));
  if (existsSync(uiDir)) {
    app.register(fastifyStatic, { root: uiDir, wildcard: false });
    // SPA fallback: a non-/api GET that isn't a real asset returns index.html so client-side
    // routes (e.g. /albums/:id) deep-link and reload correctly.
    const indexHtml = readFileSync(join(uiDir, "index.html"));
    app.setNotFoundHandler((req, reply) => {
      if (req.method === "GET" && !req.url.startsWith("/api")) {
        return reply.type("text/html").send(indexHtml);
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
    console.error("Failed to start Curator:", err);
    process.exit(1);
  });
}
