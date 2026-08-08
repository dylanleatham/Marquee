// Tag payload + QR (issue #102 / curator-spec §Tag writing). Both writing paths are first class:
// the Flipper takes the `.nfc`, and a phone points at this QR. The payload is composed server-side
// so there is one source of truth for the string that gets physically burned into a sticker.
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AssetStore } from "../src/store/asset-store.js";
import { buildServer } from "../src/server.js";
import { tagQrDataUrl } from "../src/tags/qr.js";
import { fakeRoadie, fakeProber, makeAsset } from "./helpers.js";

const store = () => new AssetStore(mkdtempSync(join(tmpdir(), "curator-qr-")));

const decodeSvg = (dataUrl: string): string =>
  Buffer.from(
    dataUrl.replace("data:image/svg+xml;base64,", ""),
    "base64",
  ).toString("utf8");

describe("tagQrDataUrl", () => {
  it("produces an inline SVG data URL", async () => {
    const url = await tagQrDataUrl("curator:album:abcd1234");
    expect(url.startsWith("data:image/svg+xml;base64,")).toBe(true);
    const svg = decodeSvg(url);
    expect(svg).toContain("<svg");
    expect(svg).toContain("viewBox");
  });

  it("encodes different payloads differently", async () => {
    const a = await tagQrDataUrl("curator:album:abcd1234");
    const b = await tagQrDataUrl("curator:card:abcd1234");
    expect(a).not.toBe(b);
  });

  it("is deterministic for the same payload", async () => {
    expect(await tagQrDataUrl("curator:album:abcd1234")).toBe(
      await tagQrDataUrl("curator:album:abcd1234"),
    );
  });
});

describe("GET /api/albums/:curatorId/tag-payload", () => {
  let s: AssetStore;
  const app = () =>
    buildServer({ store: s, roadie: fakeRoadie(s), prober: fakeProber() }).app;

  beforeEach(() => {
    s = store();
    s.save(makeAsset("abcd1234"));
  });

  it("returns the sleeve payload and a QR by default", async () => {
    const res = await app().inject({
      method: "GET",
      url: "/api/albums/abcd1234/tag-payload",
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      object: "sleeve",
      payload: "curator:album:abcd1234",
    });
    expect(decodeSvg(res.json().qrDataUrl)).toContain("<svg");
  });

  // A sleeve and a card carry deliberately different URIs (ADR 0034) — writing the wrong one is a
  // silent failure, so the route must never conflate them.
  it("returns the card URI for ?object=card", async () => {
    const res = await app().inject({
      method: "GET",
      url: "/api/albums/abcd1234/tag-payload?object=card",
    });

    expect(res.json()).toMatchObject({
      object: "card",
      payload: "curator:card:abcd1234",
    });
  });

  it("returns the demo URI for ?object=demo (ADR 0058)", async () => {
    const res = await app().inject({
      method: "GET",
      url: "/api/albums/abcd1234/tag-payload?object=demo",
    });

    expect(res.json()).toMatchObject({
      object: "demo",
      payload: "curator:demo:abcd1234",
    });
  });

  it("gives each object its own QR — three stickers, three codes", async () => {
    const qr = async (object: string) =>
      (
        await app().inject({
          method: "GET",
          url: `/api/albums/abcd1234/tag-payload?object=${object}`,
        })
      ).json().qrDataUrl;

    const codes = [await qr("sleeve"), await qr("card"), await qr("demo")];
    expect(new Set(codes).size).toBe(3);
  });

  it("treats an unknown object as the sleeve rather than erroring", async () => {
    const res = await app().inject({
      method: "GET",
      url: "/api/albums/abcd1234/tag-payload?object=nonsense",
    });
    expect(res.json().object).toBe("sleeve");
    expect(res.json().payload).toBe("curator:album:abcd1234");
  });

  // A tag written before this route existed recorded its own payload; honour it so the QR always
  // matches what is physically on the sticker.
  it("prefers a payload already recorded on the asset for the sleeve", async () => {
    const a = s.read("abcd1234")!;
    a.tag = { payload: "curator:album:legacy01" };
    s.save(a);

    const res = await app().inject({
      method: "GET",
      url: "/api/albums/abcd1234/tag-payload",
    });
    expect(res.json().payload).toBe("curator:album:legacy01");
  });

  it("still derives the card URI even when a sleeve payload is recorded", async () => {
    const a = s.read("abcd1234")!;
    a.tag = { payload: "curator:album:legacy01" };
    s.save(a);

    const res = await app().inject({
      method: "GET",
      url: "/api/albums/abcd1234/tag-payload?object=card",
    });
    expect(res.json().payload).toBe("curator:card:abcd1234");
  });

  it("404s for an unknown album", async () => {
    const res = await app().inject({
      method: "GET",
      url: "/api/albums/missing0/tag-payload",
    });
    expect(res.statusCode).toBe(404);
  });
});
