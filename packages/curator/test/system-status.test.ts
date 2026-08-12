import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import Fastify from "fastify";
import { AssetStore } from "../src/store/asset-store.js";
import { buildServer } from "../src/server.js";
import { fakeRoadie, fakeProber, makeAsset } from "./helpers.js";
import {
  buildSystemStatus,
  LIGHTS_CAVEAT,
} from "../src/runtime/system-status.js";

import type { AlbumAsset } from "../src/albums/asset.js";

const withVideo = (id: string): AlbumAsset => {
  const a = makeAsset(id);
  a.visualizer = {
    fileId: id,
    originalFilename: "clip.mp4",
    durationSec: 100,
    loopStrategy: "loop",
    attachedAt: "2026-08-01T00:00:00.000Z",
  };
  return a;
};

/**
 * A fake runtime. `routes` maps `"<host><path>"` to a JSON body; anything unlisted 404s, and a host
 * listed in `dead` throws — the two failure shapes the page has to tell apart.
 */
function fakeFetch(
  routes: Record<string, unknown>,
  dead: string[] = [],
): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    if (dead.some((d) => url.startsWith(d))) throw new Error("ECONNREFUSED");
    if (url in routes)
      return new Response(JSON.stringify(routes[url]), { status: 200 });
    return new Response("nope", { status: 404 });
  }) as typeof fetch;
}

const CONDUCTOR = { url: "http://c:4737" };
const BACKDROP = { url: "http://b:4740" };
const AMP = { url: "http://a:4741" };
const STYLUS = { url: "http://s:4741" };

const fullRuntime = (
  albumIds: string[],
  opts: { fileMissing?: boolean } = {},
) => ({
  "http://c:4737/api/bridge/status": { paired: true },
  "http://c:4737/api/album-assets": { curatorIds: albumIds },
  "http://c:4737/api/playback/current": {
    playback: [
      {
        roomId: "1",
        source: { name: "N", artist: "A" },
        pattern: "rotate",
        startedAt: "t",
      },
    ],
  },
  "http://b:4740/healthz": { ok: true },
  "http://b:4740/api/status": {
    state: "playing",
    uri: "curator:album:aaaa1111",
    filePath: "/m/aaaa1111.mp4",
    browserConnected: true,
  },
  "http://b:4740/api/library": {
    entries: Object.fromEntries(
      albumIds.map((id) => [
        `curator:album:${id}`,
        { filePath: `/m/${id}.mp4`, fileMissing: opts.fileMissing ?? false },
      ]),
    ),
  },
  "http://a:4741/api/status": { state: "idle", target: "Living Room" },
  "http://s:4741/healthz": { ok: true },
  "http://s:4741/status": {
    state: "idle",
    observed: null,
    lastBadTag: null,
    downstreamHealth: { conductor: true, backdrop: true },
  },
});

