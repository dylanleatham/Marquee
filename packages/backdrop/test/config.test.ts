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
});
