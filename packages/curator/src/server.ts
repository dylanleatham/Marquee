import { pathToFileURL } from "node:url";
import Fastify from "fastify";
import multipart from "@fastify/multipart";
import { loadConfig, type Config } from "./config.js";
import { AssetStore } from "./store/asset-store.js";
import {
  addManualAlbum,
  ValidationError,
  type PaletteGenerator,
} from "./albums/add-manual.js";
import type { AlbumAsset } from "./albums/asset.js";

export interface BuildOptions {
  config?: Partial<Config>;
  store?: AssetStore;
  /** Injected palette generator (tests pass a fake; prod uses real Palette Press). */
  generate?: PaletteGenerator;
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

export function buildServer(opts: BuildOptions = {}) {
  const config = loadConfig(opts.config);
  const store = opts.store ?? new AssetStore(config.dataDir);
  const app = Fastify({
    logger: { level: process.env.NODE_ENV === "test" ? "silent" : "info" },
  });
  app.register(multipart, { limits: { fileSize: 25 * 1024 * 1024 } });

  app.get("/healthz", async () => ({ ok: true, albums: store.list().length }));

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

  // Manual add. multipart/form-data: text fields name, artist, year?, genres? + an `artwork` file.
  app.post("/api/albums", async (req, reply) => {
    if (!req.isMultipart()) {
      return reply.code(415).send({
        error: "POST an album as multipart/form-data with an artwork file",
      });
    }
    try {
      // Inside the try so multipart/busboy errors (oversized file, malformed stream, aborted
      // upload) get a clean 4xx instead of falling through to the generic error handler.
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
      return reply.code(201).send({
        curatorId,
        state: asset.roadie.state,
        paletteInsufficient: asset.roadie.flags.palette_insufficient,
        paletteColors: asset.palette.colors.length,
      });
    } catch (err) {
      if (err instanceof ValidationError)
        return reply.code(400).send({ error: err.message });
      // @fastify/multipart raises client errors (413 file too large, 400 malformed) with a
      // 4xx statusCode — surface those rather than a blanket 500.
      const status = (err as { statusCode?: number }).statusCode;
      if (status && status >= 400 && status < 500)
        return reply.code(status).send({ error: (err as Error).message });
      req.log.error(err);
      return reply.code(500).send({ error: (err as Error).message });
    }
  });

  return { app, config, store };
}

async function start(): Promise<void> {
  const { app, config } = buildServer();
  await app.listen({ port: config.port, host: config.host });
  app.log.info(`Curator data dir: ${config.dataDir}`);
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
