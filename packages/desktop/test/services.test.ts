import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { EventEmitter } from "node:events";
import {
  waitForOurs,
  probeHealth,
  serviceSpecs,
  planBoot,
  watchBootExit,
  newInstanceId,
  devEntries,
  CURATOR_PORT,
  CONDUCTOR_PORT,
  type ServiceSpec,
  type HealthVerdict,
  type ChildExitEvents,
} from "../src/services";

let server: Server | undefined;
afterEach(() => {
  server?.close();
  server = undefined;
});

const OURS = "instance-of-this-launch";
const DATA_DIR = "/data/marquee";

/** The two specs a real boot builds, with `OURS` as this launch's token. */
const bootSpecs = (): ServiceSpec[] =>
  serviceSpecs(devEntries("/repo"), undefined, DATA_DIR, OURS);
const curatorSpec = () => bootSpecs().find((s) => s.name === "curator")!;

/**
 * Stand up a stub on an ephemeral port serving `body` at /healthz, and return a copy of `spec`
 * pointed at it. The port number isn't the point — who answers on it is.
 */
async function servedBy(
  spec: ServiceSpec,
  body: unknown,
): Promise<ServiceSpec> {
  server = createServer((_req, res) => {
    if (body === undefined) {
      res.statusCode = 503;
      return res.end();
    }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(body));
  });
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
  const { port } = server!.address() as AddressInfo;
  return { ...spec, healthUrl: `http://127.0.0.1:${port}/healthz` };
}

/** What our own Curator answers: right service, this launch's token, the pinned data dir. */
const ourCuratorBody = (over: Record<string, unknown> = {}) => ({
  ok: true,
  service: "curator",
  instance: OURS,
  dataDir: DATA_DIR,
  albums: 3,
  ...over,
});

describe("probeHealth", () => {
  it("is `absent` when nothing is listening", async () => {
    const spec = { ...curatorSpec(), healthUrl: "http://127.0.0.1:1/healthz" };
    expect(await probeHealth(spec, OURS)).toEqual({ kind: "absent" });
  });

  it("is `absent` when the port answers but not with 200 JSON", async () => {
    // We fork anyway; the child's EADDRINUSE exit is what reports the squatter (main.ts).
    expect(
      (await probeHealth(await servedBy(curatorSpec(), undefined), OURS)).kind,
    ).toBe("absent");
  });

  it("is `ours` when the instance token is this launch's", async () => {
    const spec = await servedBy(curatorSpec(), ourCuratorBody());
    expect(await probeHealth(spec, OURS)).toEqual({ kind: "ours" });
  });

  it("is `adoptable` for another launch's Curator on the same data dir", async () => {
    const spec = await servedBy(
      curatorSpec(),
      ourCuratorBody({ instance: null }),
    );
    expect(await probeHealth(spec, OURS)).toEqual({ kind: "adoptable" });
  });

  it("normalises path case and separators before calling a data dir a conflict", async () => {
    const spec = await servedBy(
      curatorSpec(),
      ourCuratorBody({ instance: null, dataDir: "\\data\\Marquee\\" }),
    );
    // Only Windows treats these as the same directory; elsewhere they genuinely differ.
    expect((await probeHealth(spec, OURS)).kind).toBe(
      process.platform === "win32" ? "adoptable" : "foreign",
    );
  });
});

