import { describe, it, expect } from "vitest";
import { createFakeDiscogs, type FakeRelease } from "../src/index.js";

const release: FakeRelease = {
  id: 249504,
  title: "Purple Rain",
  artist: "Prince And The Revolution",
  year: 1984,
  genres: ["Funk / Soul", "Pop"],
  styles: ["Synth-pop", "Funk"],
  artwork: Buffer.from("JPEGDATA"),
};

const ua = { "User-Agent": "Marquee/test" };
const auth = (token = "fake-discogs-token") => ({
  ...ua,
  Authorization: `Discogs token=${token}`,
});

describe("fake-discogs", () => {
  it("rejects requests without a User-Agent (as Discogs does)", async () => {
    const fd = createFakeDiscogs([release]);
    const res = await fd.fetch("https://api.discogs.com/oauth/identity", {
      headers: { Authorization: "Discogs token=fake-discogs-token" },
    });
    expect(res.status).toBe(403);
  });

  it("rejects an unknown token with 401", async () => {
    const fd = createFakeDiscogs([release]);
    const res = await fd.fetch("https://api.discogs.com/oauth/identity", {
      headers: auth("wrong"),
    });
    expect(res.status).toBe(401);
  });

  it("serves the token owner's identity", async () => {
    const fd = createFakeDiscogs([], { username: "digger", userId: 42 });
    const res = await fd.fetch("https://api.discogs.com/oauth/identity", {
      headers: auth(),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: 42, username: "digger" });
  });

  it("paginates the collection", async () => {
    const many = Array.from({ length: 5 }, (_, i) => ({
      ...release,
      id: 1000 + i,
      title: `Album ${i}`,
    }));
    const fd = createFakeDiscogs(many, { username: "digger" });
    const url =
      "https://api.discogs.com/users/digger/collection/folders/0/releases?page=1&per_page=2";
    const res = await fd.fetch(url, { headers: auth() });
    const body = (await res.json()) as {
      pagination: { page: number; pages: number; items: number };
      releases: Array<{ id: number; basic_information: { id: number } }>;
    };
    expect(body.pagination).toMatchObject({ page: 1, pages: 3, items: 5 });
    expect(body.releases).toHaveLength(2);
    expect(body.releases[0]!.basic_information.id).toBe(1000);
    expect(fd.collectionRequests()).toBe(1);
  });

  it("404s a collection for a different username", async () => {
    const fd = createFakeDiscogs([release], { username: "digger" });
    const res = await fd.fetch(
      "https://api.discogs.com/users/someone-else/collection/folders/0/releases",
      { headers: auth() },
    );
    expect(res.status).toBe(404);
  });

  it("serves release detail with a primary image", async () => {
    const fd = createFakeDiscogs([release]);
    const res = await fd.fetch(
      `https://api.discogs.com/releases/${release.id}`,
      { headers: auth() },
    );
    const body = (await res.json()) as {
      images: Array<{ type: string; uri: string }>;
    };
    expect(body.images[0]).toMatchObject({ type: "primary" });
    expect(body.images[0]!.uri).toBe(fd.imageUrl(release.id));
  });

  it("serves the cover image bytes", async () => {
    const fd = createFakeDiscogs([release]);
    const res = await fd.fetch(fd.imageUrl(release.id), { headers: ua });
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer()).toString()).toBe("JPEGDATA");
  });
});
