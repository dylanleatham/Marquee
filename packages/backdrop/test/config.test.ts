import { describe, it, expect } from "vitest";
import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("defaults to port 4740 and 90-minute idle timeout", () => {
    const c = loadConfig();
    expect(c.port).toBe(4740);
    expect(c.idleTimeoutMinutes).toBe(90);
    expect(c.host).toBe("0.0.0.0");
  });

  it("override wins over defaults", () => {
    const c = loadConfig({
      port: 9999,
      sharedSecret: "s",
      idleTimeoutMinutes: 5,
    });
    expect(c.port).toBe(9999);
    expect(c.sharedSecret).toBe("s");
    expect(c.idleTimeoutMinutes).toBe(5);
  });

  it("mediaDir defaults under the package data dir", () => {
    const c = loadConfig();
    expect(c.mediaDir.replace(/\\/g, "/")).toContain("data/media/visualizers");
  });

  /**
   * The upload cap (ADR 0038) is what stands between a runaway `PUT /api/media/:fileId` and a full SD
   * card on the Pi. A malformed value must fall back to the default rather than resolve to NaN or 0 —
   * either would reject every upload, or accept an unbounded one, both silently.
   */
  describe("maxUploadBytes", () => {
    const MB = 1024 * 1024;

    it("defaults to 2048 MB", () => {
      delete process.env.BACKDROP_MAX_UPLOAD_MB;
      expect(loadConfig().maxUploadBytes).toBe(2048 * MB);
    });

    it("reads BACKDROP_MAX_UPLOAD_MB from the environment", () => {
      process.env.BACKDROP_MAX_UPLOAD_MB = "64";
      try {
        expect(loadConfig().maxUploadBytes).toBe(64 * MB);
      } finally {
        delete process.env.BACKDROP_MAX_UPLOAD_MB;
      }
    });

    it.each(["nonsense", "0", "-5", ""])(
      "falls back to the default for %o rather than producing a nonsense cap",
      (value) => {
        process.env.BACKDROP_MAX_UPLOAD_MB = value;
        try {
          expect(loadConfig().maxUploadBytes).toBe(2048 * MB);
        } finally {
          delete process.env.BACKDROP_MAX_UPLOAD_MB;
        }
      },
    );

    it("override wins, so tests can set a tiny cap", () => {
      expect(loadConfig({ maxUploadBytes: 16 }).maxUploadBytes).toBe(16);
    });
  });
});
