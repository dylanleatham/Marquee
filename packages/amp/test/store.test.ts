import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.js";

const dir = () => mkdtempSync(join(tmpdir(), "amp-store-"));

describe("Store", () => {
  it("seeds the target room from the config default when nothing is persisted", () => {
    expect(new Store(dir(), "Living Room").settings.targetRoom).toBe(
      "Living Room",
    );
    expect(new Store(dir(), null).settings.targetRoom).toBeNull();
  });

  it("persists a target-room change across instances (same data dir)", () => {
    const d = dir();
    new Store(d, null).setTargetRoom("Kitchen");
    // A fresh instance reads the persisted value, ignoring the default.
    expect(new Store(d, "Bedroom").settings.targetRoom).toBe("Kitchen");
  });
});
