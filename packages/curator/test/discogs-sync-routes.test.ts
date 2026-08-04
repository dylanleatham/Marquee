// The collection-sync routes and their poller wiring (issue #234 / ADR 0051). The sweep itself is
// unit-tested in discogs-sync.test.ts; here we cover the route contract, the job hand-off, the
// not-configured path, and the settings toggle taking effect without a restart.
import { describe, it, expect, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakeDiscogs, type FakeRelease } from "@marquee/fake-discogs";
import { AssetStore } from "../src/store/asset-store.js";
import { DiscogsClient } from "../src/discogs/client.js";
import { DiscogsPoller } from "../src/discogs/poller.js";
import { buildServer } from "../src/server.js";
import { fakeRoadie, fakeProber } from "./helpers.js";

const release = (id: number): FakeRelease => ({
  id,
  title: `Album ${id}`,
  artist: `Artist ${id}`,
  year: 1975,
  genres: ["Soul"],
  artwork: Buffer.from(`IMG${id}`),
});

/** A server with Discogs wired to the fake, and a poller whose timer never really fires. */
function build(opts: { count?: number; withDiscogs?: boolean } = {}) {
  const { count = 3, withDiscogs = true } = opts;
  const dir = mkdtempSync(join(tmpdir(), "curator-syncroutes-"));
  const store = new AssetStore(dir);
  const fd = createFakeDiscogs(
    Array.from({ length: count }, (_, i) => release(500 + i)),
    { username: "digger" },
  );
  const discogs = withDiscogs
    ? new DiscogsClient({
        token: "fake-discogs-token",
        fetch: fd.fetch,
        minIntervalMs: 0,
      })
    : undefined;
  const scheduled: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
  const poller = new DiscogsPoller({
    trigger: () => undefined,
    enabled: false,
    timers: {
      set: (fn, ms) => {
        scheduled.push({ fn, ms, cleared: false });
        return scheduled.length - 1;
      },
      clear: (handle) => {
        const entry = scheduled[handle as number];
        if (entry) entry.cleared = true;
      },
    },
  });
  const { app } = buildServer({
    store,
    roadie: fakeRoadie(store, discogs ? { discogs } : {}),
    prober: fakeProber(),
    discogsPoller: poller,
    ...(discogs ? { discogs } : {}),
  });
  return { app, store, fd, discogs, poller, scheduled, dir };
}

