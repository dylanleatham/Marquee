import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.js";

const tempDir = (p: string) => mkdtempSync(join(tmpdir(), p));

describe("Store", () => {
  it("round-trips a bridge record and settings across instances", () => {
    const dir = tempDir("conductor-store-");
    const record = {
      id: "BID",
      ip: "10.0.0.5",
      applicationKey: "secret-key",
      pairedAt: "2026-07-10T00:00:00.000Z",
    };
    const a = new Store(dir);
    a.saveBridge(record);
    a.setListeningRoom("room-1");

    const reloaded = new Store(dir); // fresh instance reads from disk
    expect(reloaded.bridge).toEqual(record);
    expect(reloaded.settings.listeningRoomId).toBe("room-1");
  });

  it("defaults to unpaired with no listening room or entertainment area", () => {
    const fresh = new Store(tempDir("conductor-empty-"));
    expect(fresh.bridge).toBeNull();
    expect(fresh.settings.listeningRoomId).toBeNull();
    expect(fresh.settings.entertainmentAreaId).toBeNull();
  });

  it("sets the entertainment area without clobbering the listening room (and vice versa)", () => {
    const dir = tempDir("conductor-area-");
    const s = new Store(dir);
    s.setListeningRoom("room-1");
    s.setEntertainmentArea("area-9");
    expect(s.settings.listeningRoomId).toBe("room-1"); // preserved
    expect(s.settings.entertainmentAreaId).toBe("area-9");

    s.setListeningRoom("room-2");
    expect(s.settings.entertainmentAreaId).toBe("area-9"); // preserved
    expect(new Store(dir).settings.entertainmentAreaId).toBe("area-9"); // persisted
  });
});
