import { pathToFileURL, fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import {
  existsSync,
  readFileSync,
  createReadStream,
  readdirSync,
  statSync,
} from "node:fs";
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
import { SpotifyClient, SpotifyError } from "./spotify/client.js";
import { Roadie } from "./roadie/worker.js";
import { isCuratorId } from "./ids.js";
import {
  TransitionError,
  type AlbumAsset,
  type RoadieState,
} from "./albums/asset.js";
import * as actions from "./albums/actions.js";
import { NotFoundError, type ActionDeps } from "./albums/actions.js";
import {
  ffmpegProber,
  ffmpegAvailable,
  VideoError,
  type VideoProber,
} from "./media/video.js";
import { ImageError } from "./media/images.js";
import type { PromptType } from "./roadie/prompts.js";

export interface BuildOptions {
  config?: Partial<Config>;
  store?: AssetStore;
  /** Injected palette generator (tests pass a fake; prod uses real Palette Press). */
  generate?: PaletteGenerator;
  /** Injected Spotify client (tests pass one backed by fake-spotify); prod builds from config. */
  spotify?: SpotifyClient;
  /** Injected Roadie (tests pass one with fake time); prod builds one from store/spotify/generate. */
  roadie?: Roadie;
  /** Injected video prober (tests pass a fake); prod uses ffprobe/ffmpeg. */
  prober?: VideoProber;
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

// For the read-only GET routes: send SpotifyErrors, rethrow anything else.
const spotifyErr = (err: unknown, reply: FastifyReply) => {
  if (err instanceof SpotifyError)
    return reply.code(spotifyStatus(err)).send({ error: err.message });
  throw err;
};

// Map an onboarding-action error to a status: not found → 404, bad input → 400, illegal state
// transition → 409, rejected media → 422; anything else is an unexpected 500.
const actionError = (
  err: unknown,
  reply: FastifyReply,
  req: FastifyRequest,
) => {
  if (err instanceof NotFoundError)
    return reply.code(404).send({ error: err.message });
  if (err instanceof ValidationError)
    return reply.code(400).send({ error: err.message });
  if (err instanceof TransitionError)
    return reply.code(409).send({ error: err.message });
  if (err instanceof VideoError || err instanceof ImageError)
    return reply.code(422).send({ error: err.message });
  req.log.error(err);
  return reply.code(500).send({ error: (err as Error).message });
};

/** Read a multipart request into plain fields + an optional single file buffer. */
async function readUpload(req: FastifyRequest): Promise<{
  fields: Record<string, string>;
  file?: { buffer: Buffer; filename: string };
}> {
  const fields: Record<string, string> = {};
  let file: { buffer: Buffer; filename: string } | undefined;
  for await (const part of req.parts()) {
    if (part.type === "file")
      file = { buffer: await part.toBuffer(), filename: part.filename };
    else fields[part.fieldname] = String(part.value);
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
  const spotify =
    opts.spotify ??
    (config.spotify ? new SpotifyClient(config.spotify) : undefined);
  const app = Fastify({
    logger: { level: process.env.NODE_ENV === "test" ? "silent" : "info" },
  });
  const roadie =
    opts.roadie ??
    new Roadie({
      store,
      spotify,
      generate: opts.generate,
      logger: {
        info: (m) => app.log.info(m),
        warn: (m) => app.log.warn(m),
        error: (m) => app.log.error(m),
      },
    });
  const prober = opts.prober ?? ffmpegProber;
  const actionDeps: ActionDeps = { store, prober };
  // 500 MB ceiling — visualizer videos are the large uploads; cover/card art are tiny.
  app.register(multipart, { limits: { fileSize: 500 * 1024 * 1024 } });

  app.get("/healthz", async () => ({
    ok: true,
    albums: store.list().length,
    spotify: Boolean(spotify),
    roadie: roadie.status(),
  }));

  app.get("/api/albums", async () => ({ albums: store.list().map(summary) }));

  app.get("/api/albums/:curatorId", async (req, reply) => {
    const { curatorId } = req.params as { curatorId: string };
    const asset = store.read(curatorId);
    return asset ?? reply.code(404).send({ error: "not found" });
  });

  app.delete("/api/albums/:curatorId", async (req, reply) => {
    const { curatorId } = req.params as { curatorId: string };
    return store.delete(curatorId)
      ? { deleted: curatorId }
      : reply.code(404).send({ error: "not found" });
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

  // --- Video: upload / incoming / attach / detach ---
  app.post("/api/videos/upload", async (req, reply) => {
    if (!req.isMultipart())
      return reply.code(400).send({ error: "expected multipart/form-data" });
    try {
      const { fields, file } = await readUpload(req);
      if (!file?.buffer.length)
        return reply.code(400).send({ error: "a video file is required" });
      if (fields.curatorId) {
        const asset = await actions.attachVideoUpload(
          actionDeps,
          fields.curatorId,
          file.buffer,
          file.filename,
        );
        return reply
          .code(201)
          .send({ curatorId: fields.curatorId, state: asset.roadie.state });
      }
      const { name } = actions.saveIncoming(store, file.filename, file.buffer);
      return reply.code(201).send({ incoming: name });
    } catch (err) {
      return actionError(err, reply, req);
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
      return { state: asset.roadie.state };
    } catch (err) {
      return actionError(err, reply, req);
    }
  });

  // --- Card art: upload / attach / detach ---
  app.post("/api/card-art/upload", async (req, reply) => {
    if (!req.isMultipart())
      return reply.code(400).send({ error: "expected multipart/form-data" });
    try {
      const { fields, file } = await readUpload(req);
      if (!file?.buffer.length)
        return reply.code(400).send({ error: "an image file is required" });
      if (fields.curatorId) {
        const asset = actions.attachCardArtUpload(
          actionDeps,
          fields.curatorId,
          file.buffer,
          file.filename,
        );
        return reply
          .code(201)
          .send({ curatorId: fields.curatorId, cardArt: asset.cardArt });
      }
      const { name } = actions.saveIncoming(store, file.filename, file.buffer);
      return reply.code(201).send({ incoming: name });
    } catch (err) {
      return actionError(err, reply, req);
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

    // JSON body → Spotify add.
    if (!spotify) {
      return reply.code(503).send({
        error: "Spotify not configured (set SPOTIFY_CLIENT_ID/SECRET)",
      });
    }
    const body = (req.body ?? {}) as {
      spotifyUri?: string;
      spotifyId?: string;
    };
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

  return { app, config, store, spotify, roadie };
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
