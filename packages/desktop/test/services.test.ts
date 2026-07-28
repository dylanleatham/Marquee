import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  waitForHealth,
  isHealthy,
  serviceSpecs,
  servicesToStart,
  devEntries,
  CURATOR_PORT,
  CONDUCTOR_PORT,
} from "../src/services";

let server: Server | undefined;
afterEach(() => {
  server?.close();
  server = undefined;
});

describe("waitForHealth", () => {
  it("resolves once the endpoint starts answering 200", async () => {
    let ready = false;
    server = createServer((_req, res) => {
      res.statusCode = ready ? 200 : 503;
      res.end();
    });
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
    const { port } = server!.address() as AddressInfo;
    setTimeout(() => {
      ready = true;
    }, 200);

    await expect(
      waitForHealth(`http://127.0.0.1:${port}/healthz`, 5000, 50),
    ).resolves.toBeUndefined();
  });

  it("rejects after the timeout when nothing is listening", async () => {
    await expect(
      waitForHealth("http://127.0.0.1:1/healthz", 300, 50),
    ).rejects.toThrow(/timed out/i);
  });
});

describe("isHealthy", () => {
  it("is true for a 200 and false when nothing is listening", async () => {
    server = createServer((_req, res) => res.end("ok"));
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
    const { port } = server!.address() as AddressInfo;
    expect(await isHealthy(`http://127.0.0.1:${port}/healthz`)).toBe(true);
    expect(await isHealthy("http://127.0.0.1:1/healthz")).toBe(false);
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

describe("servicesToStart (adopt vs fork)", () => {
  const specs = serviceSpecs(devEntries("/repo")); // [hue-conductor, curator]

  it("starts only the services that aren't already healthy", () => {
    // Conductor already up (adopt), Curator down (start).
    expect(servicesToStart(specs, [true, false]).map((s) => s.name)).toEqual([
      "curator",
    ]);
  });

  it("starts both when nothing is up, and none when both are already up", () => {
    expect(servicesToStart(specs, [false, false])).toHaveLength(2);
    expect(servicesToStart(specs, [true, true])).toHaveLength(0);
  });
});
