// The whole-collection sweep (issue #234 / ADR 0051). Covers the three things the feature promises —
// it adds everything, a re-run adds only what's new, and it spends no LLM credits — plus the bounds
// that keep it from misbehaving on a large or unhealthy collection.
import { describe, it, expect, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakeDiscogs, type FakeRelease } from "@marquee/fake-discogs";
import { AssetStore } from "../src/store/asset-store.js";
import { DiscogsClient, DiscogsError } from "../src/discogs/client.js";
import {
  discogsSyncRunner,
  MAX_SYNC_PAGES,
  type DiscogsSyncReport,
} from "../src/albums/discogs-sync.js";
import {
  addDiscogsAlbum,
  buildDiscogsIndex,
} from "../src/albums/add-discogs.js";
import { fakeRoadie } from "./helpers.js";

const store = () =>
  new AssetStore(mkdtempSync(join(tmpdir(), "curator-sync-")));

const release = (id: number): FakeRelease => ({
  id,
  title: `Album ${id}`,
  artist: `Artist ${id}`,
  year: 1970 + (id % 30),
  genres: ["Funk / Soul"],
  styles: ["Disco"],
  artwork: Buffer.from(`IMG${id}`),
});

const client = (fd: ReturnType<typeof createFakeDiscogs>) =>
  new DiscogsClient({
    token: "fake-discogs-token",
    fetch: fd.fetch,
    minIntervalMs: 0, // the throttle has its own test; don't pay 1.1s per page here
  });

/** A runner over `count` releases, with everything injected. Returns the pieces the tests assert on. */
function harness(count: number, opts: { username?: string } = {}) {
  const username = opts.username ?? "digger";
  const releases = Array.from({ length: count }, (_, i) => release(1000 + i));
  const fd = createFakeDiscogs(releases, { username });
  const s = store();
  const discogs = client(fd);
  const roadie = fakeRoadie(s, { discogs });
  const run = (extra: Parameters<typeof discogsSyncRunner>[0] | null = null) =>
    discogsSyncRunner({
      store: s,
      roadie,
      discogs,
      resolveUsername: async () => username,
      sleep: async () => {},
      rand: () => 0,
      ...(extra ?? {}),
    });
  return { fd, store: s, discogs, roadie, releases, run };
}

const ctx = (signal = new AbortController().signal) => ({
  onProgress: vi.fn(),
  signal,
});

