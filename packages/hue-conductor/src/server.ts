import { pathToFileURL } from "node:url";
import Fastify from "fastify";
import { loadConfig, type Config } from "./config.js";
import { Store } from "./store.js";
import {
  BridgeAdapter,
  NotPairedError,
  type HueDriver,
} from "./bridge/adapter.js";
import { PlaybackEngine, type Timers } from "./playback/engine.js";
import {
  buildPalettePayload,
  PaletteNotReadyError,
  type PalettePayload,
  type ScanEvent,
} from "@marquee/contracts";
import {
  FsAlbumAssetReader,
  curatorIdFromUri,
  type AlbumAssetReader,
} from "./assets.js";

export interface BuildOptions {
  /** Config overrides (tests inject a shared secret + temp data dir). */
  config?: Partial<Config>;
  /** Pre-built store (tests seed a bridge record). */
  store?: Store;
  /** Injected Hue driver (tests pass a fake; prod uses the default node-hue-api driver). */
  driver?: HueDriver;
  /** Injected timers for the playback engine (tests step patterns deterministically). */
  timers?: Timers;
  /** Injected album-assets reader (tests seed albums in memory); prod reads the synced store. */
  assets?: AlbumAssetReader;
}

/** Parse a scan event at the boundary (mirrors Backdrop's parser). Returns null on a malformed body. */
function parseScan(body: unknown): ScanEvent | null {
  if (typeof body !== "object" || body === null) return null;
  const b = body as Record<string, unknown>;
  if (b.event === "stop") {
    return {
      event: "stop",
      readerId: b.readerId as string | undefined,
      at: String(b.at ?? ""),
    };
  }
  // A real start always carries a uri + tagUid (scan-event.schema.json requires both).
  if (
    b.event === "start" &&
    typeof b.uri === "string" &&
    b.uri.length > 0 &&
    typeof b.tagUid === "string" &&
    b.tagUid.length > 0
  ) {
    return {
      event: "start",
      uri: b.uri,
      tagUid: b.tagUid,
      readerId: b.readerId as string | undefined,
      at: String(b.at ?? ""),
    };
  }
  return null;
}

