import { describe, it, expect } from "vitest";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakeGemini } from "@marquee/fake-gemini";
import { AssetStore } from "../src/store/asset-store.js";
import { GeminiClient, type FetchLike } from "../src/gemini/client.js";
import * as actions from "../src/albums/actions.js";
import { type ActionDeps } from "../src/albums/actions.js";
import { ValidationError } from "../src/albums/add-manual.js";
import type { DraftedPrompt } from "../src/roadie/prompts.js";
import { makeAsset, fakeProber, pngBytes } from "./helpers.js";

const store = () => new AssetStore(mkdtempSync(join(tmpdir(), "curator-ca-")));
const now = () => "2026-07-18T00:00:00.000Z";

const cardArtDraft = (n: number): DraftedPrompt => ({
  variants: Array.from({ length: n }, (_, i) => ({
    text: `card prompt ${i}`,
    nudge: `look ${i}`,
  })),
  selectedIndex: 0,
  generator: "gemini",
  generatedAt: now(),
});

/** Seed an awaiting_review album with a palette + an n-variant card-art prompt. */
function seed(s: AssetStore, id = "aaaa1111", variants = 5) {
  const asset = makeAsset(id, "Purple Rain", "Prince");
  asset.promptDrafts = { cardArt: cardArtDraft(variants) };
  s.save(asset);
  return id;
}

const geminiWith = (fetch: FetchLike) =>
  new GeminiClient({ apiKey: "k", fetch });
const deps = (s: AssetStore, gemini?: GeminiClient): ActionDeps => ({
  store: s,
  prober: fakeProber(),
  gemini,
  now,
});

describe("generateCardArtSet", () => {
  it("generates one candidate per prompt variant and stores them", async () => {
    const s = store();
    const id = seed(s, "aaaa1111", 5);
    const fg = createFakeGemini({ imageBase64: pngBytes().toString("base64") });
    const asset = await actions.generateCardArtSet(
      deps(s, geminiWith(fg.fetch)),
      id,
    );

    expect(asset.cardArtCandidates).toHaveLength(5);
    expect(asset.cardArtCandidates!.map((c) => c.index)).toEqual([
      0, 1, 2, 3, 4,
    ]);
    expect(asset.cardArtCandidates![0]).toMatchObject({
      fileId: "aaaa1111-c0",
      ext: "png",
      nudge: "look 0",
    });
    // Every candidate image is on disk.
    for (const c of asset.cardArtCandidates!)
      expect(existsSync(s.paths.cardArtFile(c.fileId, c.ext))).toBe(true);
    // One image call per variant.
    expect(fg.calls()).toHaveLength(5);
  });

  it("keeps the successes when some generations fail (partial failure)", async () => {
    const s = store();
    const id = seed(s, "bbbb2222", 4);
    // Fail the 2nd call; succeed on the rest.
    let n = 0;
    const fetch: FetchLike = async () => {
      n += 1;
      if (n === 2)
        return new Response(JSON.stringify({ error: { code: 500 } }), {
          status: 500,
          headers: { "content-type": "application/json" },
        });
      return new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  { inlineData: { data: pngBytes().toString("base64") } },
                ],
              },
            },
          ],
        }),
        { headers: { "content-type": "application/json" } },
      );
    };
    const asset = await actions.generateCardArtSet(
      deps(s, geminiWith(fetch)),
      id,
    );
    // 3 of 4 succeeded; the failed one is simply absent (indices preserved for the rest).
    expect(asset.cardArtCandidates).toHaveLength(3);
    expect(asset.cardArtCandidates!.map((c) => c.index)).toEqual([0, 2, 3]);
  });

  it("keeps the successes when a generation returns non-image bytes (ADR 0010 partial-keep)", async () => {
    const s = store();
    const id = seed(s, "bbbb3333", 3);
    // A 200 whose inlineData is NOT a PNG/JPEG — the image-validation failure mode, distinct from a
    // network failure. It must be dropped like any other failure, not abort the whole set.
    const inline = (b64: string) =>
      new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ inlineData: { data: b64 } }] } }],
        }),
        { headers: { "content-type": "application/json" } },
      );
    let n = 0;
    const fetch: FetchLike = async () => {
      n += 1;
      return inline(
        n === 2
          ? Buffer.from("NOT-AN-IMAGE").toString("base64")
          : pngBytes().toString("base64"),
      );
    };
    const asset = await actions.generateCardArtSet(
      deps(s, geminiWith(fetch)),
      id,
    );
    expect(asset.cardArtCandidates).toHaveLength(2);
    expect(asset.cardArtCandidates!.map((c) => c.index)).toEqual([0, 2]);
  });

  it("throws when every generation fails", async () => {
    const s = store();
    const id = seed(s, "cccc3333", 3);
    const fg = createFakeGemini({ failStatus: 500 });
    await expect(
      actions.generateCardArtSet(deps(s, geminiWith(fg.fetch)), id),
    ).rejects.toMatchObject({ name: "GeminiError", status: 500 });
    expect(s.read(id)!.cardArtCandidates).toBeUndefined();
  });

  it("400s (ValidationError) when Gemini isn't configured", async () => {
    const s = store();
    const id = seed(s);
    await expect(
      actions.generateCardArtSet(deps(s, undefined), id),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("400s when there's no card-art prompt to generate from", async () => {
    const s = store();
    const asset = makeAsset("dddd4444");
    s.save(asset); // no promptDrafts
    const fg = createFakeGemini({ imageBase64: pngBytes().toString("base64") });
    await expect(
      actions.generateCardArtSet(deps(s, geminiWith(fg.fetch)), "dddd4444"),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

describe("selectCardArt", () => {
  it("promotes a candidate to the attached card art", async () => {
    const s = store();
    const id = seed(s, "eeee5555", 3);
    const fg = createFakeGemini({ imageBase64: pngBytes().toString("base64") });
    await actions.generateCardArtSet(deps(s, geminiWith(fg.fetch)), id);

    const asset = actions.selectCardArt(deps(s), id, 2);
    expect(asset.cardArt).toBeTruthy();
    expect(asset.cardArt!.fileId).toBe(id); // canonical key, served at /card-art
    expect(asset.cardArt!.originalFilename).toContain("look 2");
    expect(existsSync(s.paths.cardArtFile(id, asset.cardArt!.ext))).toBe(true);
  });

  it("400s for an out-of-range candidate index", async () => {
    const s = store();
    const id = seed(s, "ffff6666", 2);
    const fg = createFakeGemini({ imageBase64: pngBytes().toString("base64") });
    await actions.generateCardArtSet(deps(s, geminiWith(fg.fetch)), id);
    expect(() => actions.selectCardArt(deps(s), id, 9)).toThrow(
      ValidationError,
    );
  });
});
