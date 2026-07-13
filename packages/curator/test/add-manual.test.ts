import { describe, it, expect } from "vitest";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { AssetStore } from "../src/store/asset-store.js";
import { addManualAlbum, ValidationError } from "../src/albums/add-manual.js";
import { fakeGenerate, fakePayload, fakeRoadie } from "./helpers.js";

const store = () => new AssetStore(mkdtempSync(join(tmpdir(), "curator-add-")));
const hexToRgb = (hex: string): [number, number, number] => {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
};

describe("addManualAlbum", () => {
  it("saves art + a fresh asset up front, then Roadie fills palette + prompts", async () => {
    const s = store();
    const roadie = fakeRoadie(s);
    const { curatorId, asset } = await addManualAlbum(
      { store: s, roadie },
      {
        name: "Purple Rain",
        artist: "Prince",
        year: 1984,
        genres: ["funk", "rock"],
        artwork: Buffer.from("img"),
      },
    );

    // The response returns as soon as the album is queued — art on disk, palette not yet.
    expect(curatorId).toMatch(/^[a-z0-9]{8}$/);
    expect(existsSync(s.paths.artworkFile(curatorId))).toBe(true);
    expect(asset.roadie.state).toBe("generating_palette");
    expect(asset.palette).toBeUndefined();

    await roadie.drain();

    const done = s.read(curatorId)!;
    expect(done.metadata).toMatchObject({
      name: "Purple Rain",
      artist: "Prince",
      year: 1984,
      source: "manual",
    });
    expect(done.metadata.genres).toEqual(["funk", "rock"]);
    expect(done.palette!.colors[0]!.hex).toBe("#4B0082");
    expect(done.pattern!.type).toBe("crossfade");
    expect(done.promptDrafts!.video!.text).toContain("Purple Rain");
    expect(done.promptDrafts!.cardArt!.template).toBe("iconic_emblem");
    expect(done.roadie.state).toBe("awaiting_review");
    expect(done.artwork!.resolvedPath).toBe(`media/artwork/${curatorId}.jpg`);
    expect(done.artwork!.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("validates name, artist, and artwork before queueing", async () => {
    const s = store();
    const roadie = fakeRoadie(s);
    await expect(
      addManualAlbum(
        { store: s, roadie },
        { name: "", artist: "A", artwork: Buffer.from("x") },
      ),
    ).rejects.toThrow(ValidationError);
    await expect(
      addManualAlbum(
        { store: s, roadie },
        { name: "N", artist: "A", artwork: Buffer.alloc(0) },
      ),
    ).rejects.toThrow(/artwork/);
  });

  it("parks a monochrome album at awaiting_review with the palette_insufficient flag", async () => {
    const s = store();
    const insufficient = async () => ({
      ...fakePayload(),
      palette: {
        colors: [],
        insufficient: true as const,
        reason: "monochrome" as const,
      },
    });
    const roadie = fakeRoadie(s, { generate: insufficient });
    const { curatorId } = await addManualAlbum(
      { store: s, roadie },
      { name: "Metallica", artist: "Metallica", artwork: Buffer.from("x") },
    );
    await roadie.drain();

    const asset = s.read(curatorId)!;
    expect(asset.roadie.state).toBe("awaiting_review");
    expect(asset.roadie.flags.palette_insufficient).toBe(true);
    expect(asset.palette!.insufficient).toBe(true);
    expect(asset.palette!.reason).toBe("monochrome");
    // Insufficient palette short-circuits before prompt drafting — the human decides first.
    expect(asset.promptDrafts).toBeUndefined();
  });

  it("[integration] real Palette Press on a fixture cover → purple-led palette saved", async () => {
    const s = store();
    const here = dirname(fileURLToPath(import.meta.url));
    const art = readFileSync(
      join(here, "..", "..", "..", "fixtures", "artwork", "purple-rain.jpg"),
    );
    // No generate override → Roadie runs the real library.
    const roadie = fakeRoadie(s, { generate: undefined });

    const { curatorId } = await addManualAlbum(
      { store: s, roadie },
      { name: "Purple Rain", artist: "Prince", year: 1984, artwork: art },
    );
    await roadie.drain();

    const asset = s.read(curatorId)!;
    expect(asset.roadie.state).toBe("awaiting_review");
    expect(asset.palette!.colors.length).toBeGreaterThanOrEqual(2);
    expect(asset.roadie.flags.palette_insufficient).toBe(false);
    const [r, g, b] = hexToRgb(asset.palette!.colors[0]!.hex);
    expect(b).toBeGreaterThan(g); // purple-led: more blue than green
    expect(r).toBeGreaterThan(0);
  });
});