export function buildServer(opts: BuildOptions = {}) {
  const config = loadConfig(opts.config);
  const store = opts.store ?? new Store(config.dataDir);
  const bridge = new BridgeAdapter(store, opts.driver);
  const engine = new PlaybackEngine(bridge, {
    timers: opts.timers,
    // Honor config.toml's [runtime] idle_timeout_minutes (spec §9) — was previously inert.
    idleTimeoutMs: config.idleTimeoutMinutes * 60_000,
  });
  // Reads the synced album-assets store so a raw scan can drive the lights (issue #45 / ADR 0019).
  const assets = opts.assets ?? new FsAlbumAssetReader(config.albumAssetsDir);
  const app = Fastify({
    logger: { level: process.env.NODE_ENV === "test" ? "silent" : "info" },
  });

  // Shared-secret auth on everything except the health probe (conductor-spec §8).
  app.addHook("onRequest", async (req, reply) => {
    if (req.url === "/healthz" || req.method === "OPTIONS") return;
    if (!config.sharedSecret) return; // dev: auth disabled, warned at boot
    if (req.headers["x-trigger-secret"] !== config.sharedSecret) {
      await reply.code(401).send({
        error: "unauthorized",
        hint: "send the X-Trigger-Secret header",
      });
    }
  });

  app.get("/healthz", async () => ({
    ok: true,
    paired: Boolean(store.bridge),
  }));

  app.get("/api/bridge/discover", async () => ({
    bridges: await bridge.discover(),
  }));
  app.get("/api/bridge/status", async () => bridge.status());

  app.get("/api/rooms", async () => ({ rooms: await bridge.getRooms() }));
  app.get("/api/lights", async () => ({ lights: await bridge.getLights() }));

  app.post("/api/test/color", async (req, reply) => {
    const { roomId, hex } = (req.body ?? {}) as {
      roomId?: string;
      hex?: string;
    };
    if (!roomId || !hex) {
      return reply.code(400).send({ error: "roomId and hex are required" });
    }
    return bridge.setRoomColor(roomId, hex);
  });

  app.get("/api/settings", async () => store.settings);
  app.put("/api/settings", async (req) => {
    const { listeningRoomId } = (req.body ?? {}) as {
      listeningRoomId?: string | null;
    };
    return store.setListeningRoom(listeningRoomId ?? null);
  });

  // Resolve the target room: explicit roomId wins, else the configured listening room.
  const resolveRoom = (roomId?: string): string | null =>
    roomId ?? store.settings.listeningRoomId ?? null;

  // Start (or crossfade to) a palette+pattern on a room (conductor-spec §8/§9). The playback engine
  // snapshots the room on the first start and restores it on stop.
  app.post("/api/playback", async (req, reply) => {
    const body = (req.body ?? {}) as {
      roomId?: string;
      palette?: PalettePayload;
    };
    const roomId = resolveRoom(body.roomId);
    if (!roomId)
      return reply.code(400).send({
        error:
          "no room specified and no listening room configured — set one via PUT /api/settings",
      });
    const payload = body.palette;
    if (!payload?.palette?.colors?.length)
      return reply
        .code(400)
        .send({ error: "palette with at least one color is required" });
    return engine.start(roomId, payload);
  });

  // Stop a room's playback and fade the lights back to their pre-session snapshot.
  app.post("/api/playback/stop", async (req, reply) => {
    const { roomId } = (req.body ?? {}) as { roomId?: string };
    const target = resolveRoom(roomId);
    if (!target)
      return reply.code(400).send({
        error: "no room specified and no listening room configured",
      });
    await engine.stop(target);
    return { stopped: true, roomId: target };
  });

  // Runtime scan intake from Stylus (issue #45). Unlike /api/playback (Curator's Demo Room proxy,
  // ADR 0007), this is the real runtime entrypoint: a raw ScanEvent, resolved against the synced
  // album-assets store, drives the listening room. `start` → build the palette from the album and
  // play it; `stop` → restore the pre-scan snapshot. A valid scan we can't act on (no listening room,
  // album not synced yet, album not far enough along) degrades gracefully to a 202 "ignored" rather
  // than an error — a scan must never error-storm the always-on service (runtime-overview §9). The
  // engine arms the 90-min idle timeout on start, the safety net for a lost `stop`.
  app.post("/api/scan", async (req, reply) => {
    const scan = parseScan(req.body);
    if (!scan)
      return reply.code(400).send({
        error:
          "expected a scan event: start needs { uri, tagUid, at }, stop needs { at }",
      });

    const roomId = resolveRoom();

    if (scan.event === "stop") {
      if (!roomId)
        return reply
          .code(202)
          .send({ ok: true, action: "ignored", reason: "no listening room" });
      await engine.stop(roomId);
      return reply.code(202).send({ ok: true, action: "stopped", roomId });
    }

    // start
    if (!roomId) {
      req.log.warn(`scan ${scan.uri}: no listening room configured — staying put`);
      return reply
        .code(202)
        .send({ ok: true, action: "ignored", reason: "no listening room" });
    }
    const curatorId = curatorIdFromUri(scan.uri);
    if (!curatorId)
      return reply
        .code(400)
        .send({ error: `not a curator album URI: ${scan.uri}` });

    const asset = assets.read(curatorId);
    if (!asset) {
      req.log.warn(`scan ${scan.uri}: album not in synced store — staying put`);
      return reply
        .code(202)
        .send({ ok: true, action: "ignored", reason: "album not synced", curatorId });
    }

    let payload: PalettePayload;
    try {
      payload = buildPalettePayload(asset);
    } catch (err) {
      if (err instanceof PaletteNotReadyError) {
        req.log.warn(`scan ${scan.uri}: ${err.message} — staying put`);
        return reply
          .code(202)
          .send({ ok: true, action: "ignored", reason: "album not ready", curatorId });
      }
      throw err;
    }

    // Bridge failures bubble to the error handler (409 not paired / 502) like /api/playback does.
    const { playbackId } = await engine.start(roomId, payload);
    return reply
      .code(202)
      .send({ ok: true, action: "playing", roomId, curatorId, playbackId });
  });

  app.setErrorHandler((err, req, reply) => {
    req.log.error(err);
    if (err instanceof NotPairedError)
      return reply.code(409).send({ error: err.message });
    // Bridge/network failures surface as 502 rather than a generic 500.
    const e = err as { statusCode?: number; message: string };
    return reply.code(e.statusCode ?? 502).send({ error: e.message });
  });

  return { app, config };
}

async function start(): Promise<void> {
  const { app, config } = buildServer();
  if (!config.sharedSecret) {
    app.log.warn(
      "No shared secret configured — auth is DISABLED (dev). Set TRIGGER_SHARED_SECRET or config.toml [auth].shared_secret before exposing this.",
    );
  }
  await app.listen({ port: config.port, host: config.host });
}

// Auto-start only when run directly (node dist/server.js or tsx src/server.ts),
// not when imported by tests.
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  start().catch((err) => {
    console.error("Failed to start Hue Conductor:", err);
    process.exit(1);
  });
}
