import { pathToFileURL } from "node:url";
import Fastify, { type FastifyReply } from "fastify";
import multipart from "@fastify/multipart";
import { loadConfig, type Config } from "./config.js";
import { AssetStore } from "./store/asset-store.js";
import {
  addManualAlbum,
  ValidationError,
  type PaletteGenerator,
} from "./albums/add-manual.js";
import { addSpotifyAlbum, DuplicateAlbumError } from "./albums/add-spotify.js";
import { SpotifyClient, SpotifyError } from "./spotify/client.js";
import type { AlbumAsset } from "./albums/asset.js";

export interface BuildOptions {
  config?: Partial<Config>;
  store?: AssetStore;
  /** Injected palette generator (tests pass a fake; prod uses real Palette Press). */
  generate?: PaletteGenerator;
  /** Injected Spotify client (tests pass one backed by fake-spotify); prod builds from config. */
  spotify?: SpotifyClient;
}

const summary = (a: AlbumAsset) => ({
  curatorId: a.curatorId,
  title: a.metadata.name,
  artist: a.metadata.artist,
  source: a.metadata.source,
  state: a.roadie.state,
  createdAt: a.createdAt,
  artwork: a.artwork.resolvedPath,
  paletteColors: a.palette.colors.length,
  paletteInsufficient: a.roadie.flags.palette_insufficient,
});

const created = (reply: FastifyReply, curatorId: string, asset: AlbumAsset) =>
  reply.code(201).send({
    curatorId,
    source: asset.metadata.source,
    state: asset.roadie.state,
    paletteColors: asset.palette.colors.length,
    paletteInsufficient: asset.roadie.flags.palette_insufficient,
  });

const spotifyErr = (err: unknown, reply: FastifyReply) => {
  if (err instanceof SpotifyError)
    return reply
      .code(err.status === 404 ? 404 : 502)
      .send({ error: err.message });
  throw err;
};

export function buildServer(opts: BuildOptions = {}) {
  const config = loadConfig(opts.config);
  const store = opts.store ?? new AssetStore(config.dataDir);
  const spotify =
    opts.spotify ??
    (config.spotify ? new SpotifyClient(config.spotify) : undefined);
  const app = Fastify({
    logger: { level: process.env.NODE_ENV === "test" ? "silent" : "info" },
  });
  app.register(multipart, { limits: { fileSize: 25 * 1024 * 1024 } });

  app.get("/healthz", async () => ({
    ok: true,
    albums: store.list().length,
    spotify: Boolean(spotify),
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
          { store, generate: opts.generate },
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
        { store, spotify, generate: opts.generate },
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
        return reply
          .code(err.status === 404 ? 404 : 502)
          .send({ error: err.message });
      req.log.error(err);
      return reply.code(500).send({ error: (err as Error).message });
    }
  });

  return { app, config, store, spotify };
}

async function start(): Promise<void> {
  const { app, config } = buildServer();
  await app.listen({ port: config.port, host: config.host });
  app.log.info(`Curator data dir: ${config.dataDir}`);
  if (!config.spotify)
    app.log.warn(
      "Spotify not configured — /api/spotify/* and JSON add will 503.",
    );
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