describe("buildSystemStatus", () => {
  const deps = (
    over: Partial<Parameters<typeof buildSystemStatus>[0]> = {},
  ) => ({
    conductor: CONDUCTOR,
    backdrop: BACKDROP,
    amp: AMP,
    stylus: STYLUS,
    albums: [] as AlbumAsset[],
    jobs: [],
    now: () => "2026-08-01T00:00:00.000Z",
    ...over,
  });

  it("reports every service as reachable when the runtime is healthy", async () => {
    const s = await buildSystemStatus(
      deps({ fetchImpl: fakeFetch(fullRuntime([])) }),
    );
    expect(s.services.map((x) => x.service).sort()).toEqual([
      "amp",
      "backdrop",
      "conductor",
      "stylus",
    ]);
    expect(s.services.every((x) => x.reachable)).toBe(true);
  });

  // The whole point of the page: an unplugged Pi degrades its own section, it does not fail the
  // request. A status page that errors when something is down is unusable exactly when it matters.
  it("survives a dead runtime, reporting it rather than throwing", async () => {
    const s = await buildSystemStatus(
      deps({
        albums: [withVideo("aaaa1111")],
        fetchImpl: fakeFetch(fullRuntime(["aaaa1111"]), ["http://c:4737"]),
      }),
    );
    const conductor = s.services.find((x) => x.service === "conductor")!;
    expect(conductor).toMatchObject({ configured: true, reachable: false });
    expect(conductor.detail).toBeTruthy();
    expect(s.playing.lights).toBeNull();
    // Backdrop is still fine, and still reported.
    expect(s.playing.video).toMatchObject({ state: "playing" });
    // An album Conductor can't be asked about is not claimed to be there.
    expect(s.albums[0]!.onConductor).toBe(false);
  });

  it("distinguishes an unconfigured service from an unreachable one", async () => {
    const s = await buildSystemStatus(
      deps({ stylus: undefined, fetchImpl: fakeFetch({}, ["http://c:4737"]) }),
    );
    expect(s.services.find((x) => x.service === "stylus")).toEqual({
      service: "stylus",
      configured: false,
      reachable: false,
    });
    expect(s.services.find((x) => x.service === "conductor")).toMatchObject({
      configured: true,
      reachable: false,
    });
  });

  describe("the album presence matrix", () => {
    it("marks an album present on every host", async () => {
      const s = await buildSystemStatus(
        deps({
          albums: [withVideo("aaaa1111")],
          fetchImpl: fakeFetch(fullRuntime(["aaaa1111"])),
        }),
      );
      expect(s.albums[0]).toMatchObject({
        curatorId: "aaaa1111",
        hasVideo: true,
        onConductor: true,
        inBackdropLibrary: true,
        videoOnBackdrop: true,
      });
    });

    it("separates 'in the library' from 'the bytes are there' — the DAMN. failure", async () => {
      const s = await buildSystemStatus(
        deps({
          albums: [withVideo("aaaa1111")],
          fetchImpl: fakeFetch(
            fullRuntime(["aaaa1111"], { fileMissing: true }),
          ),
        }),
      );
      expect(s.albums[0]).toMatchObject({
        inBackdropLibrary: true,
        videoOnBackdrop: false,
      });
    });

    it("flags an album Curator has but the runtime has never been given", async () => {
      const s = await buildSystemStatus(
        deps({
          albums: [withVideo("aaaa1111"), withVideo("bbbb2222")],
          fetchImpl: fakeFetch(fullRuntime(["aaaa1111"])), // bbbb2222 never pushed
        }),
      );
      const missing = s.albums.find((a) => a.curatorId === "bbbb2222")!;
      expect(missing.onConductor).toBe(false);
      expect(missing.inBackdropLibrary).toBe(false);
    });

    // An older Backdrop predates `fileMissing`; absent must read as "can't tell", never as "fine",
    // or the page would vouch for a file it has no evidence of.
    it("does not claim a video is present when Backdrop doesn't report fileMissing", async () => {
      const routes = fullRuntime(["aaaa1111"]);
      routes["http://b:4740/api/library"] = {
        entries: { "curator:album:aaaa1111": { filePath: "/m/aaaa1111.mp4" } },
      };
      const s = await buildSystemStatus(
        deps({ albums: [withVideo("aaaa1111")], fetchImpl: fakeFetch(routes) }),
      );
      expect(s.albums[0]).toMatchObject({
        inBackdropLibrary: true,
        videoOnBackdrop: false,
      });
    });

    /**
     * Issue #296 / ADR 0072. `videoOnBackdrop` is a boolean and so cannot tell "Backdrop says no"
     * from "Backdrop didn't say" — the record page needs that difference to avoid drawing a
     * confirmation it hasn't got, and it is the only derivation both screens now read.
     */
    it("keeps 'Backdrop says no' apart from 'Backdrop didn't answer'", async () => {
      const confirmed = await buildSystemStatus(
        deps({
          albums: [withVideo("aaaa1111")],
          fetchImpl: fakeFetch(fullRuntime(["aaaa1111"])),
        }),
      );
      expect(confirmed.albums[0]!.videoPresence).toBe("present");

      const gone = await buildSystemStatus(
        deps({
          albums: [withVideo("aaaa1111")],
          fetchImpl: fakeFetch(
            fullRuntime(["aaaa1111"], { fileMissing: true }),
          ),
        }),
      );
      expect(gone.albums[0]!.videoPresence).toBe("absent");

      // Never pushed: no entry at all.
      const never = await buildSystemStatus(
        deps({
          albums: [withVideo("bbbb2222")],
          fetchImpl: fakeFetch(fullRuntime([])),
        }),
      );
      expect(never.albums[0]!.videoPresence).toBe("absent");

      // Too old to report the flag — an entry, but no evidence of bytes.
      const silent = fullRuntime(["aaaa1111"]);
      silent["http://b:4740/api/library"] = {
        entries: { "curator:album:aaaa1111": { filePath: "/m/aaaa1111.mp4" } },
      };
      const cantTell = await buildSystemStatus(
        deps({ albums: [withVideo("aaaa1111")], fetchImpl: fakeFetch(silent) }),
      );
      expect(cantTell.albums[0]!.videoPresence).toBe("unknown");
    });

    /**
     * ADR 0073. Every album now gets a library entry, and a `usesDefault` one's `fileMissing` is
     * judged against `default.mp4` — so reading that flag straight through would report `present`
     * for every unfinished record the moment a default clip lands on the Pi. That is the same
     * collapse-into-`present` ADR 0072 exists to prevent, arriving by a new route.
     */
    it("a usesDefault entry is 'absent' — the fallback is not this record's clip", async () => {
      const routes = fullRuntime([]);
      routes["http://b:4740/api/library"] = {
        entries: {
          // What Backdrop reports once default.mp4 is on the Pi: an entry, and nothing missing.
          "curator:album:aaaa1111": { usesDefault: true, fileMissing: false },
        },
      };
      const s = await buildSystemStatus(
        deps({ albums: [withVideo("aaaa1111")], fetchImpl: fakeFetch(routes) }),
      );
      expect(s.albums[0]!.videoPresence).toBe("absent");
      expect(s.albums[0]!.videoOnBackdrop).toBe(false);
      // Backdrop *has* heard of it, which is a different question and stays true.
      expect(s.albums[0]!.inBackdropLibrary).toBe(true);
    });

    // The stale-entry case: Backdrop is still on the fallback for a record Curator has since given a
    // visualizer. The exceptions list must name the real problem, not "not in the library".
    it("flags a videoed record Backdrop still holds as usesDefault", async () => {
      const routes = fullRuntime([]);
      routes["http://b:4740/api/library"] = {
        entries: { "curator:album:aaaa1111": { usesDefault: true } },
      };
      const s = await buildSystemStatus(
        deps({ albums: [withVideo("aaaa1111")], fetchImpl: fakeFetch(routes) }),
      );
      expect(s.albums[0]!.videoPresence).toBe("absent");
      expect(s.albums[0]!.inBackdropLibrary).toBe(true);
    });

    it("says 'can't tell' when Backdrop cannot be reached at all", async () => {
      // Distinct from every album being absent: an unplugged Pi is not evidence that 478 clips
      // vanished, and the record page must not offer to re-send them all on that basis.
      const down = fullRuntime(["aaaa1111"]);
      delete down["http://b:4740/api/library"];
      const s = await buildSystemStatus(
        deps({ albums: [withVideo("aaaa1111")], fetchImpl: fakeFetch(down) }),
      );
      expect(s.albums[0]!.videoPresence).toBe("unknown");
      expect(s.albums[0]!.videoOnBackdrop).toBe(false);
    });

    it("reports an album with no visualizer attached as such", async () => {
      const s = await buildSystemStatus(
        deps({
          albums: [makeAsset("nooovid1")],
          fetchImpl: fakeFetch(fullRuntime([])),
        }),
      );
      expect(s.albums[0]!.hasVideo).toBe(false);
    });
  });

  describe("stylus", () => {
    it("passes through the reader's view of a rejected sleeve", async () => {
      const routes = fullRuntime([]);
      routes["http://s:4741/status"] = {
        state: "idle",
        observed: { uid: "04:A1", uri: null, at: "t" },
        lastBadTag: { uid: "04:A1", uri: null, at: "t" },
        downstreamHealth: {},
      };
      const s = await buildSystemStatus(deps({ fetchImpl: fakeFetch(routes) }));
      // Present on the stand, undecodable — the case that used to look like an empty stand.
      expect(s.stylus!.observed).toEqual({ uid: "04:A1", uri: null, at: "t" });
      expect(s.stylus!.lastBadTag!.uid).toBe("04:A1");
    });

    it("is null when Stylus can't be reached", async () => {
      const s = await buildSystemStatus(
        deps({ fetchImpl: fakeFetch(fullRuntime([]), ["http://s:4741"]) }),
      );
      expect(s.stylus).toBeNull();
    });
  });

  it("states the lights caveat rather than implying the view is complete", async () => {
    const s = await buildSystemStatus(
      deps({ fetchImpl: fakeFetch(fullRuntime([])) }),
    );
    expect(s.playing.caveats).toContain(LIGHTS_CAVEAT);
  });
});

