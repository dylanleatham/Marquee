// The workstation's staleness oracle.
//
// Curator has no unit, so none of the restart checks apply to it — and `localhost:4739` is usually
// the packaged Marquee.exe serving its own bundled copy, so a green `git checkout` and a green build
// can both be true while nothing about what is running has changed. The one exact signal available
// is the bundle name, because Vite renames it on every build and Curator enumerates `dist-ui` once
// at startup (the mechanism behind issue #183, used here as a check rather than suffered as a bug).
import { describe, it, expect, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildDesktopInstaller,
  curatorState,
  entryBundle,
  reportCurator,
  CuratorStaleError,
} from "../src/curator.js";
import { parseConfig, type Host } from "../src/hosts.js";
import { FakeExecutor, RecordingReporter } from "./fakes.js";

const [workstation] = parseConfig({
  hosts: {
    workstation: {
      repo: "C:/dev/Marquee",
      user: "dylan",
      services: { curator: { port: 4739 } },
    },
  },
}) as [Host];

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** A repo root whose built index.html names `bundle`, or no dist-ui at all when null. */
function repoWithBuild(bundle: string | null): string {
  const root = mkdtempSync(join(tmpdir(), "curator-deploy-"));
  dirs.push(root);
  if (bundle !== null) {
    const uiDir = join(root, "packages", "curator", "dist-ui");
    mkdirSync(uiDir, { recursive: true });
    writeFileSync(
      join(uiDir, "index.html"),
      `<!doctype html><html><head><script type="module" crossorigin src="${bundle}"></script></head><body><div id="root"></div></body></html>`,
    );
  }
  return root;
}

const serving = (html: string) =>
  new FakeExecutor([[/curl/, { stdout: html }]]);

describe("entryBundle", () => {
  it("finds the hashed entry bundle Vite writes", () => {
    expect(entryBundle('<script src="/assets/index-D4f9Xa2b.js">')).toBe(
      "/assets/index-D4f9Xa2b.js",
    );
  });

  it("ignores other hashed assets", () => {
    // Only the entry bundle is renamed in a way that identifies the build in `index.html`.
    expect(entryBundle('<link href="/assets/style-A1b2C3.css">')).toBeNull();
  });

  it("returns null for a page with no bundle at all", () => {
    // What the SPA fallback used to serve: index.html handed back for a missing asset request.
    expect(entryBundle("<html><body>nothing here</body></html>")).toBeNull();
  });
});

describe("curatorState", () => {
  it("reports fresh when the running server names the bundle that was just built", async () => {
    const root = repoWithBuild("/assets/index-NEW1234.js");
    const exec = serving('<script src="/assets/index-NEW1234.js"></script>');
    expect(await curatorState(workstation, root, 4739, exec)).toEqual({
      kind: "fresh",
      bundle: "/assets/index-NEW1234.js",
    });
  });

  it("reports stale when the running server is still on the previous bundle", async () => {
    const root = repoWithBuild("/assets/index-NEW1234.js");
    const exec = serving('<script src="/assets/index-OLD9999.js"></script>');
    expect(await curatorState(workstation, root, 4739, exec)).toEqual({
      kind: "stale",
      running: "/assets/index-OLD9999.js",
      built: "/assets/index-NEW1234.js",
    });
  });

  it("reports not-running when nothing answers", async () => {
    // A workstation with Curator closed is a perfectly fine end state — the next launch picks the
    // build up on its own — so this must not read as a failure.
    const root = repoWithBuild("/assets/index-NEW1234.js");
    const exec = new FakeExecutor([[/curl/, { code: 7 }]]);
    expect(await curatorState(workstation, root, 4739, exec)).toEqual({
      kind: "not-running",
    });
  });

  it("reports unknown rather than failing when there is no build to compare against", async () => {
    const exec = serving('<script src="/assets/index-OLD9999.js"></script>');
    const state = await curatorState(
      workstation,
      repoWithBuild(null),
      4739,
      exec,
    );
    expect(state.kind).toBe("unknown");
  });
});

describe("reportCurator", () => {
  it("fails the deploy when Curator is demonstrably serving the previous commit", async () => {
    // A hard failure on purpose: every other signal — git rev-parse, a green build, a 200 — looks
    // right, so this is the one an operator would otherwise shrug off.
    const root = repoWithBuild("/assets/index-NEW1234.js");
    const exec = serving('<script src="/assets/index-OLD9999.js"></script>');
    await expect(
      reportCurator(workstation, root, 4739, exec, new RecordingReporter()),
    ).rejects.toThrow(CuratorStaleError);
  });

  it("says both ways to restart, including that the packaged app bundles its own copy", async () => {
    const root = repoWithBuild("/assets/index-NEW1234.js");
    const exec = serving('<script src="/assets/index-OLD9999.js"></script>');
    const err = await reportCurator(
      workstation,
      root,
      4739,
      exec,
      new RecordingReporter(),
    ).catch((e: Error) => e);
    expect(err.message).toMatch(/Marquee\.exe/);
    expect(err.message).toMatch(/--desktop/);
    expect(err.message).toMatch(/pnpm curator/);
  });

  it("passes quietly when Curator is serving this build", async () => {
    const report = new RecordingReporter();
    const root = repoWithBuild("/assets/index-NEW1234.js");
    await reportCurator(
      workstation,
      root,
      4739,
      serving('<script src="/assets/index-NEW1234.js">'),
      report,
    );
    expect(report.warnings).toEqual([]);
    expect(report.oks.join("\n")).toMatch(/serving this build/);
  });

  it("passes when Curator isn't running, and says how to start it", async () => {
    const report = new RecordingReporter();
    const root = repoWithBuild("/assets/index-NEW1234.js");
    await reportCurator(
      workstation,
      root,
      4739,
      new FakeExecutor([[/curl/, { code: 7 }]]),
      report,
    );
    expect(report.oks.join("\n")).toMatch(/pnpm app/);
  });
});

describe("buildDesktopInstaller", () => {
  it("builds the installer and stops there, rather than running it", async () => {
    // Installing replaces the app the operator is currently using and puts an NSIS UI on screen.
    // That is their call; the deploy's job ends at the artifact.
    const report = new RecordingReporter();
    const exec = new FakeExecutor();
    await buildDesktopInstaller(workstation, exec, report);

    expect(exec.ran(/pnpm --filter @marquee\/desktop dist/)).toBe(true);
    expect(exec.ran(/release.*\.exe/)).toBe(false);
    expect(report.oks.join("\n")).toMatch(/packages\/desktop\/release/);
  });

  it("warns that the artifact is unsigned, because SmartScreen will", async () => {
    const report = new RecordingReporter();
    await buildDesktopInstaller(workstation, new FakeExecutor(), report);
    expect(report.oks.join("\n")).toMatch(/unsigned|SmartScreen/);
  });

  it("bounds the build, long as it is", async () => {
    // electron-builder plus two esbuild bundles plus native deps is the slowest step in the system;
    // it still must not be able to park a deploy forever.
    let timeout = 0;
    const exec = new FakeExecutor();
    const spy = { ...exec, exec: exec.exec.bind(exec) };
    await buildDesktopInstaller(
      workstation,
      {
        exec: async (host, cmd) => {
          timeout = cmd.timeoutMs;
          return spy.exec(host, cmd);
        },
      },
      new RecordingReporter(),
    );
    expect(timeout).toBeGreaterThan(0);
    expect(Number.isFinite(timeout)).toBe(true);
  });
});