describe("serviceSpecs / devEntries", () => {
  it("maps the built servers to their default health ports, conductor first", () => {
    const specs = serviceSpecs(devEntries("/repo"));

    expect(specs.map((s) => s.name)).toEqual(["hue-conductor", "curator"]);

    const curator = specs.find((s) => s.name === "curator")!;
    const conductor = specs.find((s) => s.name === "hue-conductor")!;
    expect(curator.entry.replace(/\\/g, "/")).toBe(
      "/repo/packages/curator/dist/server.js",
    );
    expect(conductor.entry.replace(/\\/g, "/")).toBe(
      "/repo/packages/hue-conductor/dist/server.js",
    );
    expect(curator.healthUrl).toBe(`http://localhost:${CURATOR_PORT}/healthz`);
    expect(conductor.healthUrl).toBe(
      `http://localhost:${CONDUCTOR_PORT}/healthz`,
    );
    // Curator is pinned at the local Conductor so the repo `.env`'s Pi hostname doesn't win.
    expect(curator.env.CONDUCTOR_URL).toBe(
      `http://localhost:${CONDUCTOR_PORT}`,
    );
    // No ffmpeg paths given → Curator falls back to a system ffmpeg on PATH.
    expect(curator.env.FFMPEG_PATH).toBeUndefined();
    expect(curator.env.FFPROBE_PATH).toBeUndefined();
  });

  it("points Curator at the bundled ffmpeg/ffprobe when given", () => {
    const specs = serviceSpecs(devEntries("/repo"), {
      ffmpeg: "/ff/ffmpeg.exe",
      ffprobe: "/ff/ffprobe.exe",
    });
    const curator = specs.find((s) => s.name === "curator")!;
    expect(curator.env.FFMPEG_PATH).toBe("/ff/ffmpeg.exe");
    expect(curator.env.FFPROBE_PATH).toBe("/ff/ffprobe.exe");
    // Conductor doesn't need ffmpeg — but it does need the asset store (below).
    expect(
      specs.find((s) => s.name === "hue-conductor")!.env.FFMPEG_PATH,
    ).toBeUndefined();
  });

  /**
   * Issue #164. On the Pi deployment an rsync puts Curator's asset store where Conductor reads it
   * (runbook A4.3). The desktop app is one box with no rsync, so if the two services disagree about
   * where that store lives, Conductor answers every scan `202 ignored: album not synced` and the
   * lights never move. The app already pins CONDUCTOR_URL for exactly this reason; the store is the
   * other half of the same "single box" contract.
   */
  it("gives Conductor the album-assets store its co-located Curator writes to", () => {
    const specs = serviceSpecs(devEntries("/repo"), undefined, "/data/marquee");
    const conductor = specs.find((s) => s.name === "hue-conductor")!;
    const curator = specs.find((s) => s.name === "curator")!;

    expect(conductor.env.ALBUM_ASSETS_DIR?.replace(/\\/g, "/")).toBe(
      "/data/marquee/album-assets",
    );
    // Pinned on Curator's side too, so the pair agree by construction rather than by coincidence.
    expect(curator.env.MARQUEE_DATA_DIR?.replace(/\\/g, "/")).toBe(
      "/data/marquee",
    );
  });

  it("hands every child the same per-launch instance token", () => {
    // The token is what /healthz echoes back, so a service that never receives it can never be
    // recognised as ours — both children need it, not just Curator (issue #229).
    for (const spec of bootSpecs())
      expect(spec.env.MARQUEE_INSTANCE_ID).toBe(OURS);
  });

  it("expects each service to vouch for the directory the shell pinned it to", () => {
    const specs = bootSpecs();
    const curator = specs.find((s) => s.name === "curator")!;
    const conductor = specs.find((s) => s.name === "hue-conductor")!;

    expect(curator.identity).toEqual({
      service: "curator",
      dirField: "dataDir",
      dir: DATA_DIR,
    });
    expect(conductor.identity.service).toBe("hue-conductor");
    expect(conductor.identity.dirField).toBe("albumAssetsDir");
    // The identity check must agree with the env pin, or a healthy boot would report a conflict.
    expect(conductor.identity.dir).toBe(conductor.env.ALBUM_ASSETS_DIR);
  });

  it("defaults both services to the same store when no data dir is given", () => {
    const specs = serviceSpecs(devEntries("/repo"));
    const conductor = specs.find((s) => s.name === "hue-conductor")!;
    const curator = specs.find((s) => s.name === "curator")!;

    const assets = conductor.env.ALBUM_ASSETS_DIR!.replace(/\\/g, "/");
    const data = curator.env.MARQUEE_DATA_DIR!.replace(/\\/g, "/");
    expect(assets).toBe(`${data}/album-assets`);
    expect(data).toMatch(/\/marquee$/);
  });
});

