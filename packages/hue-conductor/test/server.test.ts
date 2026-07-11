import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.js";
import { buildServer } from "../src/server.js";
import { makeFakeDriver } from "./fakes.js";

const SECRET = "test-secret";
const AUTH = { "x-trigger-secret": SECRET };

const seededStore = () => {
  const s = new Store(mkdtempSync(join(tmpdir(), "conductor-srv-")));
  s.saveBridge({
    id: "BID",
    ip: "10.0.0.5",
    applicationKey: "k",
    pairedAt: "t",
  });
  return s;
};
const livingRoom = () =>
  makeFakeDriver({
    groups: [{ id: "1", name: "Living", type: "Room", lights: ["11", "12"] }],
  });

describe("hue-conductor HTTP API", () => {
  it("/healthz needs no auth and reports paired state", async () => {
    const { app } = buildServer({
      config: { sharedSecret: SECRET },
      store: seededStore(),
      driver: livingRoom().driver,
    });
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, paired: true });
  });

  it("rejects /api/* without the shared secret", async () => {
    const { app } = buildServer({
      config: { sharedSecret: SECRET },
      store: seededStore(),
      driver: livingRoom().driver,
    });
    const res = await app.inject({ method: "GET", url: "/api/rooms" });
    expect(res.statusCode).toBe(401);
  });

  it("returns rooms when the shared secret is present", async () => {
    const { app } = buildServer({
      config: { sharedSecret: SECRET },
      store: seededStore(),
      driver: livingRoom().driver,
    });
    const res = await app.inject({
      method: "GET",
      url: "/api/rooms",
      headers: AUTH,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().rooms[0].name).toBe("Living");
  });

  it("POST /api/test/color sets every light in the room", async () => {
    const fake = livingRoom();
    const { app } = buildServer({
      config: { sharedSecret: SECRET },
      store: seededStore(),
      driver: fake.driver,
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/test/color",
      headers: AUTH,
      payload: { roomId: "1", hex: "#4B0082" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ lightsSet: 2 });
    expect(fake.setCalls).toHaveLength(2);
  });

  it("POST /api/test/color 400s without roomId/hex", async () => {
    const { app } = buildServer({
      config: { sharedSecret: SECRET },
      store: seededStore(),
      driver: livingRoom().driver,
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/test/color",
      headers: AUTH,
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it("409s when no bridge is paired", async () => {
    const store = new Store(mkdtempSync(join(tmpdir(), "conductor-np-")));
    const { app } = buildServer({
      config: { sharedSecret: SECRET },
      store,
      driver: makeFakeDriver().driver,
    });
    const res = await app.inject({
      method: "GET",
      url: "/api/rooms",
      headers: AUTH,
    });
    expect(res.statusCode).toBe(409);
  });

  it("GET /api/settings returns current settings and PUT persists listeningRoomId", async () => {
    const { app } = buildServer({
      config: { sharedSecret: SECRET },
      store: seededStore(),
      driver: livingRoom().driver,
    });

    let res = await app.inject({
      method: "GET",
      url: "/api/settings",
      headers: AUTH,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().listeningRoomId).toBeNull();

    res = await app.inject({
      method: "PUT",
      url: "/api/settings",
      headers: AUTH,
      payload: { listeningRoomId: "1" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().listeningRoomId).toBe("1");

    res = await app.inject({
      method: "GET",
      url: "/api/settings",
      headers: AUTH,
    });
    expect(res.json().listeningRoomId).toBe("1"); // persisted
  });

  describe("GET /api/bridge/status", () => {
    it("reports unpaired when no bridge is stored", async () => {
      const store = new Store(mkdtempSync(join(tmpdir(), "conductor-st-")));
      const { app } = buildServer({
        config: { sharedSecret: SECRET },
        store,
        driver: makeFakeDriver().driver,
      });
      const res = await app.inject({
        method: "GET",
        url: "/api/bridge/status",
        headers: AUTH,
      });
      expect(res.json()).toEqual({ paired: false });
    });

    it("reports paired + reachable when the bridge answers", async () => {
      const { app } = buildServer({
        config: { sharedSecret: SECRET },
        store: seededStore(),
        driver: makeFakeDriver().driver,
      });
      const res = await app.inject({
        method: "GET",
        url: "/api/bridge/status",
        headers: AUTH,
      });
      expect(res.json()).toMatchObject({ paired: true, reachable: true });
    });

    it("reports paired + unreachable when the bridge errors", async () => {
      const { app } = buildServer({
        config: { sharedSecret: SECRET },
        store: seededStore(),
        driver: makeFakeDriver({ configThrows: true }).driver,
      });
      const res = await app.inject({
        method: "GET",
        url: "/api/bridge/status",
        headers: AUTH,
      });
      expect(res.json()).toMatchObject({ paired: true, reachable: false });
    });
  });
});
