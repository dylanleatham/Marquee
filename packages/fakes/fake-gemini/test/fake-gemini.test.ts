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
});