describe("discogsSyncRunner", () => {
  it("adds every record in the collection, across pages", async () => {
    // 250 releases at the 100-per-page ceiling is three pages — so this covers pagination, not just
    // "the first page worked".
    const h = harness(250);
    const c = ctx();

    const { discogsSync } = await h.run()(c);

    expect(discogsSync).toMatchObject({
      total: 250,
      scanned: 250,
      added: 250,
      duplicate: 0,
      failed: 0,
      pages: 3,
      truncated: false,
    });
    expect(h.store.list()).toHaveLength(250);
    expect(discogsSync.curatorIds).toHaveLength(250);
  });

  it("queues each added album with Roadie so art and colours get fetched", async () => {
    const h = harness(3);
    const enqueue = vi.spyOn(h.roadie, "enqueue");

    const { discogsSync } = await h.run()(ctx());

    expect(enqueue).toHaveBeenCalledTimes(3);
    // Every album lands in the pipeline's first real step, not parked.
    for (const asset of h.store.list())
      expect(asset.roadie.state).toBe("fetching_metadata");
    expect(discogsSync.added).toBe(3);
  });

  it("re-running adds only what's new — the refresh case", async () => {
    const h = harness(3);
    await h.run()(ctx());

    // Two more records show up on Discogs.
    h.fd.add(release(2001));
    h.fd.add(release(2002));

    const { discogsSync } = await h.run()(ctx());

    expect(discogsSync).toMatchObject({ added: 2, duplicate: 3, failed: 0 });
    expect(h.store.list()).toHaveLength(5);
  });

  it("adds nothing on a re-run of an unchanged collection", async () => {
    const h = harness(4);
    await h.run()(ctx());
    const { discogsSync } = await h.run()(ctx());

    expect(discogsSync).toMatchObject({ added: 0, duplicate: 4 });
    expect(h.store.list()).toHaveLength(4);
  });

  it("spends no LLM credits — a sweep never touches Gemini", async () => {
    // The load-bearing property of ADR 0051: putting a Gemini call back into a Roadie step would
    // make every sync cost money per record. A Gemini client that throws on any access proves the
    // sweep and the pipeline it feeds never reach for one.
    const forbidden = new Proxy(
      {},
      {
        get() {
          throw new Error("a collection sync must not call Gemini");
        },
      },
    );
    const h = harness(5);
    const roadie = fakeRoadie(h.store, {
      discogs: h.discogs,
      gemini: forbidden as never,
    });

    const { discogsSync } = await discogsSyncRunner({
      store: h.store,
      roadie,
      discogs: h.discogs,
      resolveUsername: async () => "digger",
    })(ctx());
    await roadie.drain();

    expect(discogsSync.added).toBe(5);
    // Roadie carried each album all the way to review without drafting anything.
    for (const asset of h.store.list()) {
      expect(asset.roadie.state).toBe("awaiting_review");
      expect(asset.promptDrafts).toBeUndefined();
    }
  });

  it("reports progress as rows are scanned", async () => {
    const h = harness(120);
    const c = ctx();

    await h.run()(c);

    const calls = c.onProgress.mock.calls;
    expect(calls.at(-1)).toEqual([120, 120]);
    // The total is known from the first page, not left at zero until the end.
    expect(calls[0]).toEqual([0, 120]);
  });

  it("stops when cancelled and reports what it managed", async () => {
    const h = harness(150);
    const ac = new AbortController();
    const c = { onProgress: vi.fn(), signal: ac.signal };
    // Abort partway through the first page.
    c.onProgress.mockImplementation((done: number) => {
      if (done >= 10) ac.abort();
    });

    const { discogsSync } = await h.run()(c);

    expect(discogsSync.truncated).toBe(true);
    expect(discogsSync.truncatedReason).toBe("cancelled");
    expect(discogsSync.scanned).toBeLessThan(150);
    // What was added is real and stays — a cancelled sweep is resumable, not rolled back.
    expect(h.store.list()).toHaveLength(discogsSync.added);
    expect(discogsSync.added).toBeGreaterThan(0);
  });

  it("a cancelled sweep is finished by the next run", async () => {
    const h = harness(30);
    const ac = new AbortController();
    const first = {
      onProgress: vi.fn((done: number) => {
        if (done >= 10) ac.abort();
      }),
      signal: ac.signal,
    };
    const partial = (await h.run()(first)).discogsSync;
    expect(partial.truncated).toBe(true);

    const { discogsSync } = await h.run()(ctx());

    expect(discogsSync.added).toBe(30 - partial.added);
    expect(h.store.list()).toHaveLength(30);
  });

  it("records a failed release without ending the sweep", async () => {
    const h = harness(3);
    // One row can't be saved; the other two must still land.
    const realSave = h.store.save.bind(h.store);
    let n = 0;
    vi.spyOn(h.store, "save").mockImplementation((asset) => {
      if (++n === 2) throw new Error("disk full");
      realSave(asset);
    });

    const { discogsSync } = await h.run()(ctx());

    expect(discogsSync).toMatchObject({ added: 2, failed: 1, scanned: 3 });
    expect(discogsSync.items.find((i) => i.status === "failed")?.error).toMatch(
      /disk full/,
    );
  });

  it("retries a failing page, then gives up with a partial report", async () => {
    const h = harness(150);
    const sleep = vi.fn(async () => {});
    let calls = 0;
    vi.spyOn(h.discogs, "getCollection").mockImplementation(async (u, o) => {
      calls++;
      // First page fine; every attempt at the second fails with a retryable error. A real
      // DiscogsError, not a look-alike: "is this worth retrying?" is decided by the class, so an
      // impostor would prove the opposite of what this test claims.
      if ((o?.page ?? 1) > 1) throw new DiscogsError("Discogs API 503", 503);
      return {
        items: h.releases.slice(0, 100).map((r) => ({
          releaseId: r.id,
          discogsUri: `discogs:release:${r.id}`,
          title: r.title,
          artist: r.artist,
          year: r.year,
          genres: r.genres,
        })),
        page: 1,
        pages: 2,
        perPage: 100,
        total: 150,
      };
    });

    const { discogsSync } = await discogsSyncRunner({
      store: h.store,
      roadie: h.roadie,
      discogs: h.discogs,
      resolveUsername: async () => "digger",
      sleep,
      rand: () => 0,
    })(ctx());

    expect(discogsSync.truncated).toBe(true);
    expect(discogsSync.truncatedReason).toBe("fetch_failed");
    // The first page's albums are added and queued despite the sweep ending early.
    expect(discogsSync.added).toBe(100);
    // 1 good page + 4 attempts at the bad one (initial + 3 retries), and it backed off between them.
    expect(calls).toBe(5);
    expect(sleep).toHaveBeenCalledTimes(3);
  });

  it("stops at the page cap rather than looping on a runaway paginator", async () => {
    const h = harness(1);
    // A paginator that always claims there is another page — the unbounded-loop hazard the cap exists
    // for (the working agreement's "loops on external state gets a cap").
    vi.spyOn(h.discogs, "getCollection").mockImplementation(async (_u, o) => ({
      items: [],
      page: o?.page ?? 1,
      pages: 999_999,
      perPage: 100,
      total: 99_999_999,
    }));

    const { discogsSync } = await h.run()(ctx());

    expect(discogsSync.pages).toBe(MAX_SYNC_PAGES);
    expect(discogsSync.truncated).toBe(true);
    expect(discogsSync.truncatedReason).toBe("page_cap");
  });

  it("dedupes a release listed twice in the same sweep", async () => {
    const h = harness(2);
    // The fake keys on release id, so ask the client for a page that repeats one.
    const dup = {
      releaseId: 1000,
      discogsUri: "discogs:release:1000",
      title: "Album 1000",
      artist: "Artist 1000",
      genres: [],
    };
    vi.spyOn(h.discogs, "getCollection").mockResolvedValue({
      items: [dup, dup],
      page: 1,
      pages: 1,
      perPage: 100,
      total: 2,
    });

    const { discogsSync } = await h.run()(ctx());

    expect(discogsSync).toMatchObject({ added: 1, duplicate: 1 });
    expect(h.store.list()).toHaveLength(1);
  });

  it("reads the store once per page, not once per row", async () => {
    // The O(n^2) guard (ADR 0051): the index is what keeps a 500-record sweep from being a
    // quarter-million file reads. Without it, `list()` is called once per candidate.
    const h = harness(40); // one page
    await h.run()(ctx()); // seed, so the dedupe path is exercised on the second run
    const list = vi.spyOn(h.store, "list");

    await h.run()(ctx());

    expect(list).toHaveBeenCalledTimes(1);
  });

  it("refreshes the index each page, so a mid-sweep manual add isn't duplicated", async () => {
    // The sweep runs for minutes and isn't the store's only writer: the per-row "Send to Roadie"
    // button dedupes against a fresh scan, not the sweep's map. A snapshot taken once at the start
    // would not know about it, and the sweep would add a second asset under the same discogsUri.
    const h = harness(250); // three pages
    const roadie = h.roadie;
    // Between pages, simulate the user adding one of the not-yet-reached records by hand.
    let injected = false;
    const realGet = h.discogs.getCollection.bind(h.discogs);
    vi.spyOn(h.discogs, "getCollection").mockImplementation(async (u, o) => {
      const page = await realGet(u, o);
      if (!injected && (o?.page ?? 1) === 2) {
        injected = true;
        // A release on page 3, added the manual way — no index, straight to the store.
        await addDiscogsAlbum(
          { store: h.store, roadie },
          { releaseId: 1240, title: "Album 1240", artist: "Artist 1240" },
        );
      }
      return page;
    });

    const { discogsSync } = await h.run()(ctx());

    // Every record is present exactly once, and the hand-added one is reported as already here.
    expect(h.store.list()).toHaveLength(250);
    const uris = h.store.list().map((a) => a.metadata.discogsUri);
    expect(new Set(uris).size).toBe(250);
    expect(discogsSync.items.find((i) => i.releaseId === 1240)?.status).toBe(
      "duplicate",
    );
  });

  it("resolves the collection owner through the injected resolver", async () => {
    const h = harness(2, { username: "crate_digger" });
    const resolveUsername = vi.fn(async () => "crate_digger");

    const { discogsSync } = await discogsSyncRunner({
      store: h.store,
      roadie: h.roadie,
      discogs: h.discogs,
      resolveUsername,
    })(ctx());

    expect(resolveUsername).toHaveBeenCalledTimes(1);
    expect(discogsSync.added).toBe(2);
  });
});

describe("buildDiscogsIndex", () => {
  it("finds albums already added, and picks up ones added after it was built", async () => {
    const h = harness(2);
    await h.run()(ctx());

    const index = buildDiscogsIndex(h.store);
    expect(index.get("discogs:release:1000")).toBeDefined();
    expect(index.get("discogs:release:9999")).toBeUndefined();

    index.add("discogs:release:9999", "abcd1234");
    expect(index.get("discogs:release:9999")).toBe("abcd1234");
  });

  it("ignores albums from other sources", () => {
    const s = store();
    // A manual album has no discogsUri; it must not end up in the index under `undefined`.
    const index = buildDiscogsIndex(s);
    expect(index.get("discogs:release:1")).toBeUndefined();
  });
});

/** Type-level guard: the report shape the UI reads is the one the runner returns. */
const _shape: DiscogsSyncReport = {
  total: 0,
  scanned: 0,
  added: 0,
  duplicate: 0,
  failed: 0,
  pages: 0,
  truncated: false,
  curatorIds: [],
  items: [],
};
void _shape;
