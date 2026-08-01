import { pathToFileURL, fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { createWriteStream, mkdirSync, renameSync, rmSync } from "node:fs";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import type { Readable } from "node:stream";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
import type { ScanEvent, LibraryEntry } from "@marquee/contracts";
import { loadConfig, type Config } from "./config.js";
import { Library } from "./library.js";
import { SocketHub, type Socket } from "./hub.js";
import {
  PlaybackController,
  fileIsPlayable,
  type Timers,
} from "./controller.js";
import { createLogger } from "@marquee/observability";

const pkgDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const publicDir = resolve(pkgDir, "public");

export interface BuildOptions {
  /** Config overrides (tests inject a shared secret, temp dataDir/mediaDir, tiny idle timeout). */
  config?: Partial<Config>;
  /** Pre-built library (tests seed entries). */
  library?: Library;
  /** Injected timers for the idle-timeout (tests step it deterministically). */
  timers?: Timers;
}

/**
 * How long a failed upload waits for its write stream to close before unlinking the temp file
 * anyway (issue #203). Generous: `close` follows `destroy()` promptly in every case we know of, so
 * this is a backstop against wedging the request, not a expected-path timeout.
 */
const CLOSE_WAIT_MS = 5000;

/** A media upload exceeded `maxUploadBytes` (ADR 0038) — answered as 413. */
export class UploadTooLargeError extends Error {
  constructor() {
    super("upload exceeds the configured cap");
    this.name = "UploadTooLargeError";
  }
}

/** A media upload stopped sending bytes for `uploadStallMs` — answered as 408. */
export class UploadStalledError extends Error {
  constructor() {
    super("upload stalled");
    this.name = "UploadStalledError";
  }
}

/** Narrow an untrusted body to a ScanEvent, or return null (→ 400). */
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
  if (
    b.event === "start" &&
    typeof b.uri === "string" &&
    b.uri.length > 0 &&
    typeof b.tagUid === "string" &&
    b.tagUid.length > 0
  ) {
    // A real start always carries the tag UID (scan-event.schema.json requires it); enforce it at
    // the boundary rather than fabricating a value to satisfy the contract type.
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
  const library = opts.library ?? new Library(config.dataDir);
  const hub = new SocketHub((ev) => {
    // Browser events are observability only; log and move on (spec §10).
    app.log.info({ browserEvent: ev }, "backdrop browser event");
  });
  const app = Fastify({
    logger: { level: process.env.NODE_ENV === "test" ? "silent" : "info" },
  });
  const controller = new PlaybackController(library, hub, {
    timers: opts.timers,
    idleTimeoutMs: config.idleTimeoutMinutes * 60_000,
    mediaDir: config.mediaDir,
    logger: app.log, // unresolvable / missing-file scans get a server-side warn (spec §8/§9)
  });
  const startedAt = Date.now();

  // X-Trigger-Secret auth on the runtime/control API only. The kiosk SPA (static assets + the /ws
  // socket) and /healthz stay open — a browser can't set custom headers on a WebSocket, and the
  // health probe must answer before anything else is up (matches conductor-spec §8's carve-out).
  app.addHook("onRequest", async (req, reply) => {
    const path = req.url.split("?")[0]!;
    if (!path.startsWith("/api")) return;
    if (!config.sharedSecret) return; // dev: auth disabled, warned at boot
    if (req.headers["x-trigger-secret"] !== config.sharedSecret) {
      await reply.code(401).send({
        error: "unauthorized",
        hint: "send the X-Trigger-Secret header",
      });
    }
  });

  // --- Kiosk SPA + WebSocket ---------------------------------------------------------------------
  app.register(fastifyStatic, { root: publicDir, prefix: "/" });
  app.register(fastifyWebsocket);
  app.register(async (f) => {
    f.get(
      "/ws",
      { websocket: true },
      (
        socket: Socket & { on: (e: string, cb: (d: unknown) => void) => void },
      ) => {
        hub.add(socket);
        socket.on("message", (raw) => hub.receive(String(raw)));
        socket.on("close", () => hub.remove(socket));
      },
    );
  });

  // --- Health / status ---------------------------------------------------------------------------
  // Spec §8: 200 only when the backend is up AND the browser is attached; 503 otherwise so a monitor
  // (or the systemd readiness check) can tell "kiosk not yet showing anything" from "all good".
  app.get("/healthz", async (_req, reply) => {
    const browserConnected = hub.connectedCount() > 0;
    return reply.code(browserConnected ? 200 : 503).send({
      ok: browserConnected,
      browserConnected,
    });
  });

  app.get("/api/status", async () => ({
    ...controller.status(),
    browserConnected: hub.connectedCount() > 0,
    uptimeSec: Math.round((Date.now() - startedAt) / 1000),
  }));

  // --- Scan intake (from Stylus) -----------------------------------------------------------------
  app.post("/api/scan", async (req, reply) => {
    const scan = parseScan(req.body);
    if (!scan) {
      return reply.code(400).send({
        error:
          "expected a scan event: start needs { uri, tagUid, at }, stop needs { at }",
      });
    }
    controller.handleScan(scan);
    return reply.code(202).send({ accepted: true });
  });

  // --- Media upload (from Curator, ADR 0038) -----------------------------------------------------
  // Curator streams the visualizer here instead of relying on an out-of-band rsync. This is the only
  // route that writes to Backdrop's disk from the network, so the guards below are load-bearing.
  //
  // The body is handed over as a raw stream rather than parsed: these files run to hundreds of MB and
  // Backdrop runs on a Pi, so buffering one would be fatal. Fastify's `bodyLimit` does not apply to a
  // pass-through parser, which is why the cap is counted explicitly below.
  app.addContentTypeParser("application/octet-stream", (_req, payload, done) =>
    done(null, payload),
  );

  /**
   * A `fileId` becomes a filename inside the directory Backdrop serves videos from. Only the
   * curatorId shape is accepted — rejected outright rather than sanitised, because sanitising
   * invites the next bypass and Curator has no reason to send anything else.
   */
  const MEDIA_FILE_ID = /^[a-z0-9]{8}$/;

  app.put("/api/media/:fileId", async (req, reply) => {
    const { fileId } = req.params as { fileId: string };
    if (!MEDIA_FILE_ID.test(fileId)) {
      return reply
        .code(400)
        .send({ error: "fileId must match /^[a-z0-9]{8}$/" });
    }

    mkdirSync(config.mediaDir, { recursive: true });
    // Write beside the destination so the rename is same-filesystem, and therefore atomic. The real
    // filename must never exist in a half-written state: a truncated mp4 that *looks* whole is worse
    // than a missing one, because Backdrop would hand it to the kiosk as a valid video.
    // Unique per request, not just per process: two uploads of the same album can be in flight at
    // once (a re-push racing a retry, or two Curators), and a shared temp name lets their streams
    // interleave into one file — which the rename would then publish as a video that is neither.
    const tmp = join(config.mediaDir, `.${fileId}.${randomUUID()}.part`);
    const dest = join(config.mediaDir, `${fileId}.mp4`);
    let bytes = 0;

    const source = req.body as Readable;
    const out = createWriteStream(tmp);

    // The read loop below waits on the network, so it needs a bound or a dropped connection that
    // never closes its socket parks it forever — holding a file descriptor and a temp file on the
    // Pi's SD card. A stall timeout, not a deadline: a real visualizer over a poor link takes many
    // minutes legitimately, so only "bytes stopped arriving" distinguishes slow from dead.
    let stallTimer: NodeJS.Timeout | undefined;
    const armStall = () => {
      clearTimeout(stallTimer);
      stallTimer = setTimeout(
        () => source.destroy(new UploadStalledError()),
        config.uploadStallMs,
      );
    };

    // A write can fail between the moments we await — a full SD card is the realistic case on a Pi.
    // Without a listener that is an uncaught 'error' event, which takes down the whole service
    // rather than this one upload, so every await below races against it.
    const writeFailed = new Promise<never>((_, reject) => {
      out.once("error", reject);
    });
    writeFailed.catch(() => {}); // never an unhandled rejection when the upload succeeds

    try {
      // Consumed explicitly rather than piped, so the cap is checked *before* each chunk is written
      // — the point of a cap is to stop writing, not to discover afterwards that we shouldn't have.
      // `write()` returning false means the buffer is full; awaiting "drain" is what keeps a 240 MB
      // upload from being held in memory on a Pi.
      armStall();
      for await (const chunk of source) {
        armStall();
        const buf = chunk as Buffer;
        bytes += buf.length;
        if (bytes > config.maxUploadBytes) throw new UploadTooLargeError();
        if (!out.write(buf))
          await Promise.race([once(out, "drain"), writeFailed]);
      }
      clearTimeout(stallTimer);
      out.end();
      await Promise.race([once(out, "finish"), writeFailed]);
      renameSync(tmp, dest);
      req.log.info({ fileId, bytes }, "media upload received");
      return reply.code(201).send({ fileId, bytes });
    } catch (err) {
      clearTimeout(stallTimer);
      // Unlink only once the stream has actually closed (issue #203).
      //
      // `destroy()` merely *schedules* the close, and `createWriteStream` opens its file
      // asynchronously — so unlinking on the next line races both. Lose that race and `rmSync`
      // removes nothing (`force` swallows the ENOENT) while the stream still goes on to touch the
      // path, leaving a `.part` orphan that nothing ever collects. Measured at a few percent of
      // rejected uploads, permanent, and unbounded on a Pi whose SD card is the scarce resource.
      //
      // Awaiting `close` removes the ordering question entirely rather than guessing which side
      // wins: by then the descriptor is released (which is also what Windows needs before an
      // unlink) and the file either exists to be removed or was never created.
      await new Promise<void>((resolve) => {
        if (out.closed) return resolve();
        let timer: NodeJS.Timeout | undefined;
        const done = () => {
          clearTimeout(timer);
          resolve();
        };
        // Bounded, like every other wait in this handler. If `close` somehow never arrives we still
        // unlink and reply — which is exactly the behaviour this replaced, so the bound can only
        // degrade to the old outcome, never wedge the request.
        timer = setTimeout(done, CLOSE_WAIT_MS);
        out.once("close", done);
        out.destroy();
      });
      rmSync(tmp, { force: true }); // no partial file, and no orphan filling the SD card
      if (err instanceof UploadTooLargeError) {
        return reply
          .code(413)
          .send({ error: `upload exceeds ${config.maxUploadBytes} bytes` });
      }
      if (err instanceof UploadStalledError) {
        return reply
          .code(408)
          .send({ error: `upload stalled for ${config.uploadStallMs}ms` });
      }
      req.log.error({ fileId, err }, "media upload failed");
      return reply.code(500).send({ error: "upload failed" });
    }
  });

  // --- Library sync (from Curator) ---------------------------------------------------------------
  app.post("/api/library/sync", async (req, reply) => {
    const body = (req.body ?? {}) as {
      entries?: Array<{ uri?: string } & LibraryEntry>;
    };
    if (!Array.isArray(body.entries)) {
      return reply
        .code(400)
        .send({ error: "expected { entries: [{ uri, filePath, ... }] }" });
    }
    const map: Record<string, LibraryEntry> = {};
    for (const e of body.entries) {
      if (!e?.uri || typeof e.filePath !== "string") {
        return reply
          .code(400)
          .send({ error: "each entry needs a uri and filePath" });
      }
      map[e.uri] = {
        filePath: e.filePath,
        durationSec: e.durationSec,
        contentHash: e.contentHash,
      };
    }
    library.replaceAll(map);
    return { synced: Object.keys(map).length };
  });

  app.post("/api/library/update", async (req, reply) => {
    const b = (req.body ?? {}) as { uri?: string } & Partial<LibraryEntry>;
    if (!b.uri) return reply.code(400).send({ error: "uri is required" });
    const existing = library.resolve(b.uri);
    const filePath = b.filePath ?? existing?.filePath;
    if (!filePath) {
      return reply
        .code(400)
        .send({ error: "filePath is required for a new entry" });
    }
    library.upsert(b.uri, {
      filePath,
      durationSec: b.durationSec ?? existing?.durationSec,
      contentHash: b.contentHash ?? existing?.contentHash,
    });
    return { updated: b.uri };
  });

  app.delete<{ Params: { uri: string } }>("/api/library/:uri", async (req) => {
    const removed = library.remove(decodeURIComponent(req.params.uri));
    return { removed };
  });

  // Each entry carries `fileMissing`, so a caller can tell "Backdrop knows about this album" from
  // "Backdrop can actually play it". Curator's sync pushes the entry and the bytes on separate legs
  // (ADR 0038) and the entry lands first by design, so listed-but-unplayable is a real, expected
  // intermediate state — and, when a transfer never happened, a silent one. This is what makes it
  // visible. `existsSync` per entry is a stat over a library of tens; not worth caching.
  app.get("/api/library", async () => {
    const { entries, ...rest } = library.all();
    return {
      ...rest,
      entries: Object.fromEntries(
        Object.entries(entries).map(([uri, entry]) => [
          uri,
          {
            ...entry,
            fileMissing: !fileIsPlayable(config.mediaDir, entry.filePath),
          },
        ]),
      ),
    };
  });

  // --- Admin / dev overrides ---------------------------------------------------------------------
  app.post("/api/admin/play", async (req, reply) => {
    const { uri } = (req.body ?? {}) as { uri?: string };
    if (!uri) return reply.code(400).send({ error: "uri is required" });
    controller.play(uri);
    return reply.code(202).send({ accepted: true });
  });

  app.post("/api/admin/stop", async (_req, reply) => {
    controller.stop();
    return reply.code(202).send({ accepted: true });
  });

  app.post("/api/admin/simulate-scan", async (req, reply) => {
    const scan = parseScan(req.body);
    if (!scan) {
      return reply.code(400).send({
        error:
          "expected a scan event: start needs { uri, tagUid, at }, stop needs { at }",
      });
    }
    controller.handleScan(scan);
    return reply.code(202).send({ accepted: true });
  });

  return { app, config, library, hub, controller };
}

async function start(): Promise<void> {
  const { app, config } = buildServer();
  if (!config.sharedSecret) {
    app.log.warn(
      "No shared secret configured — auth is DISABLED (dev). Set TRIGGER_SHARED_SECRET or config.toml [auth].shared_secret before exposing this on the LAN.",
    );
  }
  await app.listen({ port: config.port, host: config.host });
  app.log.info(
    `Backdrop up on http://${config.host}:${config.port} — point the kiosk at http://localhost:${config.port}/?debug=0`,
  );
}

// Auto-start only when run directly (node dist/server.js or tsx src/server.ts), not under test.
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  start().catch((err) => {
    // Structured, fingerprinted (issue #142) — the shell captures this stream into the
    // rotating log (issue #141), and a boot failure is exactly what needs to survive it.
    createLogger({ service: "backdrop" }).error("Failed to start", err);
    process.exit(1);
  });
}
