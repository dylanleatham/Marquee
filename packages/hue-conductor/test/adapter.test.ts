import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.js";
import { BridgeAdapter } from "../src/bridge/adapter.js";
import { makeFakeDriver } from "./fakes.js";

const tempStore = () =>
  new Store(mkdtempSync(join(tmpdir(), "conductor-adapter-")));
const paired = () => {
  const s = tempStore();
  s.saveBridge({
    id: "BID",
    ip: "10.0.0.5",
    applicationKey: "k",
    pairedAt: "t",
  });
  return s;
};

describe("BridgeAdapter", () => {
  it("setRoomColor addresses each light in the room individually", async () => {
    const { driver, setCalls } = makeFakeDriver({
      groups: [
        { id: "1", name: "Living", type: "Room", lights: ["11", "12", "13"] },
      ],
    });
    const res = await new BridgeAdapter(paired(), driver).setRoomColor(
      "1",
      "#4B0082",
    );

    expect(res).toEqual({ lightsSet: 3 });
    expect(setCalls.map((c) => c.lightId)).toEqual(["11", "12", "13"]);
    expect(setCalls.every((c) => c.on)).toBe(true);
    expect(setCalls[0].rgb).toEqual([75, 0, 130]); // #4B0082
  });

  it("pair retries while the link button is unpressed, then persists the key", async () => {
    const store = tempStore();
    const { driver, getCreateUserCalls } = makeFakeDriver({
      linkButtonFailuresBeforeSuccess: 2,
    });
    const rec = await new BridgeAdapter(store, driver).pair("10.0.0.5", {
      attempts: 5,
      intervalMs: 0,
    });

    expect(getCreateUserCalls()).toBe(3); // 2 failures + 1 success
    expect(rec.applicationKey).toBe("app-key-123");
    expect(rec.id).toBe("BID123");
    expect(store.bridge?.applicationKey).toBe("app-key-123");
    // The DTLS PSK for Entertainment streaming is captured at pairing (ADR 0024).
    expect(rec.clientkey).toBe("DEADBEEF00");
    expect(store.bridge?.clientkey).toBe("DEADBEEF00");
  });

  it("pair times out if the link button is never pressed, leaving no bridge saved", async () => {
    const store = tempStore();
    const { driver } = makeFakeDriver({ createUserAlwaysFails: true });
    await expect(
      new BridgeAdapter(store, driver).pair("10.0.0.5", {
        attempts: 3,
        intervalMs: 0,
      }),
    ).rejects.toThrow(/timed out/i);
    expect(store.bridge).toBeNull();
  });

  it("getRooms returns only Room/Zone groups with their light ids", async () => {
    const { driver } = makeFakeDriver({
      groups: [
        { id: "1", name: "Living", type: "Room", lights: ["11", "12"] },
        { id: "2", name: "All lights", type: "LightGroup", lights: ["11"] },
        { id: "3", name: "Zone A", type: "Zone", lights: ["13"] },
      ],
    });
    const rooms = await new BridgeAdapter(paired(), driver).getRooms();

    expect(rooms.map((r) => r.name)).toEqual(["Living", "Zone A"]);
    expect(rooms[0].lightIds).toEqual(["11", "12"]);
  });

  it("mapV1Groups parses the raw CLIP v1 groups map and skips non-groups", async () => {
    const { mapV1Groups } = await import("../src/bridge/adapter.js");
    const groups = mapV1Groups({
      "1": {
        name: "Living",
        type: "Room",
        lights: [11, 12],
        class: "Living Room",
      },
      "3": {
        name: "Cinema",
        type: "Entertainment",
        lights: [11],
        class: "Free",
      }, // the class that breaks getAll
      "0": [{ error: { description: "unauthorized user" } }], // bridge error array — skipped
    });
    expect(groups).toEqual([
      { id: "1", name: "Living", type: "Room", lights: ["11", "12"] },
      { id: "3", name: "Cinema", type: "Entertainment", lights: ["11"] },
    ]);
  });

  it("throws NotPairedError before any bridge is paired", async () => {
    const { driver } = makeFakeDriver();
    await expect(
      new BridgeAdapter(tempStore(), driver).getRooms(),
    ).rejects.toThrow(/no hue bridge paired/i);
  });
});
