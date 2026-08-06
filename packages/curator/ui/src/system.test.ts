// What the System screen says (ADR 0052). The matrix is gone; these are the derivations that
// replaced it, and the important one is what "everywhere it should be" means.
import { describe, it, expect } from "vitest";
import type { AlbumPresence, ServiceHealth } from "./api";
import {
  exceptions,
  JOB_LABEL,
  jobProgress,
  presenceProblem,
  serviceLine,
  servicePort,
  serviceState,
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
