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

// minIntervalMs: 0 — the rate-budget throttle has its own test below; every other case here would
// otherwise pay 1.1s per API call for nothing.
const client = (fd = createFakeDiscogs([release])) =>
  new DiscogsClient({
    token: "fake-discogs-token",
    fetch: fd.fetch,
    minIntervalMs: 0,
  });

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
    const bad = new DiscogsClient({
      token: "nope",
      fetch: fd.fetch,
      minIntervalMs: 0,
    });
    await expect(bad.getRelease(release.id)).rejects.toMatchObject({
      name: "DiscogsError",
      status: 401,
    });
  });

  // The rate budget (issue #234 / ADR 0051). Discogs allows 60 authenticated requests a minute; a
  // collection sweep plus Roadie's per-release fetches blow through that unthrottled, and the 429s
  // arrive as Roadie retries that albums exhaust before parking in `errored`. Clock and sleep are
  // injected, so this asserts the spacing without spending it.
  describe("API rate throttle", () => {
    /** A client over a fake clock: `sleep` advances time, so waits are observable and instant. */
    const throttled = (minIntervalMs = 1100) => {
      const fd = createFakeDiscogs([release], { username: "digger" });
      let now = 0;
      const slept: number[] = [];
      const c = new DiscogsClient({
        token: "fake-discogs-token",
        fetch: fd.fetch,
        minIntervalMs,
        now: () => now,
        sleep: async (ms) => {
          slept.push(ms);
          now += ms;
        },
      });
      return { client: c, slept, advance: (ms: number) => (now += ms) };
    };

    it("spaces consecutive API calls by the minimum interval", async () => {
      const t = throttled();
      await t.client.getIdentity();
      await t.client.getIdentity();
      await t.client.getIdentity();

      // The first goes straight out; each of the next two waits a full interval.
      expect(t.slept).toEqual([1100, 1100]);
    });

    it("charges nothing when the caller was already slow enough", async () => {
      const t = throttled();
      await t.client.getIdentity();
      t.advance(5000); // a slow caller, or an idle gap
      await t.client.getIdentity();

      expect(t.slept).toEqual([]);
    });

    it("spaces concurrent callers too — Roadie and a sweep share one budget", async () => {
      const t = throttled();
      await Promise.all([
        t.client.getIdentity(),
        t.client.getIdentity(),
        t.client.getIdentity(),
      ]);

      // Queued rather than fired at once: three simultaneous calls still leave one interval apart.
      expect(t.slept).toEqual([1100, 1100]);
    });

    it("leaves cover downloads out of the budget", async () => {
      // The image host isn't part of the API rate limit, and queueing art behind it would add an
      // hour to a large sync for nothing.
      const t = throttled();
      await t.client.downloadArt("https://i.discogs.com/image/249504.jpg");
      await t.client.downloadArt("https://i.discogs.com/image/249504.jpg");

      expect(t.slept).toEqual([]);
    });

    it("can be turned off", async () => {
      const t = throttled(0);
      await t.client.getIdentity();
      await t.client.getIdentity();

      expect(t.slept).toEqual([]);
    });

    it("a failed wait fails that call without wedging the queue", async () => {
      // If the gate were never handed on, every later Discogs call would hang for the life of the
      // process — a far worse failure than the one request that broke.
      const fd = createFakeDiscogs([release], { username: "digger" });
      let fail = true;
      const c = new DiscogsClient({
        token: "fake-discogs-token",
        fetch: fd.fetch,
        minIntervalMs: 1100,
        now: () => 0, // never advances, so every call after the first must wait
        sleep: async () => {
          if (fail) throw new Error("timer exploded");
        },
      });

      await c.getIdentity(); // first call takes no wait
      await expect(c.getIdentity()).rejects.toThrow(/timer exploded/);
      fail = false;
      await expect(c.getIdentity()).resolves.toMatchObject({
        username: "digger",
      });
    });
  });
});
