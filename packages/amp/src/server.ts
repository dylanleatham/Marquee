import { pathToFileURL } from "node:url";
import Fastify from "fastify";
import { parseCuratorUri, type ScanEvent } from "@marquee/contracts";
import { loadConfig, type Config } from "./config.js";
import { Store } from "./store.js";
import { PlaybackEngine, type Timers } from "./playback/engine.js";
import { SonosUnavailableError, type SonosDriver } from "./sonos/driver.js";
import { SvrooijSonosDriver } from "./sonos/svrooij-driver.js";
import { FsAlbumAssetReader, type AlbumAssetReader } from "./assets.js";
import { createLogger } from "@marquee/observability";

export interface BuildOptions {
  /** Config overrides (tests inject a shared secret + temp data dir + tiny idle timeout). */
  config?: Partial<Config>;
  /** Pre-built store (tests seed a target room). */
  store?: Store;
  /** Injected Sonos driver (tests pass a fake; prod uses the @svrooij/sonos driver). */
  driver?: SonosDriver;
  /** Injected timers for the idle-timeout (tests step it deterministically). */
  timers?: Timers;
  /** Injected album-assets reader (tests seed albums in memory); prod reads the synced store. */
  assets?: AlbumAssetReader;
}

/** Parse a scan event at the boundary (mirrors Conductor/Backdrop). Returns null on a malformed body. */
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
  const store =
    opts.store ?? new Store(config.dataDir, config.defaultTargetRoom);
  const driver = opts.driver ?? new SvrooijSonosDriver();
  const assets = opts.assets ?? new FsAlbumAssetReader(config.albumAssetsDir);
  const app = Fastify({
    logger: { level: process.env.NODE_ENV === "test" ? "silent" : "info" },
  });
  const engine = new PlaybackEngine(driver, {
    timers: opts.timers,
    idleTimeoutMs: config.idleTimeoutMinutes * 60_000,
    logger: app.log,
  });
  const startedAt = Date.now();

  // Shared-secret auth on everything except the health probe (matches conductor/backdrop).
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

  app.get("/healthz", async () => ({ ok: true }));

  app.get("/api/status", async () => ({
    ...engine.status(),
    target: store.settings.targetRoom,
    uptimeSec: Math.round((Date.now() - startedAt) / 1000),
  }));

  // Discoverable Sonos rooms — backs Curator's target picker. Sonos errors surface as 502.
  app.get("/api/sonos/rooms", async () => ({ rooms: await driver.rooms() }));

  app.get("/api/settings", async () => store.settings);
  app.put("/api/settings", async (req) => {
    const { targetRoom } = (req.body ?? {}) as { targetRoom?: string | null };
    return store.setTargetRoom(targetRoom ?? null);
  });

  const resolveTarget = (): string | null => store.settings.targetRoom ?? null;

  // Runtime scan intake from Stylus. Amp is the only service that acts on the URI *kind*: it streams
  // the album over Sonos for a `card`, and stays silent for an `album` (a sleeve — you drop the needle
  // on the vinyl). A valid scan it can't act on degrades to a 202 "ignored" rather than an error — a
  // hardware scan must not error-storm the always-on service (runtime-overview §9); only a malformed
  // body or a non-curator URI is a 4xx. `start` arms the 90-min idle timeout, the lost-`stop` net.
  app.post("/api/scan", async (req, reply) => {
    const scan = parseScan(req.body);
    if (!scan)
      return reply.code(400).send({
        error:
          "expected a scan event: start needs { uri, tagUid, at }, stop needs { at }",
      });

    const target = resolveTarget();

    if (scan.event === "stop") {
      if (!target)
        return reply
          .code(202)
          .send({ ok: true, action: "ignored", reason: "no target room" });
      await engine.stop(target);
      return reply.code(202).send({ ok: true, action: "stopped", target });
    }

    // start — validate the URI first, so a malformed one is always a 400 (not silently degraded when
    // no target is configured), matching Conductor's /api/scan (ADR 0019).
    const parsed = parseCuratorUri(scan.uri);
    if (!parsed)
      return reply.code(400).send({ error: `not a curator URI: ${scan.uri}` });

    if (parsed.kind === "album") {
      // A sleeve: the record plays the audio, not Amp (ADR 0034).
      return reply.code(202).send({
        ok: true,
        action: "ignored",
        reason: "sleeve — vinyl plays",
        curatorId: parsed.curatorId,
      });
    }

    // kind === "card" | "demo" — the two Amp plays. They differ only in *what* is handed to Sonos:
    // a card plays the album container, a demo tag the one track chosen for it (ADR 0058).
    const kind = parsed.kind;
    if (!target) {
      req.log.warn(
        `${kind} scan ${scan.uri}: no target room configured — staying silent`,
      );
      return reply
        .code(202)
        .send({ ok: true, action: "ignored", reason: "no target room" });
    }

    const asset = await assets.read(parsed.curatorId);
    if (!asset) {
      req.log.warn(
        `${kind} scan ${scan.uri}: album not in synced store — staying silent`,
      );
      return reply.code(202).send({
        ok: true,
        action: "ignored",
        reason: "album not synced",
        curatorId: parsed.curatorId,
      });
    }

    /**
     * A demo tag with no chosen track falls back to the album — the same thing a card plays.
     *
     * Deliberately not "stay silent with a reason": a demo tag is written before, or independently
     * of, the choice being made, and a sticker that does nothing in the room is indistinguishable
     * from a mis-written one. Playing the record from track 1 is wrong in a way you can hear and
     * fix; silence sends you to the logs.
     */
    const demoTrackUri =
      kind === "demo" ? asset.demoTrack?.spotifyUri : undefined;

    /**
     * **A cut plays as a position in its album, not as a track handed over on its own**
     * ([ADR 0076](../../../docs/adrs/0076-a-demo-cut-plays-as-a-position-in-the-album.md)).
     *
     * Sonos accepts a bare `spotify:track:`, resolves it, reports its duration, queues it — and never
     * leaves `STOPPED`. Nothing errors, so the only symptom is a silent room, which is the one
     * outcome ADR 0058 §3 set out to avoid. Handing over the album container and seeking to the
     * track plays the identical track.
     *
     * Both parts have to be there: the album to enqueue, and the position to seek to. When either is
     * missing we fall back to the old bare-track hand-off rather than refusing a cut we can name.
     */
    const demoAlbumUri = asset.metadata.spotifyUri;
    const demoTrackNumber =
      kind === "demo" && demoTrackUri && demoAlbumUri
        ? asset.demoTrack?.trackNumber
        : undefined;
    const spotifyUri =
      (demoTrackNumber ? demoAlbumUri : demoTrackUri) ??
      asset.metadata.spotifyUri;
    if (!spotifyUri) {
      req.log.warn(
        `${kind} scan ${scan.uri}: album has no Spotify URI — staying silent`,
      );
      return reply.code(202).send({
        ok: true,
        action: "ignored",
        reason: "album not on spotify",
        curatorId: parsed.curatorId,
      });
    }
    if (kind === "demo" && !demoTrackUri)
      req.log.info(
        `demo scan ${scan.uri}: no demo track chosen — playing the album instead`,
      );
    // Named at `warn`, because on a household that won't start a bare track this is the difference
    // between the cut and silence, and the fix is to re-pick the cut so its position gets recorded.
    else if (kind === "demo" && !demoTrackNumber)
      req.log.warn(
        `demo scan ${scan.uri}: the chosen cut has no track number — handing Sonos the track itself, which some households accept and others play silently (ADR 0076)`,
      );

    try {
      await engine.start(target, spotifyUri, parsed.curatorId, demoTrackNumber);
    } catch (err) {
      // Environmental Sonos failure (no favorite/binding, unreachable): degrade, don't error.
      if (err instanceof SonosUnavailableError) {
        req.log.warn(
          `${kind} scan ${scan.uri}: sonos unavailable (${err.message}) — staying silent`,
        );
        return reply.code(202).send({
          ok: true,
          action: "ignored",
          reason: "sonos unavailable",
          detail: err.message,
        });
      }
      throw err;
    }
    return reply.code(202).send({
      ok: true,
      action: "playing",
      curatorId: parsed.curatorId,
      spotifyUri,
      target,
      // The chosen track, or `null` when the demo tag fell back to the album — otherwise the two
      // outcomes produce identical `playing` responses and the fallback is invisible to a caller.
      //
      // `spotifyUri` above names what **Sonos was handed**, which for a cut is now the album (ADR
      // 0076); `trackNumber` is the position inside it. Present together they say "this album, from
      // this song"; `demoTrack` alone says the cut had no position and went over as a bare track.
      ...(kind === "demo" ? { demoTrack: demoTrackUri ?? null } : {}),
      ...(demoTrackNumber ? { trackNumber: demoTrackNumber } : {}),
    });
  });

  // Admin overrides for dev/smoke tests (conductor-spec-style /api/test surface).
  app.post("/api/admin/play", async (req, reply) => {
    const { spotifyUri, targetRoom } = (req.body ?? {}) as {
      spotifyUri?: string;
      targetRoom?: string;
    };
    const target = targetRoom ?? resolveTarget();
    if (!target)
      return reply.code(400).send({ error: "no target room configured" });
    if (!spotifyUri || !spotifyUri.startsWith("spotify:album:"))
      return reply
        .code(400)
        .send({ error: "spotifyUri (spotify:album:<id>) is required" });
    await engine.start(target, spotifyUri, "manual");
    return { ok: true, target, spotifyUri };
  });

  app.post("/api/admin/stop", async (req, reply) => {
    const target =
      ((req.body ?? {}) as { targetRoom?: string }).targetRoom ??
      resolveTarget();
    if (!target)
      return reply.code(400).send({ error: "no target room configured" });
    await engine.stop(target);
    return { ok: true, target };
  });

  app.setErrorHandler((err, req, reply) => {
    req.log.error(err);
    // Sonos/network failures surface as 502 rather than a generic 500.
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
  if (!config.defaultTargetRoom) {
    app.log.warn(
      "No Sonos target room configured — card scans will be ignored until one is set via PUT /api/settings or [sonos].target_room.",
    );
  }
  await app.listen({ port: config.port, host: config.host });
}

// Auto-start only when run directly (node dist/server.js or tsx src/server.ts), not when imported by
// tests.
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  start().catch((err) => {
    // Structured, fingerprinted (issue #142) — the shell captures this stream into the
    // rotating log (issue #141), and a boot failure is exactly what needs to survive it.
    createLogger({ service: "amp" }).error("Failed to start", err);
    process.exit(1);
  });
}