/** Poll the job until it leaves `running` (the sweep is local + fake, so this is a few ticks). */
async function settle(
  app: ReturnType<typeof build>["app"],
  jobId: string,
): Promise<Record<string, unknown>> {
  for (let i = 0; i < 200; i++) {
    const res = await app.inject({ url: `/api/jobs/${jobId}` });
    const job = res.json();
    if (job.status !== "running") return job;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("sync job never finished");
}

describe("POST /api/discogs/sync", () => {
  it("returns 202 + a library-scoped job, and adds the collection", async () => {
    const { app, store } = build({ count: 3 });

    const res = await app.inject({ method: "POST", url: "/api/discogs/sync" });

    expect(res.statusCode).toBe(202);
    const job = res.json();
    expect(job).toMatchObject({ kind: "discogsSync", status: "running" });
    // Library-scoped: a collection sweep belongs to no one album.
    expect(job.curatorId).toBeUndefined();

    const done = await settle(app, job.id);
    expect(done.status).toBe("done");
    expect(
      (done.result as { discogsSync: { added: number } }).discogsSync,
    ).toMatchObject({ added: 3, duplicate: 0, failed: 0 });
    expect(store.list()).toHaveLength(3);

    await app.close();
  });

  it("a second press reattaches instead of sweeping twice", async () => {
    const { app, discogs } = build({ count: 3 });
    // Hold the first sweep open on its first page: against a fake collection it would otherwise
    // finish before the second press lands, and the test would prove nothing.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const real = discogs!.getCollection.bind(discogs);
    vi.spyOn(discogs!, "getCollection").mockImplementation(async (u, o) => {
      await gate;
      return real(u, o);
    });

    const first = (
      await app.inject({ method: "POST", url: "/api/discogs/sync" })
    ).json();
    const second = (
      await app.inject({ method: "POST", url: "/api/discogs/sync" })
    ).json();

    expect(second.id).toBe(first.id);
    expect(second.status).toBe("running");

    release();
    const done = await settle(app, first.id);
    // One sweep ran, not two: three records added once, no duplicates from a second walk.
    expect(
      (done.result as { discogsSync: { added: number } }).discogsSync,
    ).toMatchObject({ added: 3, duplicate: 0 });
    await app.close();
  });

  it("re-running after the collection grows adds only the new record", async () => {
    const { app, fd, store } = build({ count: 2 });

    const first = (
      await app.inject({ method: "POST", url: "/api/discogs/sync" })
    ).json();
    await settle(app, first.id);

    fd.add(release(900));

    const second = (
      await app.inject({ method: "POST", url: "/api/discogs/sync" })
    ).json();
    const done = await settle(app, second.id);

    expect(
      (done.result as { discogsSync: { added: number; duplicate: number } })
        .discogsSync,
    ).toMatchObject({ added: 1, duplicate: 2 });
    expect(store.list()).toHaveLength(3);

    await app.close();
  });

  it("503s when Discogs isn't configured", async () => {
    const { app } = build({ withDiscogs: false });

    const res = await app.inject({ method: "POST", url: "/api/discogs/sync" });

    expect(res.statusCode).toBe(503);
    expect(res.json().error).toMatch(/not configured/i);
    await app.close();
  });

  it("is reachable through GET /api/jobs?kind=discogsSync after a reload", async () => {
    const { app } = build({ count: 2 });
    const job = (
      await app.inject({ method: "POST", url: "/api/discogs/sync" })
    ).json();

    const listed = await app.inject({ url: "/api/jobs?kind=discogsSync" });

    expect(listed.statusCode).toBe(200);
    expect(listed.json().jobs.map((j: { id: string }) => j.id)).toContain(
      job.id,
    );
    await settle(app, job.id);
    await app.close();
  });
});

describe("auto-sync settings", () => {
  it("reports the poller's live state", async () => {
    const { app } = build();

    const res = await app.inject({ url: "/api/discogs/sync/status" });

    expect(res.json()).toMatchObject({
      enabled: false,
      lastRunAt: null,
      lastJobId: null,
    });
    await app.close();
  });

  it("turning auto-sync on takes effect immediately, no restart", async () => {
    const { app, poller, scheduled } = build();

    const res = await app.inject({
      method: "PUT",
      url: "/api/settings/discogs",
      payload: { autoSync: true, autoSyncIntervalMinutes: 30 },
    });

    expect(res.statusCode).toBe(200);
    // A toggle that meant "and now restart Curator" would be a broken toggle.
    expect(res.json().restartRequired).toBe(false);
    expect(poller.enabled).toBe(true);
    expect(scheduled.at(-1)!.ms).toBe(30 * 60_000);

    const status = await app.inject({ url: "/api/discogs/sync/status" });
    expect(status.json()).toMatchObject({
      enabled: true,
      intervalMs: 30 * 60_000,
    });
    await app.close();
  });

  it("still asks for a restart when credentials change", async () => {
    const { app } = build();

    const res = await app.inject({
      method: "PUT",
      url: "/api/settings/discogs",
      payload: { token: "new-token" },
    });

    expect(res.json().restartRequired).toBe(true);
    await app.close();
  });

  it("rejects a nonsense interval", async () => {
    const { app } = build();

    const res = await app.inject({
      method: "PUT",
      url: "/api/settings/discogs",
      payload: { autoSync: true, autoSyncIntervalMinutes: -5 },
    });

    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("surfaces the clamped interval, not the one that was asked for", async () => {
    const { app } = build();

    await app.inject({
      method: "PUT",
      url: "/api/settings/discogs",
      payload: { autoSync: true, autoSyncIntervalMinutes: 1 },
    });

    const settings = await app.inject({ url: "/api/settings/discogs" });
    // The floor is 5 minutes; the screen must show what the poller actually does.
    expect(settings.json()).toMatchObject({
      autoSync: true,
      autoSyncIntervalMinutes: 5,
    });
    await app.close();
  });

  it("won't enable polling when Discogs isn't configured", async () => {
    const { app, poller } = build({ withDiscogs: false });

    await app.inject({
      method: "PUT",
      url: "/api/settings/discogs",
      payload: { autoSync: true },
    });

    expect(poller.enabled).toBe(false);
    await app.close();
  });

  it("stops the poller when the server closes", async () => {
    // Otherwise a test server — or a closed desktop window — leaves a timer running.
    const { app, poller, scheduled } = build();
    await app.inject({
      method: "PUT",
      url: "/api/settings/discogs",
      payload: { autoSync: true },
    });
    expect(poller.enabled).toBe(true);
    const live = scheduled.at(-1)!;
    expect(live.cleared).toBe(false);

    await app.close();

    expect(live.cleared).toBe(true);
  });
});
