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
  generateCardArt: true, // generation is opt-in; enable it for these tests
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

  it("when every image is invalid, throws a non-ImageError (maps to 5xx, not 422)", async () => {
    const s = store();
    const id = seed(s, "gggg7777", 3);
    // Every response is a 200 with non-image bytes → all ingests fail with ImageError. The batch
    // failure must not surface as an ImageError (which the route maps to 422); it's an upstream fault.
    const fg = createFakeGemini({
      imageBase64: Buffer.from("NOT-AN-IMAGE").toString("base64"),
    });
    await expect(
      actions.generateCardArtSet(deps(s, geminiWith(fg.fetch)), id),
    ).rejects.toSatisfy((e: Error) => e.name !== "ImageError");
  });

  it("400s (ValidationError) when Gemini isn't configured", async () => {
    const s = store();
    const id = seed(s);
    await expect(
      actions.generateCardArtSet(deps(s, undefined), id),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("does not clobber a concurrent write during generation (#38 — re-reads before save)", async () => {
    const s = store();
    const id = seed(s, "hhhh8888", 5); // makeAsset names it "Purple Rain"
    const png = pngBytes().toString("base64");
    // Simulate a second action landing a write while the (slow) image generation is in flight:
    // on the first image call, change a field and save it independently.
    let concurrentDone = false;
    const fetch: FetchLike = async () => {
      if (!concurrentDone) {
        concurrentDone = true;
        const other = s.read(id)!;
        other.metadata.name = "CHANGED BY CONCURRENT ACTION";
        s.save(other);
      }
      return new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ inlineData: { data: png } }] } }],
        }),
        { headers: { "content-type": "application/json" } },
      );
    };
    await actions.generateCardArtSet(deps(s, geminiWith(fetch)), id);

    const final = s.read(id)!;
    expect(final.cardArtCandidates).toHaveLength(5); // our candidates persisted
    // ...and the concurrent write survived (before the fix, generate saved a stale copy → reverted).
    expect(final.metadata.name).toBe("CHANGED BY CONCURRENT ACTION");
  });

  it("400s when card-art generation is toggled off (opt-in)", async () => {
    const s = store();
    const id = seed(s);
    const fg = createFakeGemini({ imageBase64: pngBytes().toString("base64") });
    await expect(
      actions.generateCardArtSet(
        { store: s, prober: fakeProber(), gemini: geminiWith(fg.fetch), now },
        id,
      ),
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

describe("generateCardArtOne (per-prompt, ADR 0021)", () => {
  it("generates a single candidate at the given index and stores it", async () => {
    const s = store();
    const id = seed(s, "aaaa1111", 5);
    const fg = createFakeGemini({ imageBase64: pngBytes().toString("base64") });
    const asset = await actions.generateCardArtOne(
      deps(s, geminiWith(fg.fetch)),
      id,
      2,
    );

    expect(asset.cardArtCandidates).toHaveLength(1);
    expect(asset.cardArtCandidates![0]).toMatchObject({
      index: 2,
      fileId: "aaaa1111-c2",
      ext: "png",
      nudge: "look 2",
    });
    expect(existsSync(s.paths.cardArtFile("aaaa1111-c2", "png"))).toBe(true);
    // Exactly one image call for the single prompt.
    expect(fg.calls()).toHaveLength(1);
  });

  it("merges into the existing set: keeps siblings, replaces its own index, stays sorted", async () => {
    const s = store();
    const id = seed(s, "bbbb2222", 5);
    const fg = createFakeGemini({ imageBase64: pngBytes().toString("base64") });
    const d = deps(s, geminiWith(fg.fetch));

    await actions.generateCardArtOne(d, id, 3);
    await actions.generateCardArtOne(d, id, 1);
    // Re-generating index 3 must replace, not duplicate, that candidate.
    const asset = await actions.generateCardArtOne(d, id, 3);

    expect(asset.cardArtCandidates!.map((c) => c.index)).toEqual([1, 3]);
  });

  it("400s (ValidationError) for an out-of-range prompt index", async () => {
    const s = store();
    const id = seed(s, "cccc3333", 5);
    const fg = createFakeGemini({ imageBase64: pngBytes().toString("base64") });
    await expect(
      actions.generateCardArtOne(deps(s, geminiWith(fg.fetch)), id, 9),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("400s when Gemini isn't configured", async () => {
    const s = store();
    const id = seed(s, "dddd4444", 5);
    await expect(
      actions.generateCardArtOne(deps(s, undefined), id, 0),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("400s when card-art generation is toggled off (opt-in)", async () => {
    const s = store();
    const id = seed(s, "eeee5555", 5);
    const fg = createFakeGemini({ imageBase64: pngBytes().toString("base64") });
    await expect(
      actions.generateCardArtOne(
        { store: s, prober: fakeProber(), gemini: geminiWith(fg.fetch), now },
        id,
        0,
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("400s when there's no card-art prompt to generate from", async () => {
    const s = store();
    const asset = makeAsset("ffff6666");
    s.save(asset); // no promptDrafts
    const fg = createFakeGemini({ imageBase64: pngBytes().toString("base64") });
    await expect(
      actions.generateCardArtOne(deps(s, geminiWith(fg.fetch)), "ffff6666", 0),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("propagates a generation failure (maps to 5xx)", async () => {
    const s = store();
    const id = seed(s, "gggg7777", 5);
    const fg = createFakeGemini({ failStatus: 500 });
    await expect(
      actions.generateCardArtOne(deps(s, geminiWith(fg.fetch)), id, 0),
    ).rejects.toMatchObject({ name: "GeminiError", status: 500 });
    expect(s.read(id)!.cardArtCandidates).toBeUndefined();
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
