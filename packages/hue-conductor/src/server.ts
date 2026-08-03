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
  type StreamPatternType,
} from "@marquee/contracts";
import {
  FsAlbumAssetReader,
  FsAlbumAssetWriter,
  curatorIdFromUri,
  type AlbumAssetReader,
  type AlbumAssetWriter,
} from "./assets.js";
import { isStreamEffect } from "./stream/renderers.js";
import { StreamSession } from "./stream/session.js";
import { Clip2Client, httpsClip2Request } from "./stream/clip2.js";
import { createHueDtlsSocket } from "./stream/dtls-transport.js";
import { createLogger } from "@marquee/observability";

/** The streaming surface the server drives — a real `StreamSession`, or a fake in tests. */
export type StreamController = Pick<
  StreamSession,
  "start" | "stop" | "isStreaming"
>;

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
  /** Injected album-assets writer (tests capture pushes); prod writes the synced store (ADR 0045). */
  assetWriter?: AlbumAssetWriter;
  /** Injected streaming controller (tests fake it); prod builds one lazily from the paired bridge. */
  streamSession?: StreamController;
}

/**
 * Substitute a streaming effect with a lively CLIP pattern when streaming isn't available, so a
 * streaming-tagged album still moves on a CLIP-only setup (ADR 0024): rotate a multi-color palette,
 * or pulse (breathe) a single color — never a flat hold, unless the palette is empty.
 */
function clipFallback(payload: PalettePayload): PalettePayload {
  const n = payload.palette.colors.length;
  const pattern: PalettePayload["pattern"] =
    n >= 2
      ? { type: "rotate", params: { intervalMs: 1200, direction: "forward" } }
      : n === 1
        ? {
            type: "pulse",
            params: { periodMs: 2000, minBrightness: 30, maxBrightness: 100 },
          }
        : { type: "static", params: {} };
  return { ...payload, pattern };
}

/**
 * Narrow a pushed album asset at the boundary (ADR 0045). Hand-written like every other parser here:
 * `album-asset.schema.json` exists but nothing in the repo validates against it at runtime, and one
 * route is the wrong place to introduce a schema library.
 *
 * Checks only what Conductor depends on plus the identity fields — the asset is Curator's shape and
 * Conductor reads a documented slice of it (`AlbumPaletteInput`). Being stricter here would reject
 * albums over fields this service never looks at. A palette that isn't ready yet is deliberately
 * *accepted*: `/api/scan` already degrades that to `202 ignored: album not ready`, and refusing the
 * push would mean an album could never be staged before its palette lands.
 */
