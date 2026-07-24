import { describe, it, expect } from "vitest";
import type { SonosDriver } from "../src/sonos/driver.js";
import { SvrooijSonosDriver } from "../src/sonos/svrooij-driver.js";
import { FakeSonosDriver } from "./fakes.js";

// The behavioural contract every SonosDriver must satisfy (amp-spec §13). The safe, non-destructive
// checks run against BOTH the fake (always) and the real @svrooij/sonos driver (only when
// AMP_SONOS_E2E is set and a real speaker is on the LAN — otherwise it would try to discover Sonos in
// CI). Destructive play/stop behaviour is asserted only for the fake.
function sharedContract(make: () => SonosDriver) {
  it("exposes play and stop functions", () => {
    const d = make();
    expect(typeof d.play).toBe("function");
    expect(typeof d.stop).toBe("function");
  });
  it("rooms() resolves to an array of strings", async () => {
    const rooms = await make().rooms();
    expect(Array.isArray(rooms)).toBe(true);
    for (const r of rooms) expect(typeof r).toBe("string");
  });
}

describe("SonosDriver contract — FakeSonosDriver", () => {
  sharedContract(
    () => new FakeSonosDriver({ rooms: ["Living Room", "Kitchen"] }),
  );

  it("records play and stop against the target", async () => {
    const d = new FakeSonosDriver();
    await d.play("Living Room", "spotify:album:abc");
    await d.stop("Living Room");
    expect(d.playCalls).toEqual([
      { target: "Living Room", spotifyUri: "spotify:album:abc" },
    ]);
    expect(d.stopCalls).toEqual(["Living Room"]);
  });
});

// Opt-in live check: set AMP_SONOS_E2E=1 on a machine with a Sonos on the LAN. Skipped in CI.
describe.runIf(process.env.AMP_SONOS_E2E)(
  "SonosDriver contract — SvrooijSonosDriver (live)",
  () => {
    sharedContract(() => new SvrooijSonosDriver());
  },
);
