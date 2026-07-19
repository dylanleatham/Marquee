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

  it("runs the Omni video interaction: POST → steps[] with a video uri → download", async () => {
    const fg = createFakeGemini({ videoBytes: "MP4" });
    const base = "https://generativelanguage.googleapis.com/v1beta";

    const res = await fg.fetch(`${base}/interactions`, {
      ...withKey,
      method: "POST",
      body: JSON.stringify({
        model: "gemini-omni-flash-preview",
        input: [{ type: "text", text: "p" }],
      }),
    });
    const body = await res.json();
    expect(body.status).toBe("completed");
    const out = body.steps.find(
      (s: { type: string }) => s.type === "model_output",
    );
    const uri = out.content[0].uri;
    expect(uri).toContain("/download/omni-");

    const dl = await fg.fetch(uri, withKey);
    expect(await dl.text()).toBe("MP4");
    expect(fg.calls().map((c) => c.video)).toEqual(["interaction", "download"]);
  });

  it("returns the video inline (base64 data) when videoInline is set", async () => {
    const fg = createFakeGemini({ videoBytes: "INLINE", videoInline: true });
    const res = await fg.fetch(
      "https://generativelanguage.googleapis.com/v1beta/interactions",
      { ...withKey, method: "POST", body: "{}" },
    );
    const body = await res.json();
    const out = body.steps.find(
      (s: { type: string }) => s.type === "model_output",
    );
    expect(Buffer.from(out.content[0].data, "base64").toString()).toBe(
      "INLINE",
    );
  });

  it("completes the interaction with an error when videoError is set", async () => {
    const fg = createFakeGemini({ videoError: "content policy" });
    const res = await fg.fetch(
      "https://generativelanguage.googleapis.com/v1beta/interactions",
      { ...withKey, method: "POST", body: "{}" },
    );
    const body = await res.json();
    expect(body.error.message).toBe("content policy");
  });
});