function parseAssetPush(
  body: unknown,
  expectedId: string,
): { asset: Record<string, unknown> } | { error: string } {
  if (typeof body !== "object" || body === null || Array.isArray(body))
    return { error: "expected an album-asset object" };
  const b = body as Record<string, unknown>;
  if (b.version !== 1)
    return { error: `unsupported asset version: ${JSON.stringify(b.version)}` };
  if (typeof b.curatorId !== "string")
    return { error: "curatorId is required" };
  if (b.curatorId !== expectedId)
    return {
      error: `curatorId ${JSON.stringify(b.curatorId)} does not match the path ${JSON.stringify(expectedId)}`,
    };
  for (const key of ["metadata", "roadie"] as const) {
    if (typeof b[key] !== "object" || b[key] === null)
      return { error: `${key} is required` };
  }
  return { asset: b };
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
  // ...and writes it, so Curator can push the store instead of an operator running rsync (ADR 0045).
  const assetWriter =
    opts.assetWriter ?? new FsAlbumAssetWriter(config.albumAssetsDir);

  // Streaming (Entertainment API, ADR 0024). Built lazily from the paired bridge on first use — it
  // needs the DTLS `clientkey`, captured at pairing. Returns null when streaming isn't possible yet
  // (not paired, no clientkey, or no CLIP v2 client), so callers fall back to the CLIP path.
  let streamSession: StreamController | null = opts.streamSession ?? null;
  const streaming = (): StreamController | null => {
    if (streamSession) return streamSession;
    const b = store.bridge;
    if (!b || !b.clientkey) return null;
    const clip2 = new Clip2Client(
      httpsClip2Request({ ip: b.ip, applicationKey: b.applicationKey }),
    );
    streamSession = new StreamSession(
      bridge,
      clip2,
      (area) =>
        createHueDtlsSocket({
          ip: b.ip,
          applicationKey: b.applicationKey,
          clientkey: b.clientkey!,
        }),
      {
        idleTimeoutMs: config.idleTimeoutMinutes * 60_000,
        timers: opts.timers,
      },
    );
    return streamSession;
  };
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

  // `service` / `instance` / `albumAssetsDir` are the desktop shell's identity check (issue #229).
  // The asset store is the directory that has to agree: a Conductor reading a different one answers
  // every scan `202 ignored: album not synced` while Preview claims the lights are running (#164).
  // `instance` is null for any Conductor no shell started — hand-run dev servers, the Pi.
  app.get("/healthz", async () => ({
    ok: true,
    service: "hue-conductor",
    instance: process.env.MARQUEE_INSTANCE_ID ?? null,
    albumAssetsDir: config.albumAssetsDir,
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
    const body = (req.body ?? {}) as {
      listeningRoomId?: string | null;
      entertainmentAreaId?: string | null;
    };
    let settings = store.settings;
    // Only touch a field the caller actually sent, so a partial PUT can't clear the other.
    if ("listeningRoomId" in body)
      settings = store.setListeningRoom(body.listeningRoomId ?? null);
    if ("entertainmentAreaId" in body)
      settings = store.setEntertainmentArea(body.entertainmentAreaId ?? null);
    return settings;
  });

  // Entertainment areas the bridge knows about, for Curator to pick one as the streaming target
  // (ADR 0024). Requires a paired bridge with a captured clientkey; otherwise a helpful 409.
  app.get("/api/entertainment/areas", async (_req, reply) => {
    const b = store.bridge;
    if (!b) return reply.code(409).send({ error: "bridge not paired" });
    if (!b.clientkey)
      return reply.code(409).send({
        error:
          "bridge paired before DTLS support — re-run `pnpm pair` on the Pi to capture the clientkey",
      });
    const clip2 = new Clip2Client(
      httpsClip2Request({ ip: b.ip, applicationKey: b.applicationKey }),
    );
    return { areas: await clip2.listEntertainmentAreas() };
  });

  // Resolve the target room: explicit roomId wins, else the configured listening room.
  const resolveRoom = (roomId?: string): string | null =>
    roomId ?? store.settings.listeningRoomId ?? null;

  type ApplyResult =
    | { kind: "streaming"; areaId: string; effect: string }
    | { kind: "playing"; playbackId: string };

  /**
   * Drive a room from a fully-built payload — shared by `/api/playback` (admin/Demo Room) and
   * `/api/scan` (runtime). A streaming effect goes over the Entertainment API when an area is
   * configured; otherwise, or on a failed handshake, it falls back to a lively CLIP pattern. Handles
   * the CLIP↔streaming handoff in both directions so the two paths never fight over the lights.
   */
  /**
   * Try to play `effect` over the Entertainment API. Returns null when it can't — no configured
   * area, no clientkey, or the session failed — leaving the CLIP decision to the caller, because
   * the right fallback differs between the two ways an effect can be asked for.
   */
  const tryStreaming = async (
    roomId: string,
    effect: StreamPatternType,
    payload: PalettePayload,
    params: Record<string, number>,
    log: { warn(msg: string): void; error(msg: string): void },
    ctx: string,
  ): Promise<ApplyResult | null> => {
    const areaId = store.settings.entertainmentAreaId;
    const sess = streaming();
    if (!areaId || !sess) {
      log.warn(
        `streaming ${effect}${ctx} needs an entertainment area + clientkey — CLIP fallback`,
      );
      return null;
    }
    try {
      await engine.stop(roomId); // CLIP → streaming handoff, from the true pre-session state
      await sess.start(
        roomId,
        areaId,
        effect,
        payload.palette.colors.map((c) => c.hex),
        params,
      );
      return { kind: "streaming", areaId, effect };
    } catch (err) {
      log.error(
        `streaming ${effect}${ctx} failed (${(err as Error).message}) — CLIP fallback`,
      );
      return null;
    }
  };

  const applyPayload = async (
    roomId: string,
    payload: PalettePayload,
    log: { warn(msg: string): void; error(msg: string): void },
    ctx = "",
  ): Promise<ApplyResult> => {
    // A per-album opt-in (ADR 0035) asks for the effect *instead of* `pattern`, and leaves `pattern`
    // as the fallback — so a room with no entertainment area gets the album's own energy-aware
    // pattern rather than clipFallback's generic rotate. That is the whole reason the opt-in rides
    // beside `pattern` instead of overwriting it.
    //
    // `pattern.params` are deliberately NOT forwarded: they belong to the CLIP pattern standing by
    // as the fallback, and handing `intervalMs` to aurora would be nonsense. The effect's own knobs
    // travel in `streaming.params` (ADR 0036); absent ones fall to the renderer's default.
    const optIn = payload.streaming?.effect;
    if (optIn && isStreamEffect(optIn)) {
      const params = payload.streaming?.params ?? {};
      const played = await tryStreaming(
        roomId,
        optIn,
        payload,
        params,
        log,
        ctx,
      );
      if (played) return played;
      // Fall through with `payload` untouched: its pattern is the derived CLIP one.
    }

    const type = payload.pattern.type;
    if (isStreamEffect(type)) {
      // The direct form (Demo Room, manual curl): the effect *is* the pattern, so its params are
      // the effect's, and there is no album pattern standing by — hence clipFallback's guess.
      const played = await tryStreaming(
        roomId,
        type,
        payload,
        (payload.pattern.params ?? {}) as Record<string, number>,
        log,
        ctx,
      );
      if (played) return played;
      payload = clipFallback(payload);
    }
    // A CLIP payload arriving while a stream is active must release the lights first (the reverse
    // handoff) — the entertainment session holds them exclusively.
    const sess = streaming();
    if (sess?.isStreaming()) await sess.stop();
    const { playbackId } = await engine.start(roomId, payload);
    return { kind: "playing", playbackId };
  };

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
    // Streaming effects route to the Entertainment API too (ADR 0024), so Curator's Demo Room and a
    // manual `curl` can drive aurora/shimmer/wave, not just a tagged scan.
    const result = await applyPayload(roomId, payload, req.log);
    return result.kind === "streaming"
      ? {
          streaming: true,
          roomId,
          areaId: result.areaId,
          effect: result.effect,
        }
      : { playbackId: result.playbackId };
  });

  // Stop whichever path holds the room — the streaming session or the CLIP engine (both no-op if
  // idle). Shared by /api/playback/stop and the scan-stop so neither leaves a stream running.
  const stopRoom = async (targetRoom: string): Promise<void> => {
    const sess = streaming();
    if (sess?.isStreaming()) await sess.stop();
    await engine.stop(targetRoom);
  };

  // Stop a room's playback and fade the lights back to their pre-session snapshot.
  app.post("/api/playback/stop", async (req, reply) => {
    const { roomId } = (req.body ?? {}) as { roomId?: string };
    const target = resolveRoom(roomId);
    if (!target)
      return reply.code(400).send({
        error: "no room specified and no listening room configured",
      });
    await stopRoom(target);
    return { stopped: true, roomId: target };
  });

  // Introspection (conductor-spec §7, issue #54): what's playing now + recent playbacks. Backs the
  // Demo Room UI and — the motivating case — debugging the runtime loop during hardware bring-up
  // ("I placed a sleeve and nothing happened — did Conductor even resolve the scan?").
  app.get("/api/playback/current", async () => ({
    playback: engine.current(),
  }));

  app.get("/api/playback/history", async (req) => {
    const raw = (req.query as { limit?: string }).limit;
    const parsed = raw ? Number(raw) : 50;
    const limit =
      Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 200) : 50;
    return { history: engine.history(limit) };
  });

  // Runtime scan intake from Stylus (issue #45). Unlike /api/playback (Curator's Demo Room proxy,
  // ADR 0007), this is the real runtime entrypoint: a raw ScanEvent, resolved against the synced
  // album-assets store, drives the listening room. `start` → build the palette from the album and
  // play it; `stop` → restore the pre-scan snapshot. A valid scan we can't act on (no listening room,
  // album not synced yet, album not far enough along) degrades gracefully to a 202 "ignored" rather
  // than an error — a scan must never error-storm the always-on service (runtime-overview §9). The
  // engine arms the 90-min idle timeout on start, the safety net for a lost `stop`.
  // --- Album-asset ingest (ADR 0045) -------------------------------------------------------------
  // Curator pushes the store here instead of an operator running `rsync`. `FsAlbumAssetReader` holds
  // no cache and does no file-watching, so a pushed asset is live for the very next scan.
  //
  // The explicit `bodyLimit` matters: Fastify defaults to 1 MB and nothing else in the repo raises
  // it, while an asset carrying many `cardArtCandidates` and prompt drafts can grow well past a
  // typical ~14 KB. 4 MB is generous for JSON and still bounded.
  app.put<{ Params: { curatorId: string } }>(
    "/api/album-assets/:curatorId",
    { bodyLimit: 4 * 1024 * 1024 },
    async (req, reply) => {
      const { curatorId } = req.params;
      if (!/^[a-z0-9]{8}$/.test(curatorId))
        return reply
          .code(400)
          .send({ error: "curatorId must match /^[a-z0-9]{8}$/" });

      const parsed = parseAssetPush(req.body, curatorId);
      if ("error" in parsed) return reply.code(400).send(parsed);

      try {
        const bytes = await assetWriter.write(curatorId, parsed.asset);
        req.log.info(`album asset pushed: ${curatorId} (${bytes} bytes)`);
        return { curatorId, bytes };
      } catch (err) {
        // Mapped here rather than rethrown on purpose: `setErrorHandler` below defaults to **502**
        // and echoes `err.message`, so a local disk failure would reach Curator dressed as a bad
        // gateway and read as "the network ate it" in the sync issue.
        req.log.error(err);
        return reply
          .code(500)
          .send({ error: `could not write the album asset: ${curatorId}` });
      }
    },
  );

  // What Curator diffs against to report drift on the system-status page. Ids only — Curator already
  // holds the authoritative bodies, and shipping 13 full assets back would be pure noise.
  app.get("/api/album-assets", async (req, reply) => {
    try {
      return { curatorIds: await assetWriter.list() };
    } catch (err) {
      req.log.error(err);
      return reply
        .code(500)
        .send({ error: "could not list the album-assets store" });
    }
  });

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
      await stopRoom(roomId); // streaming session or CLIP — both no-op if idle
      return reply.code(202).send({ ok: true, action: "stopped", roomId });
    }

    // start — validate the URI first, so a malformed one is always a 400 (not silently degraded
    // when no room is configured), matching ADR 0019 / the spec note.
    const curatorId = curatorIdFromUri(scan.uri);
    if (!curatorId)
      return reply
        .code(400)
        .send({ error: `not a curator album URI: ${scan.uri}` });

    if (!roomId) {
      req.log.warn(
        `scan ${scan.uri}: no listening room configured — staying put`,
      );
      return reply
        .code(202)
        .send({ ok: true, action: "ignored", reason: "no listening room" });
    }

    const asset = await assets.read(curatorId);
    if (!asset) {
      req.log.warn(`scan ${scan.uri}: album not in synced store — staying put`);
      return reply.code(202).send({
        ok: true,
        action: "ignored",
        reason: "album not synced",
        curatorId,
      });
    }

    let payload: PalettePayload;
    try {
      payload = buildPalettePayload(asset);
    } catch (err) {
      if (err instanceof PaletteNotReadyError) {
        req.log.warn(`scan ${scan.uri}: ${err.message} — staying put`);
        return reply.code(202).send({
          ok: true,
          action: "ignored",
          reason: "album not ready",
          curatorId,
        });
      }
      throw err;
    }

    // Streaming effects route over the Entertainment API when an area is configured, else a lively
    // CLIP fallback (ADR 0024). Bridge failures bubble to the error handler (409 not paired / 502).
    const result = await applyPayload(
      roomId,
      payload,
      req.log,
      ` (scan ${scan.uri})`,
    );
    return reply.code(202).send(
      result.kind === "streaming"
        ? {
            ok: true,
            action: "streaming",
            roomId,
            curatorId,
            areaId: result.areaId,
            effect: result.effect,
          }
        : {
            ok: true,
            action: "playing",
            roomId,
            curatorId,
            playbackId: result.playbackId,
          },
    );
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
    // Structured, fingerprinted (issue #142) — the shell captures this stream into the
    // rotating log (issue #141), and a boot failure is exactly what needs to survive it.
    createLogger({ service: "hue-conductor" }).error("Failed to start", err);
    process.exit(1);
  });
}
