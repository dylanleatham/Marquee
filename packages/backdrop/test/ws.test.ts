import { describe, it, expect } from "vitest";
import type { AddressInfo } from "node:net";
import { WebSocket } from "ws";
import { buildServer } from "../src/server.js";
import { Library } from "../src/library.js";
import { FakeTimers, tempMedia, tempDataDir } from "./fakes.js";

const URI = "curator:album:x";

// Drives the real /ws route end-to-end (fastify.inject can't upgrade a WebSocket): a browser
// connecting flips /healthz to 200 and then receives the controller's broadcast commands.
describe("backdrop /ws integration", () => {
  it("a connected browser flips /healthz to 200 and receives play commands", async () => {
    const { dir, paths } = tempMedia(["x.mp4"]);
    const library = new Library(tempDataDir());
    library.upsert(URI, { filePath: paths["x.mp4"]! });
    const { app, controller } = buildServer({
      config: { mediaDir: dir },
      library,
      timers: new FakeTimers(),
    });

    await app.listen({ port: 0, host: "127.0.0.1" });
    const { port } = app.server.address() as AddressInfo;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);

    try {
      const firstMessage = new Promise<string>((resolve) =>
        ws.once("message", (d) => resolve(d.toString())),
      );
      await new Promise<void>((resolve, reject) => {
        ws.once("open", resolve);
        ws.once("error", reject);
      });

      // Now that a browser is attached, the health probe reports ready.
      const health = await app.inject({ method: "GET", url: "/healthz" });
      expect(health.statusCode).toBe(200);

      // A play command reaches the socket verbatim.
      controller.play(URI);
      expect(JSON.parse(await firstMessage)).toEqual({
        type: "play",
        filePath: paths["x.mp4"],
      });
    } finally {
      ws.close();
      await app.close();
    }
  });
});
