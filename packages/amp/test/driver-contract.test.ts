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

  /**
   * The third argument is the whole of [ADR 0078](../../../docs/adrs/0078-a-demo-cut-plays-as-a-position-in-the-album.md): a demo cut is *a position in an album*,
   * because Sonos will not start a track handed to it on its own. Pinned in the contract rather than
   * only in the scan tests, so a second driver implementation has to carry it too — the real driver
   * turns it into a `Seek(TRACK_NR)` between `SwitchToQueue` and `Play`, which no unit test can see.
   */
  it("carries the 1-based position a demo cut plays from", async () => {
    const d = new FakeSonosDriver();
    await d.play("Living Room", "spotify:album:abc", 4);
    expect(d.playCalls).toEqual([
      {
        target: "Living Room",
        spotifyUri: "spotify:album:abc",
        trackNumber: 4,
      },
    ]);
  });

  it("omits the position when none was asked for — a card plays from the top", async () => {
    const d = new FakeSonosDriver();
    await d.play("Living Room", "spotify:album:abc");
    expect(d.playCalls[0]).not.toHaveProperty("trackNumber");
  });
});

// Opt-in live check: set AMP_SONOS_E2E=1 on a machine with a Sonos on the LAN. Skipped in CI.
describe.runIf(process.env.AMP_SONOS_E2E)(
  "SonosDriver contract — SvrooijSonosDriver (live)",
  () => {
    sharedContract(() => new SvrooijSonosDriver());
  },
);
