import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  waitForHealth,
  isHealthy,
  serviceSpecs,
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
  });
});
