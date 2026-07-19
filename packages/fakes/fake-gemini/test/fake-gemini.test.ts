import { describe, it, expect } from "vitest";
import { createFakeGemini } from "../src/index.js";

const url = (model: string) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
const withKey = { headers: { "x-goog-api-key": "k" } };

describe("fake-gemini", () => {
  it("rejects a call with no api key", async () => {
    const fg = createFakeGemini();
    const res = await fg.fetch(url("gemini-2.5-flash"), { method: "POST" });
    expect(res.status).toBe(401);
  });

  it("returns research text for a grounded call and records the call", async () => {
    const fg = createFakeGemini({ research: "cover shows purple rain" });
    const res = await fg.fetch(url("gemini-2.5-flash"), {
      ...withKey,
      method: "POST",
      body: JSON.stringify({ tools: [{ google_search: {} }] }),
    });
    const body = await res.json();
    expect(body.candidates[0].content.parts[0].text).toBe(
      "cover shows purple rain",
    );
    expect(fg.calls()).toMatchObject([{ grounded: true, structured: false }]);
  });

  it("returns stringified JSON for a structured call", async () => {
    const fg = createFakeGemini({ json: { variants: [{ text: "a" }] } });
    const res = await fg.fetch(url("gemini-2.5-flash"), {
      ...withKey,
      method: "POST",
      body: JSON.stringify({
        generationConfig: { responseSchema: { type: "object" } },
      }),
    });
    const body = await res.json();
    expect(JSON.parse(body.candidates[0].content.parts[0].text)).toEqual({
      variants: [{ text: "a" }],
    });
    expect(fg.calls()[0]).toMatchObject({ structured: true });
  });

  it("returns inlineData for an image model", async () => {
    const fg = createFakeGemini({ imageBase64: "Zm9v" });
    const res = await fg.fetch(url("gemini-2.5-flash-image"), {
      ...withKey,
      method: "POST",
      body: JSON.stringify({}),
    });
    const body = await res.json();
    expect(body.candidates[0].content.parts[0].inlineData.data).toBe("Zm9v");
  });

  it("forces an error status when configured", async () => {
    const fg = createFakeGemini({ failStatus: 429 });
    const res = await fg.fetch(url("gemini-2.5-flash"), {
      ...withKey,
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(429);
  });

  it("runs the video long-running operation: start → poll (done) → download", async () => {
    const fg = createFakeGemini({ videoBytes: "MP4" });
    const base = "https://generativelanguage.googleapis.com/v1beta";

    const start = await fg.fetch(
      `${base}/models/veo-3.0-generate-preview:predictLongRunning`,
      {
        ...withKey,
        method: "POST",
        body: JSON.stringify({ instances: [{ prompt: "p" }] }),
      },
    );
    const { name } = await start.json();
    expect(name).toMatch(/^operations\/vid-/);

    const poll = await fg.fetch(`${base}/${name}`, withKey);
    const op = await poll.json();
    expect(op.done).toBe(true);
    const uri = op.response.generatedVideos[0].video.uri;

    const dl = await fg.fetch(uri, withKey);
    expect(await dl.text()).toBe("MP4");
    expect(fg.calls().map((c) => c.video)).toEqual([
      "start",
      "poll",
      "download",
    ]);
  });

  it("completes the operation with an error when videoOpError is set", async () => {
    const fg = createFakeGemini({ videoOpError: "content policy" });
    const base = "https://generativelanguage.googleapis.com/v1beta";
    const start = await fg.fetch(`${base}/models/veo:predictLongRunning`, {
      ...withKey,
      method: "POST",
      body: "{}",
    });
    const { name } = await start.json();
    const op = await (await fg.fetch(`${base}/${name}`, withKey)).json();
    expect(op.done).toBe(true);
    expect(op.error.message).toBe("content policy");
  });

  it("returns not-done for the configured number of polls", async () => {
    const fg = createFakeGemini({ videoPollsUntilDone: 2 });
    const base = "https://generativelanguage.googleapis.com/v1beta";
    const start = await fg.fetch(`${base}/models/veo:predictLongRunning`, {
      ...withKey,
      method: "POST",
      body: "{}",
    });
    const { name } = await start.json();
    expect(
      (await (await fg.fetch(`${base}/${name}`, withKey)).json()).done,
    ).toBe(false);
    expect(
      (await (await fg.fetch(`${base}/${name}`, withKey)).json()).done,
    ).toBe(false);
    expect(
      (await (await fg.fetch(`${base}/${name}`, withKey)).json()).done,
    ).toBe(true);
  });
});
