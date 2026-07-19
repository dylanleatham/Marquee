import { describe, it, expect } from "vitest";
import {
  mkdtempSync,
  existsSync,
  mkdirSync,
  writeFileSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakeGemini } from "@marquee/fake-gemini";
import { AssetStore } from "../src/store/asset-store.js";
import { GeminiClient, type FetchLike } from "../src/gemini/client.js";
import { VideoError, type VideoProber } from "../src/media/video.js";
import * as actions from "../src/albums/actions.js";
import { type ActionDeps } from "../src/albums/actions.js";
import { ValidationError } from "../src/albums/add-manual.js";
import type { DraftedPrompt } from "../src/roadie/prompts.js";
import { makeAsset, fakeProber, jpegBytes } from "./helpers.js";

const store = () => new AssetStore(mkdtempSync(join(tmpdir(), "curator-vg-")));
const now = () => "2026-07-18T00:00:00.000Z";

const videoDraft = (n: number): DraftedPrompt => ({
  variants: Array.from({ length: n }, (_, i) => ({
    text: `video prompt ${i}`,
    nudge: `motion ${i}`,
  })),
  selectedIndex: 0,
  generator: "gemini",
  generatedAt: now(),
});

/** Seed an album with a palette, an n-variant video prompt, and its cover art on disk. */
function seed(s: AssetStore, id = "aaaa1111", variants = 5) {
  const asset = makeAsset(id, "Purple Rain", "Prince");
  asset.promptDrafts = { video: videoDraft(variants) };
  s.save(asset);
  mkdirSync(s.paths.artwork, { recursive: true });
  writeFileSync(s.paths.artworkFile(id), jpegBytes());
  return id;
}

// A GeminiClient with instant polling so video generation doesn't wait real seconds.
const geminiWith = (fetch: FetchLike) =>
  new GeminiClient({ apiKey: "k", fetch, sleep: async () => {} });
const deps = (
  s: AssetStore,
  gemini?: GeminiClient,
  prober: VideoProber = fakeProber(),
): ActionDeps => ({
  store: s,
  prober,
  gemini,
  generateVideo: true, // generation is opt-in; enable it for these tests
  now,
});

describe("generateVideoSet", () => {
  it("generates one clip per video variant, grounded on the cover", async () => {
    const s = store();
    const id = seed(s, "aaaa1111", 3);
    const fg = createFakeGemini({ videoBytes: "MP4" });
    const asset = await actions.generateVideoSet(
      deps(s, geminiWith(fg.fetch)),
      id,
    );

    expect(asset.videoClips).toHaveLength(3);
    expect(asset.videoClips!.map((c) => c.index)).toEqual([0, 1, 2]);
    expect(asset.videoClips![0]).toMatchObject({
      fileId: "aaaa1111-v0",
      nudge: "motion 0",
    });
    for (const c of asset.videoClips!)
      expect(existsSync(s.paths.visualizerFile(c.fileId))).toBe(true);
    // The cover image was sent to the Omni model on every interaction call.
    const interactions = fg.calls().filter((x) => x.video === "interaction");
    expect(interactions).toHaveLength(3);
    expect(interactions[0]!.body.input?.some((p) => p.type === "image")).toBe(
      true,
    );
  });

  it("keeps the successes when one clip's generation fails (partial failure)", async () => {
    const s = store();
    const id = seed(s, "bbbb2222", 3);
    const inner = createFakeGemini({ videoBytes: "MP4" });
    // Fail the 2nd clip's interaction; the other two complete.
    let interactions = 0;
    const fetch: FetchLike = async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path === "/v1beta/interactions" && ++interactions === 2)
        return new Response(JSON.stringify({ error: { code: 500 } }), {
          status: 500,
          headers: { "content-type": "application/json" },
        });
      return inner.fetch(input, init);
    };
    const asset = await actions.generateVideoSet(
      deps(s, geminiWith(fetch)),
      id,
    );
    expect(asset.videoClips).toHaveLength(2);
  });

  it("when every clip fails validation, throws a non-VideoError (maps to 5xx, not 422)", async () => {
    const s = store();
    const id = seed(s, "cccc3333", 2);
    const fg = createFakeGemini({ videoBytes: "MP4" });
    const throwing: VideoProber = {
      probe: async () => {
        throw new VideoError("not a real mp4");
      },
      thumbnail: async () => {},
    };
    await expect(
      actions.generateVideoSet(deps(s, geminiWith(fg.fetch), throwing), id),
    ).rejects.toSatisfy((e: Error) => e.name !== "VideoError");
    // A failed ingest must not leak its temp file in /incoming/.
    const leaked = existsSync(s.paths.incoming)
      ? readdirSync(s.paths.incoming).filter((f) => f.startsWith(".vidgen-"))
      : [];
    expect(leaked).toEqual([]);
  });

  it("400s when Gemini isn't configured", async () => {
    const s = store();
    const id = seed(s);
    await expect(
      actions.generateVideoSet(deps(s, undefined), id),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("400s when video generation is toggled off (opt-in)", async () => {
    const s = store();
    const id = seed(s);
    const fg = createFakeGemini({ videoBytes: "MP4" });
    await expect(
      actions.generateVideoSet(
        { store: s, prober: fakeProber(), gemini: geminiWith(fg.fetch), now },
        id,
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("400s when there's no cover art to animate", async () => {
    const s = store();
    const asset = makeAsset("dddd4444");
    asset.promptDrafts = { video: videoDraft(2) };
    s.save(asset); // no artwork file written
    const fg = createFakeGemini({ videoBytes: "MP4" });
    await expect(
      actions.generateVideoSet(deps(s, geminiWith(fg.fetch)), "dddd4444"),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("400s when there's no video prompt to generate from", async () => {
    const s = store();
    const asset = makeAsset("eeee5555");
    s.save(asset);
    mkdirSync(s.paths.artwork, { recursive: true });
    writeFileSync(s.paths.artworkFile("eeee5555"), jpegBytes());
    const fg = createFakeGemini({ videoBytes: "MP4" });
    await expect(
      actions.generateVideoSet(deps(s, geminiWith(fg.fetch)), "eeee5555"),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});
