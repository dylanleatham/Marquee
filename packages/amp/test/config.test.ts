import { describe, it, expect } from "vitest";
import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("has sane defaults (no config.toml on the workstation)", () => {
    const c = loadConfig();
    expect(c.port).toBe(4741);
    expect(c.host).toBe("0.0.0.0");
    expect(c.idleTimeoutMinutes).toBe(90);
    // albumAssetsDir defaults under the data dir
    expect(c.albumAssetsDir).toContain("album-assets");
  });

  it("override wins over file/env/defaults (how tests inject)", () => {
    const c = loadConfig({
      sharedSecret: "secret",
      idleTimeoutMinutes: 1,
      defaultTargetRoom: "Kitchen",
    });
    expect(c.sharedSecret).toBe("secret");
    expect(c.idleTimeoutMinutes).toBe(1);
    expect(c.defaultTargetRoom).toBe("Kitchen");
  });
});
