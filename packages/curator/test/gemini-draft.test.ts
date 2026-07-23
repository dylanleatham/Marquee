import { describe, it, expect } from "vitest";
import { createFakeGemini } from "@marquee/fake-gemini";
import { GeminiClient } from "../src/gemini/client.js";
import {
  draftPromptsWithGemini,
  draftOnePromptWithGemini,
} from "../src/gemini/draft.js";
import type { AlbumMetadata } from "../src/albums/asset.js";

const at = () => "2026-07-18T00:00:00.000Z";
const meta: AlbumMetadata = {
  name: "Purple Rain",
  artist: "Prince",
  year: 1984,
  genres: ["funk", "rock"],
  source: "spotify",
};
const colors = [
  { hex: "#4B0082", role: "primary" },
  { hex: "#FFD700", role: "accent" },
];
const client = (fg: ReturnType<typeof createFakeGemini>) =>
  new GeminiClient({ apiKey: "k", fetch: fg.fetch });

const variants = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    text: `Prompt ${i} grounded in the cover`,
    nudge: `angle ${i}`,
  }));

describe("draftPromptsWithGemini", () => {
  it("returns grounded variant sets for both types (research once, draft twice)", async () => {
    const fg = createFakeGemini({
      research: "the cover is a purple motorcycle scene",
      json: { variants: variants(5) },
    });
    const { video, cardArt } = await draftPromptsWithGemini(
      client(fg),
      meta,
      colors,
      { now: at },
    );

    expect(video.generator).toBe("gemini");
    expect(video.variants).toHaveLength(5);
    expect(video.selectedIndex).toBe(0);
    expect(video.generatedAt).toBe(at());
    expect(cardArt.variants).toHaveLength(5);
    // One grounded research call feeds both structured drafting calls.
    expect(fg.calls().filter((c) => c.grounded)).toHaveLength(1);
    expect(fg.calls().filter((c) => c.structured)).toHaveLength(2);
  });

  it("caps and cleans the variants: drops blanks, slices to n", async () => {
    const fg = createFakeGemini({
      research: "facts",
      json: {
        variants: [
          { text: "keep 1", nudge: "a" },
          { text: "   ", nudge: "blank dropped" },
          { text: "keep 2", nudge: "b" },
          { text: "keep 3", nudge: "c" },
        ],
      },
    });
    const drafted = await draftOnePromptWithGemini(
      client(fg),
      "cardArt",
      meta,
      colors,
      { n: 2, now: at },
    );
    // Blank filtered, then sliced to n=2.
    expect(drafted.variants.map((v) => v.text)).toEqual(["keep 1", "keep 2"]);
  });

  it("injects the no-real-people safety guardrail into the drafting user turn (ADR 0023)", async () => {
    const fg = createFakeGemini({
      research: "facts",
      json: { variants: variants(5) },
    });
    await draftOnePromptWithGemini(client(fg), "video", meta, colors, {
      now: at,
    });
    // The structured (responseSchema) drafting call's user turn must carry the guardrail so the
    // authored prompts never request the recording artist or any identifiable person.
    const structured = fg.calls().find((c) => c.structured);
    const userTurn = structured?.body?.contents?.[0]?.parts?.[0]?.text ?? "";
    expect(userTurn).toContain(
      "never request real, named, or identifiable people",
    );
  });

  it("throws on a malformed structured response (caller falls back)", async () => {
    // research ok, but the structured pass returns an empty object → no variants array.
    const fg = createFakeGemini({ research: "facts", json: {} });
    await expect(
      draftOnePromptWithGemini(client(fg), "video", meta, colors, { now: at }),
    ).rejects.toMatchObject({ name: "GeminiError" });
  });

  it("propagates a research (grounding) failure", async () => {
    const fg = createFakeGemini({ failStatus: 503 });
    await expect(
      draftPromptsWithGemini(client(fg), meta, colors, { now: at }),
    ).rejects.toMatchObject({ name: "GeminiError", status: 503 });
  });
});
