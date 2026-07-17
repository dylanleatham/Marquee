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
import type { PalettePayload } from "@marquee/contracts";

export interface BuildOptions {
  /** Config overrides (tests inject a shared secret + temp data dir). */
  config?: Partial<Config>;
  /** Pre-built store (tests seed a bridge record). */
  store?: Store;
  /** Injected Hue driver (tests pass a fake; prod uses the default node-hue-api driver). */
  driver?: HueDriver;
  /** Injected timers for the playback engine (tests step patterns deterministically). */
  timers?: Timers;
}

export function buildServer(opts: BuildOptions = {}) {
  const config = loadConfig(opts.config);
  const store = opts.store ?? new Store(config.dataDir);
  const bridge = new BridgeAdapter(store, opts.driver);
  const engine = new PlaybackEngine(bridge, { timers: opts.timers });
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
