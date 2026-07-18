import { describe, it, expect } from "vitest";
import { createFakeGemini } from "@marquee/fake-gemini";
import { GeminiClient, type FetchLike } from "../src/gemini/client.js";

const client = (fg = createFakeGemini()) =>
  new GeminiClient({ apiKey: "k", fetch: fg.fetch });

describe("GeminiClient", () => {
  it("sends a grounded call (google_search tool, no schema) and returns the text", async () => {
    const fg = createFakeGemini({ research: "the cover is a purple sky" });
    const text = await client(fg).generateText({
      prompt: "Research Purple Rain",
      grounded: true,
    });
    expect(text).toBe("the cover is a purple sky");
    expect(fg.calls()[0]).toMatchObject({
      model: "gemini-2.5-flash",
      grounded: true,
      structured: false,
    });
  });

  it("sends a structured call with responseSchema and returns the JSON string", async () => {
    const fg = createFakeGemini({ json: { variants: [{ text: "x" }] } });
    const text = await client(fg).generateText({
      prompt: "Draft prompts",
      system: "You are a prompt engineer",
      responseSchema: { type: "object" },
    });
    expect(JSON.parse(text)).toEqual({ variants: [{ text: "x" }] });
    const call = fg.calls()[0]!;
    expect(call.structured).toBe(true);
    expect(call.body.systemInstruction?.parts?.[0]?.text).toContain(
      "prompt engineer",
    );
  });

  it("refuses to combine grounding and responseSchema (API rejects it)", async () => {
    await expect(
      client().generateText({
        prompt: "x",
        grounded: true,
        responseSchema: { type: "object" },
      }),
    ).rejects.toMatchObject({ name: "GeminiError" });
  });

  it("throws GeminiError with the status on an API error", async () => {
    const fg = createFakeGemini({ failStatus: 500 });
    await expect(
      client(fg).generateText({ prompt: "x" }),
    ).rejects.toMatchObject({ name: "GeminiError", status: 500 });
  });

  it("never puts the api key in the URL (secrets belong in headers)", async () => {
    const spy: FetchLike = async (input, init) => {
      expect(String(input)).not.toContain("k-secret");
      expect((init?.headers as Record<string, string>)["x-goog-api-key"]).toBe(
        "k-secret",
      );
      return new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: "ok" }] } }],
        }),
        { headers: { "content-type": "application/json" } },
      );
    };
    const c = new GeminiClient({ apiKey: "k-secret", fetch: spy });
    expect(await c.generateText({ prompt: "x" })).toBe("ok");
  });

  it("generateImage returns the decoded image bytes from inlineData", async () => {
    const png = Buffer.from("PNGBYTES").toString("base64");
    const fg = createFakeGemini({ imageBase64: png });
    const bytes = await client(fg).generateImage("a purple motorcycle");
    expect(bytes.toString()).toBe("PNGBYTES");
    expect(fg.calls()[0]!.model).toBe("gemini-2.5-flash-image");
  });

  it("generateImage throws when the response carries no image", async () => {
    // The text model returns text, not inlineData → no image bytes.
    const fg = createFakeGemini({ text: "no image here" });
    await expect(
      client(fg).generateImage("x", "gemini-2.5-flash"),
    ).rejects.toMatchObject({ name: "GeminiError" });
  });

  it("times out a hung request (504) instead of hanging forever", async () => {
    const hanging: FetchLike = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
        );
      });
    const c = new GeminiClient({ apiKey: "k", fetch: hanging, timeoutMs: 20 });
    await expect(c.generateText({ prompt: "x" })).rejects.toMatchObject({
      name: "GeminiError",
      status: 504,
    });
  });
});
