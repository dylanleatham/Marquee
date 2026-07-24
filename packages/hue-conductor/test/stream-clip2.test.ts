import { describe, it, expect, vi } from "vitest";
import {
  Clip2Client,
  type Clip2Request,
  type Clip2Result,
} from "../src/stream/clip2.js";

const ok = (json: unknown): Clip2Result => ({ status: 200, json });

describe("Clip2Client.listEntertainmentAreas", () => {
  it("maps configs to areas with channel ids and positions", async () => {
    const request: Clip2Request = async () =>
      ok({
        data: [
          {
            id: "area-1",
            metadata: { name: "Listening Room" },
            channels: [
              { channel_id: 0, position: { x: -1, y: 0.5, z: 0 } },
              { channel_id: 1, position: { x: 1, y: 0.5, z: 0 } },
            ],
          },
        ],
      });
    const areas = await new Clip2Client(request).listEntertainmentAreas();
    expect(areas).toEqual([
      {
        id: "area-1",
        name: "Listening Room",
        channels: [
          { channel: 0, x: -1, y: 0.5, z: 0 },
          { channel: 1, x: 1, y: 0.5, z: 0 },
        ],
      },
    ]);
  });

  it("tolerates missing fields", async () => {
    const request: Clip2Request = async () => ok({ data: [{ id: "a" }] });
    const [area] = await new Clip2Client(request).listEntertainmentAreas();
    expect(area).toEqual({ id: "a", name: "", channels: [] });
  });

  it("throws on a non-2xx status", async () => {
    const request: Clip2Request = async () => ({ status: 503, json: null });
    await expect(
      new Clip2Client(request).listEntertainmentAreas(),
    ).rejects.toThrow(/HTTP 503/);
  });
});

describe("Clip2Client.setStreaming", () => {
  it("PUTs action start/stop to the area", async () => {
    const request = vi.fn<Clip2Request>(async () => ok({}));
    const client = new Clip2Client(request);

    await client.setStreaming("area-1", true);
    expect(request).toHaveBeenCalledWith({
      method: "PUT",
      path: "/clip/v2/resource/entertainment_configuration/area-1",
      body: { action: "start" },
    });

    await client.setStreaming("area-1", false);
    expect(request).toHaveBeenLastCalledWith({
      method: "PUT",
      path: "/clip/v2/resource/entertainment_configuration/area-1",
      body: { action: "stop" },
    });
  });

  it("throws on a non-2xx status", async () => {
    const request: Clip2Request = async () => ({ status: 500, json: null });
    await expect(
      new Clip2Client(request).setStreaming("a", true),
    ).rejects.toThrow(/HTTP 500/);
  });
});