// The route itself, not just the pure builder: config → store → jobs → HTTP, through the real
// Fastify server, the way `service-health` is covered. The wiring is where a status page most
// plausibly breaks — a mis-threaded config target reports a healthy service as unconfigured.
describe("GET /api/system/status", () => {
  let store: AssetStore;
  let stubs: Array<ReturnType<typeof Fastify>>;

  beforeEach(() => {
    store = new AssetStore(mkdtempSync(join(tmpdir(), "curator-sysstat-")));
    stubs = [];
  });
  afterEach(async () => {
    await Promise.all(stubs.map((s) => s.close().catch(() => {})));
  });

  /** A stand-in runtime service answering the paths the status endpoint reads. */
  const stubService = async (
    routes: Record<string, unknown>,
  ): Promise<string> => {
    const app = Fastify();
    for (const [path, body] of Object.entries(routes))
      app.get(path, async () => body);
    stubs.push(app);
    await app.listen({ port: 0, host: "127.0.0.1" });
    const { port } = app.server.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  };

  const curator = (over: Record<string, unknown> = {}) =>
    buildServer({
      store,
      roadie: fakeRoadie(store),
      prober: fakeProber(),
      config: { conductor: { url: "http://127.0.0.1:1" }, ...over },
    }).app;

  const get = async (app: ReturnType<typeof curator>) => {
    const res = await app.inject({ method: "GET", url: "/api/system/status" });
    expect(res.statusCode).toBe(200);
    return res.json();
  };

  it("answers 200 with every section even when the whole runtime is down", async () => {
    store.save(withVideo("aaaa1111"));
    const body = await get(curator());

    expect(
      body.services.map((s: { service: string }) => s.service).sort(),
    ).toEqual(["amp", "backdrop", "conductor", "stylus"]);
    expect(body.playing.video).toBeNull();
    expect(body.stylus).toBeNull();
    // Curator's own half still works — the album is listed, just absent everywhere else.
    expect(body.albums).toHaveLength(1);
    expect(body.albums[0]).toMatchObject({
      curatorId: "aaaa1111",
      hasVideo: true,
      onConductor: false,
    });
  });

  it("threads the configured targets through to a live runtime", async () => {
    store.save(withVideo("aaaa1111"));
    const conductorUrl = await stubService({
      "/api/bridge/status": { paired: true },
      "/api/album-assets": { curatorIds: ["aaaa1111"] },
      "/api/playback/current": { playback: [] },
    });
    const backdropUrl = await stubService({
      "/healthz": { ok: true },
      "/api/status": { state: "idle", uri: null, filePath: null },
      "/api/library": {
        entries: {
          "curator:album:aaaa1111": {
            filePath: "/m/a.mp4",
            fileMissing: false,
          },
        },
      },
    });
    const stylusUrl = await stubService({
      "/healthz": { ok: true },
      "/status": {
        state: "idle",
        observed: { uid: "04:A1", uri: null, at: "t" },
        lastBadTag: null,
      },
    });

    const body = await get(
      curator({
        conductor: { url: conductorUrl },
        backdrop: { url: backdropUrl, mediaDir: "/m" },
        stylus: { url: stylusUrl },
      }),
    );

    expect(body.albums[0]).toMatchObject({
      onConductor: true,
      inBackdropLibrary: true,
      videoOnBackdrop: true,
    });
    // The reader's view survives the round trip — the field the page's stand section renders.
    expect(body.stylus.observed).toEqual({ uid: "04:A1", uri: null, at: "t" });
  });

  it("reports a job that is actually in flight", async () => {
    store.save(withVideo("aaaa1111"));

    // Gate the push on a promise the test controls, so the job is *guaranteed* still running when
    // we look. A sleep would race the runtime and is exactly the shape of flake #203 was about.
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const slow = Fastify();
    slow.get("/api/album-assets", async () => ({ curatorIds: [] }));
    slow.put("/api/album-assets/:curatorId", async () => {
      await held;
      return { curatorId: "aaaa1111", bytes: 1 };
    });
    stubs.push(slow);
    await slow.listen({ port: 0, host: "127.0.0.1" });
    const { port } = slow.server.address() as AddressInfo;

    const app = curator({
      conductor: { url: `http://127.0.0.1:${port}`, pushAssets: true },
    });
    const started = await app.inject({
      method: "POST",
      url: "/api/runtime/sync",
    });
    expect(started.statusCode).toBe(202);

    try {
      const body = await get(app);
      expect(
        body.jobs.some((j: { kind: string }) => j.kind === "runtimeSync"),
      ).toBe(true);
    } finally {
      release(); // let the job finish rather than leaving it pending across tests
    }
  });
});
