// Colours from the album's feeling (ADR 0030 / issue #105). The properties worth pinning are the
// ones that make the button safe to press: the cover stays the default, proposing changes nothing,
// and a chosen palette protects itself from the next library sweep.
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { AssetStore } from "../src/store/asset-store.js";
import { buildServer } from "../src/server.js";
import { GeminiClient } from "../src/gemini/client.js";
import { blendPalettes } from "../src/albums/palette.js";
import { resolvedArtworkFile } from "../src/albums/artwork.js";
import { feelingPaletteWithGemini } from "../src/gemini/feeling.js";
import { regeneratePalettesRunner } from "../src/albums/batch.js";
import { fakeRoadie, fakeProber, fakeGenerate, makeAsset } from "./helpers.js";

/** A Gemini client whose two calls return canned research + a canned colour JSON. */
function fakeGemini(
  colorsJson = '{"rationale":"Late-night and smoky.","colors":[{"hex":"#1B2A4A"},{"hex":"#C2410C"},{"hex":"#E8B44A"},{"hex":"#0F172A"}]}',
) {
  const calls: string[] = [];
  const fetch = (async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as {
      contents: { parts: { text: string }[] }[];
    };
    calls.push(body.contents[0]!.parts[0]!.text);
    const text =
      calls.length === 1 ? "It sounds nocturnal and warm." : colorsJson;
    return new Response(
      JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof globalThis.fetch;
  return {
    client: new GeminiClient({ apiKey: "k", fetch: fetch as never }),
    calls,
  };
}

function seeded() {
  const store = new AssetStore(mkdtempSync(join(tmpdir(), "curator-feel-")));
  const asset = makeAsset("feelalb1", "Kind of Blue", "Miles Davis");
  store.save(asset);
  const art = resolvedArtworkFile(store, asset);
  mkdirSync(dirname(art), { recursive: true });
  writeFileSync(art, Buffer.from("IMG"));
  return store;
}

const server = (store: AssetStore, gemini?: GeminiClient) =>
  buildServer({
    store,
    roadie: fakeRoadie(store),
    prober: fakeProber(),
    generate: fakeGenerate,
    ...(gemini ? { gemini } : {}),
  }).app;

describe("blendPalettes", () => {
  it("keeps the cover's dominant, then the feeling's colours behind it", () => {
    const out = blendPalettes(
      [{ hex: "#111111" }, { hex: "#222222" }],
      [{ hex: "#AA0000" }, { hex: "#00BB00" }],
    );
    // The room still reads as the object on the stand; only what surrounds it changes.
    expect(out.map((c) => c.hex)).toEqual(["#111111", "#AA0000", "#00BB00"]);
  });

  it("never shows the same colour twice", () => {
    const out = blendPalettes(
      [{ hex: "#abcdef" }],
      [{ hex: "#ABCDEF" }, { hex: "#123456" }],
    );
    expect(out.map((c) => c.hex)).toEqual(["#ABCDEF", "#123456"]);
  });

  it("stays within the contract's colour bound", () => {
    const many = Array.from({ length: 12 }, (_, i) => ({
      hex: `#${i.toString(16).repeat(6).slice(0, 6)}`,
    }));
    expect(
      blendPalettes([{ hex: "#FFFFFF" }], many).length,
    ).toBeLessThanOrEqual(8);
  });

  it("survives an album with no cover palette to draw a dominant from", () => {
    expect(blendPalettes([], [{ hex: "#AA0000" }]).map((c) => c.hex)).toEqual([
      "#AA0000",
    ]);
  });
});

describe("feelingPaletteWithGemini", () => {
  it("researches the sound, not the sleeve, then asks for colours", async () => {
    const { client, calls } = fakeGemini();
    const out = await feelingPaletteWithGemini(client, {
      name: "Kind of Blue",
      artist: "Miles Davis",
      source: "manual",
    });

    expect(calls).toHaveLength(2);
    // The whole point of the feature: this signal must not be another read of the cover.
    expect(calls[0]).toMatch(/sounds and what it is about/i);
    expect(calls[0]).not.toMatch(/cover art/i);
    // The colour pass is grounded in the research, not just the title.
    expect(calls[1]).toMatch(/nocturnal and warm/);
    expect(out.hexes).toEqual(["#1B2A4A", "#C2410C", "#E8B44A", "#0F172A"]);
    expect(out.rationale).toBe("Late-night and smoky.");
  });

  it("fails loudly rather than returning a one-colour palette", async () => {
    // A model that put prose in the hex field must not silently degrade into a usable-looking
    // palette — the user pressed a button that costs money and deserves to see it fail.
    const { client } = fakeGemini(
      '{"rationale":"x","colors":[{"hex":"deep blue"},{"hex":"#112233"}]}',
    );
    await expect(
      feelingPaletteWithGemini(client, {
        name: "N",
        artist: "A",
        source: "manual",
      }),
    ).rejects.toThrow(/fewer than two usable colors/);
  });
});

describe("palette feeling + choose routes", () => {
  it("proposes candidates without touching the palette in force", async () => {
    const store = seeded();
    const before = store.read("feelalb1")!.palette!;
    const res = await server(store, fakeGemini().client).inject({
      method: "POST",
      url: "/api/albums/feelalb1/palette/feeling",
    });

    expect(res.statusCode).toBe(200);
    const { candidates } = res.json();
    expect(candidates.rationale).toBe("Late-night and smoky.");
    expect(candidates.feeling[0].hex).toBe("#1B2A4A");
    // The blend leads with the cover's dominant.
    expect(candidates.blend[0].hex).toBe(before.colors[0]!.hex);
    // The cover extraction is snapshotted, so "From the cover" still has swatches to show after
    // you've switched away from it — otherwise you'd pick between an option you can see and one
    // you can't.
    expect(candidates.cover).toEqual(before.colors);
    // Nothing applied — that is what makes the button safe to press.
    const after = store.read("feelalb1")!;
    expect(after.palette).toEqual(before);
    expect(after.palette!.source).toBeUndefined();
  });

  it("400s without a Gemini key rather than pretending", async () => {
    const res = await server(seeded()).inject({
      method: "POST",
      url: "/api/albums/feelalb1/palette/feeling",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/Gemini API key/);
  });

  it("applies a chosen feeling palette, and protects it from the next sweep", async () => {
    const store = seeded();
    const app = server(store, fakeGemini().client);
    await app.inject({
      method: "POST",
      url: "/api/albums/feelalb1/palette/feeling",
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/albums/feelalb1/palette/choose",
      payload: { source: "feeling" },
    });
    expect(res.statusCode).toBe(200);

    const saved = store.read("feelalb1")!;
    expect(saved.palette!.colors[0]!.hex).toBe("#1B2A4A");
    expect(saved.palette!.source).toBe("feeling");
    expect(saved.palette!.rationale).toBe("Late-night and smoky.");
    // ADR 0030: choosing sets handEdited, so every existing protection covers it with no new rule.
    expect(saved.palette!.handEdited).toBe(true);

    // Concretely: a plain re-extract now refuses, exactly as it would over a hand-edit.
    const regen = await app.inject({
      method: "POST",
      url: "/api/albums/feelalb1/palette/generate",
    });
    expect(regen.statusCode).toBe(409);
  });

  it("re-derives the motion from the palette that won (ADR 0033)", async () => {
    const store = seeded();
    const app = server(store, fakeGemini().client);
    await app.inject({
      method: "POST",
      url: "/api/albums/feelalb1/palette/feeling",
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/albums/feelalb1/palette/choose",
      payload: { source: "blend" },
    });

    // The colours changing without the motion changing would leave the record still behaving like
    // its sleeve, which is the thing this feature exists to fix.
    expect(res.json().pattern).toBeTruthy();
    expect(store.read("feelalb1")!.pattern!.type).toBeTruthy();
  });

  it("choosing the cover is the undo: re-extracts and drops the protection", async () => {
    const store = seeded();
    const app = server(store, fakeGemini().client);
    await app.inject({
      method: "POST",
      url: "/api/albums/feelalb1/palette/feeling",
    });
    await app.inject({
      method: "POST",
      url: "/api/albums/feelalb1/palette/choose",
      payload: { source: "feeling" },
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/albums/feelalb1/palette/choose",
      payload: { source: "cover" },
    });
    expect(res.statusCode).toBe(200);

    const saved = store.read("feelalb1")!;
    expect(saved.palette!.source).toBe("cover");
    expect(saved.palette!.handEdited).toBe(false); // back under the sweep's care
    expect(saved.palette!.algorithm).toBe("fake@0"); // genuinely re-extracted
    // Amended 2026-08-05 (ADR 0052): this used to assert `paletteCandidates` was deleted, on the
    // grounds that they described the palette just replaced. True of `cover` and `blend`, which are
    // now re-pointed at the new extraction — and false of `feeling`, which is about how the record
    // *sounds*. The undo undoes the choice; it does not spend the user's Gemini call again.
    expect(saved.paletteCandidates!.feeling[0]!.hex).toBe("#1B2A4A");
    expect(saved.paletteCandidates!.cover.map((c) => c.hex)).toEqual(
      saved.palette!.colors.map((c) => c.hex),
    );
  });

  it("rejects an unknown source, and a choice with nothing to choose from", async () => {
    const store = seeded();
    const app = server(store, fakeGemini().client);

    const bad = await app.inject({
      method: "POST",
      url: "/api/albums/feelalb1/palette/choose",
      payload: { source: "vibes" },
    });
    expect(bad.statusCode).toBe(400);

    const early = await app.inject({
      method: "POST",
      url: "/api/albums/feelalb1/palette/choose",
      payload: { source: "feeling" },
    });
    expect(early.statusCode).toBe(400);
    expect(early.json().error).toMatch(/run the feeling pass first/);
  });
});

describe("a chosen palette and the library sweep (ADR 0029 × ADR 0030)", () => {
  it("survives a library-wide regeneration, and is reported rather than passed over", async () => {
    const store = seeded();
    const app = server(store, fakeGemini().client);
    await app.inject({
      method: "POST",
      url: "/api/albums/feelalb1/palette/feeling",
    });
    await app.inject({
      method: "POST",
      url: "/api/albums/feelalb1/palette/choose",
      payload: { source: "feeling" },
    });

    // The whole point of ADR 0030 reusing `handEdited` instead of adding a second guard: the sweep
    // needs no knowledge of "feeling" to leave a deliberate choice alone.
    const { paletteBatch } = await regeneratePalettesRunner(
      { store, prober: fakeProber(), generate: fakeGenerate },
      {},
    )({ onProgress: () => {}, signal: new AbortController().signal });

    expect(paletteBatch.regenerated).toBe(0);
    expect(paletteBatch.items[0]!.status).toBe("skipped_hand_edited");
    expect(store.read("feelalb1")!.palette!.colors[0]!.hex).toBe("#1B2A4A");
    expect(store.read("feelalb1")!.palette!.source).toBe("feeling");
  });

  it("is still reachable with force, which is the documented escape hatch", async () => {
    const store = seeded();
    const app = server(store, fakeGemini().client);
    await app.inject({
      method: "POST",
      url: "/api/albums/feelalb1/palette/feeling",
    });
    await app.inject({
      method: "POST",
      url: "/api/albums/feelalb1/palette/choose",
      payload: { source: "feeling" },
    });

    const { paletteBatch } = await regeneratePalettesRunner(
      { store, prober: fakeProber(), generate: fakeGenerate },
      { force: true },
    )({ onProgress: () => {}, signal: new AbortController().signal });

    expect(paletteBatch.regenerated).toBe(1);
    expect(store.read("feelalb1")!.palette!.source).toBe("cover");
  });
});

// The record page (ADR 0052) tells the user, in as many words, that "Roadie's original extraction
// and the feeling palette are always here — nothing you do to this list destroys either". These are
// the two ways that promise was false before the overhaul.
describe("both source palettes survive (ADR 0052)", () => {
  it("keeps the feeling colours when the cover is re-extracted", async () => {
    const store = seeded();
    const app = server(store, fakeGemini().client);
    await app.inject({
      method: "POST",
      url: "/api/albums/feelalb1/palette/feeling",
    });
    const proposed = store.read("feelalb1")!.paletteCandidates!;
    expect(proposed.feeling[0]!.hex).toBe("#1B2A4A");

    // "Back to Roadie's original" is a re-extraction. It used to delete the candidates outright,
    // so the one stored copy of the feeling palette went with it — and getting it back costs a
    // Gemini call the user never asked to spend twice.
    const res = await app.inject({
      method: "POST",
      url: "/api/albums/feelalb1/palette/generate?force=1",
    });
    expect(res.statusCode).toBe(200);

    const after = store.read("feelalb1")!;
    expect(after.palette!.source).toBe("cover");
    expect(after.paletteCandidates?.feeling.map((c) => c.hex)).toEqual(
      proposed.feeling.map((c) => c.hex),
    );
    expect(after.paletteCandidates?.rationale).toBe(proposed.rationale);
  });

  it("re-points cover and blend at the extraction that now exists", async () => {
    // The old comment was right that a *stale* blend is worse than none: it would offer colours
    // mixed against a cover that has been replaced. Re-blending is what makes keeping them honest.
    const store = seeded();
    const app = server(store, fakeGemini().client);
    await app.inject({
      method: "POST",
      url: "/api/albums/feelalb1/palette/feeling",
    });
    await app.inject({
      method: "POST",
      url: "/api/albums/feelalb1/palette/generate?force=1",
    });

    const after = store.read("feelalb1")!;
    const cover = after.palette!.colors.map((c) => c.hex);
    expect(after.paletteCandidates!.cover.map((c) => c.hex)).toEqual(cover);
    expect(after.paletteCandidates!.blend.map((c) => c.hex)).toEqual(
      blendPalettes(
        cover.map((hex) => ({ hex })),
        after.paletteCandidates!.feeling.map((c) => ({ hex: c.hex })),
      ).map((c) => c.hex),
    );
  });

  it("keeps Roadie's note when a colour is nudged by hand", async () => {
    // The note is prose about the record, not a claim about the exact hexes. The record page shows
    // it above the editor, so dropping it on edit meant it vanished the first time you touched
    // anything — and there is no other source for it.
    const store = seeded();
    const app = server(store, fakeGemini().client);
    await app.inject({
      method: "POST",
      url: "/api/albums/feelalb1/palette/feeling",
    });
    await app.inject({
      method: "POST",
      url: "/api/albums/feelalb1/palette/choose",
      payload: { source: "feeling" },
    });
    expect(store.read("feelalb1")!.palette!.rationale).toBe(
      "Late-night and smoky.",
    );

    const res = await app.inject({
      method: "PUT",
      url: "/api/albums/feelalb1/palette",
      payload: { colors: [{ hex: "#1B2A4B" }, { hex: "#C2410C" }] },
    });
    expect(res.statusCode).toBe(200);
    const after = store.read("feelalb1")!.palette!;
    expect(after.handEdited).toBe(true);
    expect(after.rationale).toBe("Late-night and smoky.");
  });
});
