import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AssetStore } from "../src/store/asset-store.js";
import { buildServer } from "../src/server.js";
import { fakeRoadie, fakeProber } from "./helpers.js";
import { GenerationJobs } from "../src/jobs/manager.js";

// Issue #57: POST /api/jobs/:id/cancel aborts an in-flight generation and marks it cancelled. The
// cancel logic itself is unit-tested on GenerationJobs; here we cover the route wiring + 404 path.
describe("POST /api/jobs/:id/cancel", () => {
  const build = () => {
    const store = new AssetStore(
      mkdtempSync(join(tmpdir(), "curator-cancel-")),
    );
    const jobs = new GenerationJobs();
    const { app } = buildServer({
      store,
      roadie: fakeRoadie(store),
      prober: fakeProber(),
      jobs,
    });
    return { app, jobs };
  };

  it("cancels a running job and reports it cancelled", async () => {
    const { app, jobs } = build();
    // A runner that only ends when aborted, so the job is still running when we cancel it.
    const job = jobs.start(
      "video",
      "abcd1234",
      ({ signal }) =>
        new Promise<never>((_resolve, reject) =>
          signal.addEventListener("abort", () => reject(new Error("aborted"))),
        ),
    );
    const res = await app.inject({
      method: "POST",
      url: `/api/jobs/${job.id}/cancel`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("cancelled");
  });

  it("404s an unknown job id", async () => {
    const { app } = build();
    const res = await app.inject({
      method: "POST",
      url: "/api/jobs/does-not-exist/cancel",
    });
    expect(res.statusCode).toBe(404);
  });
});
