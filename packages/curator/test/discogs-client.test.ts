import { describe, it, expect } from "vitest";
import { createFakeDiscogs, type FakeRelease } from "@marquee/fake-discogs";
import { DiscogsClient, discogsUri } from "../src/discogs/client.js";

const release: FakeRelease = {
  id: 249504,
  title: "Purple Rain",
  artist: "Prince And The Revolution",
  year: 1984,
  genres: ["Funk / Soul"],
  styles: ["Synth-pop"],
  artwork: Buffer.from("IMG"),
};

const client = (fd = createFakeDiscogs([release])) =>
  new DiscogsClient({ token: "fake-discogs-token", fetch: fd.fetch });

describe("DiscogsClient", () => {
  it("getIdentity resolves the token owner", async () => {
    const fd = createFakeDiscogs([], { username: "digger", userId: 7 });
    const id = await client(fd).getIdentity();
    expect(id).toEqual({ id: 7, username: "digger" });
  });

  it("getCollection normalizes items + merges genres and styles", async () => {
    const fd = createFakeDiscogs([release], { username: "digger" });
    const page = await client(fd).getCollection("digger");
    expect(page).toMatchObject({ page: 1, pages: 1, total: 1 });
    expect(page.items[0]).toMatchObject({
      releaseId: 249504,
      discogsUri: "discogs:release:249504",
      title: "Purple Rain",
      artist: "Prince And The Revolution",
      year: 1984,
      genres: ["Funk / Soul", "Synth-pop"],
    });
    expect(page.items[0]!.coverImage).toBe(fd.imageUrl(release.id));
  });

  it("getCollection caps per_page at 100 and passes pagination through", async () => {
    const many = Array.from({ length: 3 }, (_, i) => ({
      ...release,
      id: 1 + i,
    }));
    const fd = createFakeDiscogs(many, { username: "digger" });
    const page = await client(fd).getCollection("digger", {
      page: 2,
      perPage: 1,
    });
    expect(page).toMatchObject({ page: 2, pages: 3, total: 3, perPage: 1 });
    expect(page.items).toHaveLength(1);
  });

  it("getRelease returns metadata + the primary image URL", async () => {
    const meta = await client().getRelease(release.id);
    expect(meta).toMatchObject({
      releaseId: 249504,
      discogsUri: discogsUri(249504),
      title: "Purple Rain",
      artist: "Prince And The Revolution",
      year: 1984,
    });
    expect(meta.artUrl).toBeDefined();
  });

  it("downloadArt returns the cover bytes", async () => {
    const fd = createFakeDiscogs([release]);
    const art = await client(fd).downloadArt(fd.imageUrl(release.id));
    expect(art.toString()).toBe("IMG");
  });

  it("maps a missing release to a 404 DiscogsError", async () => {
    await expect(client().getRelease(999999)).rejects.toMatchObject({
      name: "DiscogsError",
      status: 404,
    });
  });

  it("rejects a wrong token with a 401 DiscogsError", async () => {
    const fd = createFakeDiscogs([release]);
    const bad = new DiscogsClient({ token: "nope", fetch: fd.fetch });
    await expect(bad.getRelease(release.id)).rejects.toMatchObject({
      name: "DiscogsError",
      status: 401,
    });
  });
});
