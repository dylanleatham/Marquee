// On-demand prompt drafting (ADR 0027). Drafting left Roadie's pipeline because it spent two Gemini
// calls per album unconditionally — including on albums whose video and card art the user already
// had. These cover the replacement action + route: it prefers the grounded LLM path, silently falls
// back to templates (so it "cannot fail" the way the pipeline step couldn't), and is per-type.
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AssetStore } from "../src/store/asset-store.js";
import { buildServer } from "../src/server.js";
import { buildFreshAsset } from "../src/albums/asset.js";
import { GeminiClient } from "../src/gemini/client.js";
import { createFakeGemini } from "@marquee/fake-gemini";
import { draftPrompt } from "../src/albums/actions.js";
import { fakeRoadie, fakeProber, makeAsset } from "./helpers.js";

const store = () =>
  new AssetStore(mkdtempSync(join(tmpdir(), "curator-draft-")));

const deps = (s: AssetStore, gemini?: GeminiClient) => ({
  store: s,
  prober: fakeProber(),
  ...(gemini ? { gemini } : {}),
  now: () => "2026-07-25T00:00:00.000Z",
});

const geminiWith = (variants: number) => {
  const fg = createFakeGemini({
    research: "cover facts",
    json: {
      variants: Array.from({ length: variants }, (_, i) => ({
        text: `Variant ${i} grounded in the cover art`,
        nudge: `angle ${i}`,
      })),
    },
  });
  return { fg, client: new GeminiClient({ apiKey: "k", fetch: fg.fetch }) };
};

describe("draftPrompt action", () => {
  it("drafts a grounded LLM variant set when Gemini is configured", async () => {
    const s = store();
    s.save(makeAsset("draft001"));
    const { fg, client } = geminiWith(5);

    const asset = await draftPrompt(deps(s, client), "draft001", "video");

    expect(asset.promptDrafts!.video!.generator).toBe("gemini");
    expect(asset.promptDrafts!.video!.variants).toHaveLength(5);
    expect(fg.calls().length).toBeGreaterThan(0);
  });

  // The whole point of ADR 0027 is not paying for prompts you won't read: asking for the video
  // prompt must not also draft (and bill for) the card-art one.
  it("drafts only the requested type, leaving the other undrafted", async () => {
    const s = store();
    s.save(makeAsset("draft002"));
    const { client } = geminiWith(5);

    const asset = await draftPrompt(deps(s, client), "draft002", "video");

    expect(asset.promptDrafts!.video).toBeDefined();
    expect(asset.promptDrafts!.cardArt).toBeUndefined();
  });

  it("falls back to templates when Gemini fails — drafting cannot fail", async () => {
    const s = store();
    s.save(makeAsset("draft003"));
    const fg = createFakeGemini({ failStatus: 500 });
    const client = new GeminiClient({ apiKey: "k", fetch: fg.fetch });

    const asset = await draftPrompt(deps(s, client), "draft003", "cardArt");

    expect(asset.promptDrafts!.cardArt!.generator).toBe("template");
  });

  it("falls back to templates when no Gemini key is configured at all", async () => {
    const s = store();
    s.save(makeAsset("draft004"));

    const asset = await draftPrompt(deps(s), "draft004", "video");

    expect(asset.promptDrafts!.video!.generator).toBe("template");
  });

  it("rejects an album with no palette to draft from", async () => {
    const s = store();
    s.save(
      buildFreshAsset({
        curatorId: "draft005",
        metadata: { name: "X", artist: "Y", source: "manual" },
        now: () => "2026-07-25T00:00:00.000Z",
      }),
    );

    await expect(draftPrompt(deps(s), "draft005", "video")).rejects.toThrow(
      /palette isn't generated yet/,
    );
  });

  it("rejects an unknown prompt type", async () => {
    const s = store();
    s.save(makeAsset("draft006"));

    await expect(
      draftPrompt(deps(s), "draft006", "sleeveNotes" as never),
    ).rejects.toThrow(/unknown prompt type/);
  });
});

describe("POST /api/albums/:curatorId/prompts/:type/draft", () => {
  const curator = (s: AssetStore, gemini?: GeminiClient) =>
    buildServer({
      store: s,
      roadie: fakeRoadie(s),
      prober: fakeProber(),
      ...(gemini ? { gemini } : {}),
    }).app;

  it("returns the drafted prompts for the requested type", async () => {
    const s = store();
    s.save(makeAsset("route001"));

    const res = await curator(s).inject({
      method: "POST",
      url: "/api/albums/route001/prompts/video/draft",
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().promptDrafts.video.variants.length).toBeGreaterThan(0);
    expect(s.read("route001")!.promptDrafts!.video).toBeDefined();
  });

  it("404s for an unknown album", async () => {
    const s = store();
    const res = await curator(s).inject({
      method: "POST",
      url: "/api/albums/missing0/prompts/video/draft",
    });
    expect(res.statusCode).toBe(404);
  });

  it("400s when the album has no palette yet", async () => {
    const s = store();
    s.save(
      buildFreshAsset({
        curatorId: "route002",
        metadata: { name: "X", artist: "Y", source: "manual" },
        now: () => "2026-07-25T00:00:00.000Z",
      }),
    );
    const res = await curator(s).inject({
      method: "POST",
      url: "/api/albums/route002/prompts/video/draft",
    });
    expect(res.statusCode).toBe(400);
  });

  it("is idempotent — drafting twice replaces rather than duplicates", async () => {
    const s = store();
    s.save(makeAsset("route003"));
    const app = curator(s);

    await app.inject({
      method: "POST",
      url: "/api/albums/route003/prompts/video/draft",
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/albums/route003/prompts/video/draft",
    });

    expect(res.statusCode).toBe(200);
    expect(Object.keys(s.read("route003")!.promptDrafts!)).toEqual(["video"]);
  });
});
