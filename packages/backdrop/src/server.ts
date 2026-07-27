import { pathToFileURL, fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
import type { ScanEvent, LibraryEntry } from "@marquee/contracts";
import { loadConfig, type Config } from "./config.js";
import { Library } from "./library.js";
import { SocketHub, type Socket } from "./hub.js";
import { PlaybackController, type Timers } from "./controller.js";
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

  app.get("/api/library", async () => library.all());

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
