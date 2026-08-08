// What the System screen says (ADR 0052). The matrix is gone; these are the derivations that
// replaced it, and the important one is what "everywhere it should be" means.
import { describe, it, expect } from "vitest";
import type { AlbumPresence, JobTransfer, ServiceHealth } from "./api";
import {
  exceptions,
  JOB_LABEL,
  jobProgress,
  presenceProblem,
  serviceLine,
  servicePort,
  serviceState,
  transferLine,
  transferPercent,
  SERVICE_GLOSS,
} from "./system";

const svc = (over: Partial<ServiceHealth>): ServiceHealth => ({
  service: "conductor",
  configured: true,
  reachable: true,
  url: "http://localhost:4741",
  ...over,
});

const presence = (over: Partial<AlbumPresence>): AlbumPresence => ({
  curatorId: "abc12345",
  name: "Purple Rain",
  artist: "Prince",
  hasVideo: false,
  onConductor: true,
  inBackdropLibrary: false,
  videoOnBackdrop: false,
  ...over,
});

describe("services", () => {
  it("says what each one is for, not just what it is called", () => {
    // "Backdrop" tells you nothing about which part of the room stops working.
    expect(Object.values(SERVICE_GLOSS)).toEqual([
      "the lights",
      "the screen",
      "the stand",
      "the sound",
    ]);
  });

  it("keeps 'never set up' and 'down' apart — they have different fixes", () => {
    expect(serviceState(svc({ configured: false, reachable: false }))).toBe(
      "unset",
    );
    expect(serviceState(svc({ reachable: false }))).toBe("down");
    expect(serviceState(svc({}))).toBe("up");
    expect(serviceLine(svc({ configured: false }))).toBe(
      "the lights — not set up",
    );
    expect(serviceLine(svc({ reachable: false }))).toBe(
      "the lights — not answering",
    );
    expect(serviceLine(svc({}))).toBe("the lights");
  });

  it("shows the port, since the host is nearly always the same machine", () => {
    expect(servicePort("http://localhost:4741")).toBe(":4741");
    expect(servicePort("http://stylus.local")).toBe("stylus.local");
    expect(servicePort(undefined)).toBe("");
    expect(servicePort("not a url")).toBe("not a url");
  });
});

describe("presenceProblem", () => {
  it("expects a record with no visualizer on Conductor and nowhere else", () => {
    // Requiring Backdrop too would put every record that simply hasn't had a clip made yet on the
    // list, and drown the real failures — which is what the old per-row "Ready" did.
    expect(presenceProblem(presence({ hasVideo: false }))).toBeNull();
  });

  it("flags a record that never reached Conductor, whatever else is true", () => {
    expect(presenceProblem(presence({ onConductor: false }))).toBe(
      "NOT ON CONDUCTOR",
    );
  });

  it("expects all three once there is a visualizer", () => {
    expect(
      presenceProblem(presence({ hasVideo: true, inBackdropLibrary: false })),
    ).toBe("NOT IN BACKDROP'S LIBRARY");
    expect(
      presenceProblem(
        presence({
          hasVideo: true,
          inBackdropLibrary: true,
          videoOnBackdrop: false,
        }),
      ),
    ).toBe("NO VISUALIZER ON BACKDROP");
    expect(
      presenceProblem(
        presence({
          hasVideo: true,
          inBackdropLibrary: true,
          videoOnBackdrop: true,
        }),
      ),
    ).toBeNull();
  });
});

describe("exceptions", () => {
  it("lists only what is wrong, so an empty list is the good news", () => {
    const albums = [
      presence({ curatorId: "fine" }),
      presence({ curatorId: "bad", onConductor: false }),
    ];
    expect(exceptions(albums).map((e) => e.album.curatorId)).toEqual(["bad"]);
    expect(exceptions([presence({})])).toEqual([]);
  });
});

describe("jobProgress", () => {
  it("counts items, except for a byte transfer which reads as a percentage", () => {
    expect(jobProgress("runtimeSync", 3, 13)).toBe("3/13");
    expect(jobProgress("mediaTransfer", 68, 100)).toBe("68%");
  });

  it("says nothing rather than dividing by zero", () => {
    expect(jobProgress("runtimeSync", 0, 0)).toBe("…");
  });

  it("names what a job is doing rather than its kind", () => {
    expect(JOB_LABEL.mediaTransfer).toBe("visualizer upload");
    expect(JOB_LABEL.runtimeSync).toBe("media-sync");
  });
});

// The upload line (issue #274). A sync's job row counts album-legs, which advances once per album —
// so a single 66 MB visualizer crawling over a bad link looks exactly like a wedged process for
// minutes at a time. This line is the difference between "stuck" and "slow".
describe("transferLine", () => {
  const at = (over: Partial<JobTransfer> = {}): JobTransfer => ({
    label: "Kind of Blue",
    sent: 24_248_819,
    total: 69_206_016,
    startedAt: "2026-08-08T21:00:00.000Z",
    ...over,
  });

  it("names the album, both sizes, and how much longer", () => {
    // 30s in and 23.1 MB sent — ~808 KB/s, so the remaining 43 MB is about another 56 seconds.
    const now = Date.parse("2026-08-08T21:00:30.000Z");
    expect(transferLine(at(), now)).toBe(
      "Kind of Blue — 23.1 MB of 66.0 MB · about 56s left",
    );
  });

  it("withholds the estimate until there is enough to base one on", () => {
    // One second in and barely any bytes moved: `etaSeconds` refuses, and so does the line.
    const now = Date.parse("2026-08-08T21:00:01.000Z");
    expect(transferLine(at({ sent: 1024 }), now)).toBe(
      "Kind of Blue — 1 KB of 66.0 MB",
    );
  });

  it("falls back to something nameable when the album has no name", () => {
    const now = Date.parse("2026-08-08T21:00:30.000Z");
    expect(transferLine(at({ label: "abc12345" }), now)).toContain("abc12345");
  });

  it("clamps a percentage the numbers cannot support", () => {
    expect(transferPercent(at({ sent: 999, total: 0 }))).toBe(0);
    expect(transferPercent(at({ sent: 200, total: 100 }))).toBe(100);
  });
});