/**
 * Regression: #229. A stale `tsx watch src/server.ts` Curator from an unrelated checkout held 4739.
 * The gate saw a 200, adopted it, and the app opened its window on a foreign service — different
 * data dir, different build, and no curator child in its own process tree. The gate has to answer
 * "is this the Curator *we* started", not "is anything listening".
 */
describe("the gate must identify the service, not just find one (regression: #229)", () => {
  /** A stale Curator from another checkout: right service, wrong collection, not our token. */
  const staleCurator = () =>
    servedBy(
      curatorSpec(),
      ourCuratorBody({ instance: null, dataDir: "D:/other-checkout/marquee" }),
    );

  it("refuses to adopt a Curator rooted at a different collection", async () => {
    const verdict = await probeHealth(await staleCurator(), OURS);
    expect(verdict.kind).toBe("foreign");
    // The message has to name the two directories — "port in use" wouldn't tell you which
    // collection the window would have been editing.
    expect(verdict).toMatchObject({
      reason: expect.stringContaining("D:/other-checkout/marquee"),
    });
  });

  it("fails the boot rather than driving it — the window must never open on a stranger", async () => {
    const stale = await staleCurator();
    const plan = planBoot([stale], [await probeHealth(stale, OURS)]);

    expect(plan.adopt).toEqual([]);
    expect(plan.start).toEqual([]);
    expect(plan.conflicts).toHaveLength(1);
  });

  it("does not let a stranger satisfy the poll after we fork our own", async () => {
    // The other half of the same bug: we lose the port race, our child dies, and the poll is
    // answered by whoever won. It must fail fast, not wait out the deadline and then succeed.
    await expect(
      waitForOurs(await staleCurator(), OURS, 5000, 50),
    ).rejects.toThrow(/another curator is already running/i);
  });

  it("is not fooled by an unrelated server that happens to answer 200 on the port", async () => {
    const spec = await servedBy(curatorSpec(), { ok: true, status: "fine" });
    expect((await probeHealth(spec, OURS)).kind).toBe("foreign");
  });

  it("treats a Conductor on someone else's asset store as foreign too", async () => {
    // Same family: a foreign Conductor is #164 again — every scan `202 ignored: album not synced`
    // while Preview reports the lights running.
    const conductor = bootSpecs().find((s) => s.name === "hue-conductor")!;
    const spec = await servedBy(conductor, {
      ok: true,
      service: "hue-conductor",
      instance: null,
      albumAssetsDir: "D:/other-checkout/marquee/album-assets",
      paired: true,
    });
    expect((await probeHealth(spec, OURS)).kind).toBe("foreign");
  });
});

describe("waitForOurs", () => {
  it("resolves once the service reports this launch's token", async () => {
    let instance: string | null = null;
    server = createServer((_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(ourCuratorBody({ instance })));
    });
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
    const { port } = server!.address() as AddressInfo;
    const spec = {
      ...curatorSpec(),
      healthUrl: `http://127.0.0.1:${port}/healthz`,
    };
    setTimeout(() => {
      instance = OURS;
    }, 200);

    await expect(waitForOurs(spec, OURS, 5000, 50)).resolves.toBeUndefined();
  });

  it("rejects after the timeout when nothing is listening", async () => {
    const spec = { ...curatorSpec(), healthUrl: "http://127.0.0.1:1/healthz" };
    await expect(waitForOurs(spec, OURS, 300, 50)).rejects.toThrow(
      /timed out/i,
    );
  });
});

