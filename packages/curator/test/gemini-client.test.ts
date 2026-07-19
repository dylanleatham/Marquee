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
      model: "gemini-flash-latest",
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
    expect(fg.calls()[0]!.model).toBe("gemini-3.1-flash-image");
  });

  it("generateImage throws when the response carries no image", async () => {
    // The text model returns text, not inlineData → no image bytes.
    const fg = createFakeGemini({ text: "no image here" });
    await expect(
      client(fg).generateImage("x", "gemini-2.5-flash"),
    ).rejects.toMatchObject({ name: "GeminiError" });
  });

  it("generateImage throws when the prompt is safety-blocked", async () => {
    const blocked: FetchLike = async () =>
      new Response(
        JSON.stringify({ promptFeedback: { blockReason: "SAFETY" } }),
        {
          headers: { "content-type": "application/json" },
        },
      );
    const c = new GeminiClient({ apiKey: "k", fetch: blocked });
    await expect(c.generateImage("x")).rejects.toMatchObject({
      name: "GeminiError",
    });
  });

  it("generateVideo posts an Omni interaction with the reference image, then downloads the clip", async () => {
    const fg = createFakeGemini({ videoBytes: "MP4-DATA" });
    const c = new GeminiClient({
      apiKey: "k",
      fetch: fg.fetch,
      sleep: async () => {},
    });
    const bytes = await c.generateVideo(
      "animate the cover",
      Buffer.from("JPG"),
    );
    expect(bytes.toString()).toBe("MP4-DATA");
    expect(fg.calls().map((x) => x.video)).toEqual(["interaction", "download"]);
    // The request used the Omni model + carried the cover image as an input part.
    const call = fg.calls()[0]!;
    expect(call.model).toBe("gemini-omni-flash-preview");
    expect(call.body.input?.some((p) => p.type === "image")).toBe(true);
    expect(call.body.input?.some((p) => p.type === "text")).toBe(true);
  });

  it("generateVideo returns inline video bytes without a download when delivered inline", async () => {
    const fg = createFakeGemini({ videoBytes: "INLINE", videoInline: true });
    const c = new GeminiClient({ apiKey: "k", fetch: fg.fetch });
    expect((await c.generateVideo("p", Buffer.from("JPG"))).toString()).toBe(
      "INLINE",
    );
    // No separate download call when the video came back inline.
    expect(fg.calls().some((x) => x.video === "download")).toBe(false);
  });

  it("generateVideo rejects when the interaction call fails", async () => {
    const fg = createFakeGemini({ failStatus: 500 });
    const c = new GeminiClient({ apiKey: "k", fetch: fg.fetch });
    await expect(
      c.generateVideo("p", Buffer.from("JPG")),
    ).rejects.toMatchObject({ name: "GeminiError", status: 500 });
  });

  it("generateVideo rejects when the interaction completes with an error", async () => {
    const fg = createFakeGemini({ videoError: "content policy" });
    const c = new GeminiClient({ apiKey: "k", fetch: fg.fetch });
    await expect(
      c.generateVideo("p", Buffer.from("JPG")),
    ).rejects.toMatchObject({ name: "GeminiError" });
  });

  it("generateVideo rejects when the response has no video part", async () => {
    const fetch: FetchLike = async () =>
      new Response(
        JSON.stringify({
          status: "completed",
          steps: [{ type: "thought", content: [] }],
        }),
        { headers: { "content-type": "application/json" } },
      );
    const c = new GeminiClient({ apiKey: "k", fetch });
    await expect(
      c.generateVideo("p", Buffer.from("JPG")),
    ).rejects.toMatchObject({ name: "GeminiError" });
  });

  it("generateVideo retries a not-yet-ready file download, then succeeds", async () => {
    let downloads = 0;
    const fetch: FetchLike = async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === "/v1beta/interactions")
        return new Response(
          JSON.stringify({
            status: "completed",
            steps: [
              {
                type: "model_output",
                content: [
                  {
                    type: "video",
                    mime_type: "video/mp4",
                    uri: "https://x.test/download/f.mp4",
                  },
                ],
              },
            ],
          }),
          { headers: { "content-type": "application/json" } },
        );
      // First download 404s (file not ACTIVE yet), second succeeds.
      downloads += 1;
      return downloads === 1
        ? new Response("not ready", { status: 404 })
        : new Response("READY-MP4");
    };
    const c = new GeminiClient({
      apiKey: "k",
      fetch,
      sleep: async () => {},
      videoMaxPolls: 3,
    });
    expect((await c.generateVideo("p", Buffer.from("JPG"))).toString()).toBe(
      "READY-MP4",
    );
    expect(downloads).toBe(2);
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
