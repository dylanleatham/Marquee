// Service reachability for the Settings screen (issue #101). "Not configured" and "configured but
// down" are different problems with different fixes, so the route must never conflate them.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import Fastify from "fastify";
import { AssetStore } from "../src/store/asset-store.js";
import { buildServer } from "../src/server.js";
import { fakeRoadie, fakeProber } from "./helpers.js";

type Health = {
  service: string;
  configured: boolean;
  reachable: boolean;
  url?: string;
  detail?: string;
};

const listen = async (app: ReturnType<typeof Fastify>) => {
  await app.listen({ port: 0, host: "127.0.0.1" });
  const { port } = app.server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
};

describe("GET /api/settings/service-health", () => {
  let store: AssetStore;
  let stubs: Array<ReturnType<typeof Fastify>>;

  beforeEach(() => {
    store = new AssetStore(mkdtempSync(join(tmpdir(), "curator-health-")));
    stubs = [];
  });
  afterEach(async () => {
    await Promise.all(stubs.map((s) => s.close().catch(() => {})));
  });

  /** A stand-in service answering the path Curator probes it on. */
  const stub = async (path: string, status = 200) => {
    const app = Fastify();
    app.get(path, async (_req, reply) => reply.code(status).send({ ok: true }));
    stubs.push(app);
    return listen(app);
  };

  const curator = (over: Record<string, unknown> = {}) =>
    buildServer({
      store,
      roadie: fakeRoadie(store),
      prober: fakeProber(),
      config: { conductor: { url: "http://127.0.0.1:1" }, ...over },
    }).app;

  const health = async (
    app: ReturnType<typeof curator>,
  ): Promise<Record<string, Health>> => {
    const res = await app.inject({
      method: "GET",
      url: "/api/settings/service-health",
    });
    expect(res.statusCode).toBe(200);
    return Object.fromEntries(
      (res.json().services as Health[]).map((s) => [s.service, s]),
    );
  };

  // Exact, not a subset: a service silently dropped from the probe list would leave the Settings
  // screen quietly blind to it. Stylus joined when the system-status page needed its reachability.
  it("reports every runtime service", async () => {
    const byName = await health(curator());
    expect(Object.keys(byName).sort()).toEqual([
      "amp",
      "backdrop",
      "conductor",
      "stylus",
    ]);
  });

  it("marks an unconfigured service as such, not as unreachable-with-an-error", async () => {
    const byName = await health(curator());
    // Backdrop and Amp are absent from config here.
    expect(byName.backdrop).toEqual({
      service: "backdrop",
      configured: false,
      reachable: false,
    });
    expect(byName.amp!.configured).toBe(false);
    expect(byName.amp!.detail).toBeUndefined();
  });

  it("reports a live service as reachable, with the URL it probed", async () => {
    const url = await stub("/api/bridge/status");
    const byName = await health(curator({ conductor: { url } }));
    expect(byName.conductor).toMatchObject({
      configured: true,
      reachable: true,
      url,
    });
  });

  // Issue #270. `detail` was the raw transport message — `The operation was aborted due to timeout`
  // — which named neither the address it gave up on nor how long it waited. On 2026-08-08 that line
  // sat on this screen through a stale address in the process env and a wifi link at 12% loss, and
  // both times it read as "this service is broken" when it meant "look at the address".
  it("says what failed and against which address, without guessing that the service is down", async () => {
    // Bind a port, learn it, then release it — a port that is certainly closed, so the probe fails
    // at the transport rather than waiting out the full 5s budget.
    const gone = Fastify();
    const url = await listen(gone);
    await gone.close();

    const byName = await health(curator({ conductor: { url } }));

    expect(byName.conductor).toMatchObject({
      configured: true,
      reachable: false,
      url,
    });
    expect(byName.conductor!.detail).toBe(
      `${url} refused the connection — nothing is listening there`,
    );
    // The specific regression: the page must not assert a cause the probe cannot know.
    expect(byName.conductor!.detail).not.toMatch(/is it running|is down/i);
  });

  it("probes each service on its own health path", async () => {
    const conductorUrl = await stub("/api/bridge/status");
    const backdropUrl = await stub("/healthz");
    const ampUrl = await stub("/api/status");
    const byName = await health(
      curator({
        conductor: { url: conductorUrl },
        backdrop: {
          url: backdropUrl,
          mediaDir: join(tmpdir(), "bd"),
          syncMediaLocally: false,
        },
        amp: { url: ampUrl },
      }),
    );
    expect(byName.conductor!.reachable).toBe(true);
    expect(byName.backdrop!.reachable).toBe(true);
    expect(byName.amp!.reachable).toBe(true);
  });

  it("reports a configured-but-dead service as unreachable with a reason", async () => {
    const url = await stub("/api/bridge/status");
    await stubs[0]!.close(); // configured, then taken down
    const byName = await health(curator({ conductor: { url } }));
    expect(byName.conductor).toMatchObject({
      configured: true,
      reachable: false,
    });
    expect(byName.conductor!.detail).toBeTruthy();
  });

  it("treats a non-2xx as unreachable and names the status", async () => {
    const url = await stub("/api/bridge/status", 503);
    const byName = await health(curator({ conductor: { url } }));
    expect(byName.conductor!.reachable).toBe(false);
    expect(byName.conductor!.detail).toContain("503");
  });

  it("never fails the whole probe when one service is dead", async () => {
    const ampUrl = await stub("/api/status");
    const byName = await health(
      curator({
        conductor: { url: "http://127.0.0.1:1" },
        amp: { url: ampUrl },
      }),
    );
    expect(byName.conductor!.reachable).toBe(false);
    expect(byName.amp!.reachable).toBe(true);
  });
});