describe("planBoot (adopt vs fork vs refuse)", () => {
  const specs = bootSpecs(); // [hue-conductor, curator]

  it("starts only the services that aren't already there", () => {
    // Conductor already up on the same store (adopt), Curator absent (start).
    const plan = planBoot(specs, [{ kind: "adoptable" }, { kind: "absent" }]);
    expect(plan.start.map((s) => s.name)).toEqual(["curator"]);
    expect(plan.adopt.map((s) => s.name)).toEqual(["hue-conductor"]);
    expect(plan.conflicts).toEqual([]);
  });

  it("starts both when nothing is up, and none when both are already up", () => {
    expect(
      planBoot(specs, [{ kind: "absent" }, { kind: "absent" }]).start,
    ).toHaveLength(2);
    expect(
      planBoot(specs, [{ kind: "adoptable" }, { kind: "adoptable" }]).start,
    ).toHaveLength(0);
  });

  it("collects every conflict, so one dialog names all the blocked ports", () => {
    const foreign: HealthVerdict = { kind: "foreign", reason: "someone else" };
    const plan = planBoot(specs, [foreign, foreign]);
    expect(plan.conflicts.map((c) => c.spec.name)).toEqual([
      "hue-conductor",
      "curator",
    ]);
    expect(plan.start).toEqual([]);
    expect(plan.adopt).toEqual([]);
  });
});

/**
 * The other half of #229: the shell probed a free port, forked, lost the race, and its child died of
 * EADDRINUSE — but the poll was then answered by whoever won, so boot succeeded anyway and the
 * window opened behind a "restart the app" dialog that restarting could not fix.
 */
describe("watchBootExit", () => {
  const fakeChild = (): { emitter: EventEmitter; handle: ChildExitEvents } => {
    const emitter = new EventEmitter();
    return {
      emitter,
      handle: {
        once: (event: string, listener: (...args: never[]) => void) =>
          emitter.once(event, listener as (...args: unknown[]) => void),
        off: (event: string, listener: (...args: never[]) => void) =>
          emitter.off(event, listener as (...args: unknown[]) => void),
      } as ChildExitEvents,
    };
  };

  it("rejects when the child exits before it is ready", async () => {
    const { emitter, handle } = fakeChild();
    const watch = watchBootExit({ name: "curator" }, handle);
    emitter.emit("exit", 1, null);
    await expect(watch.rejected).rejects.toThrow(
      /curator exited \(1\) before it was ready/i,
    );
  });

  it("names the signal when the child was killed rather than exiting", async () => {
    const { emitter, handle } = fakeChild();
    const watch = watchBootExit({ name: "curator" }, handle);
    emitter.emit("exit", null, "SIGTERM");
    await expect(watch.rejected).rejects.toThrow(/SIGTERM/);
  });

  it("reports a spawn failure too", async () => {
    const { emitter, handle } = fakeChild();
    const watch = watchBootExit({ name: "hue-conductor" }, handle);
    emitter.emit("error", new Error("ENOENT"));
    await expect(watch.rejected).rejects.toThrow(
      /could not start hue-conductor: ENOENT/i,
    );
  });

  it("stops listening after dispose, so the shutdown kill isn't a boot failure", async () => {
    const { emitter, handle } = fakeChild();
    const watch = watchBootExit({ name: "curator" }, handle);
    // Keep the rejection handled either way, so the assertion below is about the listeners and not
    // about an unhandled rejection warning.
    let rejected = false;
    void watch.rejected.catch(() => {
      rejected = true;
    });

    watch.dispose();
    emitter.emit("exit", 0, null);
    expect(emitter.listenerCount("exit")).toBe(0);
    expect(emitter.listenerCount("error")).toBe(0);
    await new Promise((r) => setTimeout(r, 10));
    expect(rejected).toBe(false);
  });
});

describe("newInstanceId", () => {
  it("differs per launch — a reused token would defeat the whole check", () => {
    expect(newInstanceId()).not.toBe(newInstanceId());
  });
});
