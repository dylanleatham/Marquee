import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  pendingCsv,
  mergePendingCsv,
  parsePendingCsv,
} from "../src/tags/pending-csv.js";
import { buildServer } from "../src/server.js";
import { AssetStore } from "../src/store/asset-store.js";
import { fakeRoadie, makeAsset } from "./helpers.js";

const ID = "2k7bxq9m";

describe("pendingCsv", () => {
  it("writes a header row and one line per album", () => {
    expect(
      pendingCsv([
        { curatorId: ID, name: "Purple Rain", artist: "Prince" },
        { curatorId: "aaaa1111", name: "1999", artist: "Prince" },
      ]),
    ).toBe(
      "curatorId,name,artist\n" +
        `${ID},Purple Rain,Prince\n` +
        "aaaa1111,1999,Prince\n",
    );
  });

  it("emits just the header when nothing is pending", () => {
    expect(pendingCsv([])).toBe("curatorId,name,artist\n");
  });

  /**
   * The FAP splits on the first two commas rather than parsing RFC-4180, so a comma reaching the file
   * would shift every field after it. Stripping them at the source is what makes that reader correct.
   */
  it("strips commas, quotes and newlines so the reader's field split stays exact", () => {
    const csv = pendingCsv([
      {
        curatorId: ID,
        name: 'Songs, Ohia "live"',
        artist: "Jason\nMolina",
      },
    ]);
    const line = csv.trim().split("\n")[1]!;
    expect(line.split(",")).toHaveLength(3);
    expect(line).toBe(`${ID},Songs Ohia live,Jason Molina`);
  });

  it("keeps the curatorId first and untouched", () => {
    const line = pendingCsv([{ curatorId: ID, name: ",,,", artist: ",,," }])
      .trim()
      .split("\n")[1]!;
    expect(line.startsWith(`${ID},`)).toBe(true);
    expect(line.split(",")[0]).toBe(ID);
  });
});

describe("GET /api/tags/pending.csv (issue #68)", () => {
  const server = () => {
    const store = new AssetStore(mkdtempSync(join(tmpdir(), "curator-csv-")));
    const { app } = buildServer({ store, roadie: fakeRoadie(store) });
    return { app, store };
  };

  it("downloads the pending list as CSV", async () => {
    const { app, store } = server();
    const a = makeAsset(ID, "Purple Rain", "Prince");
    a.roadie.state = "awaiting_tag_write";
    store.save(a);
    store.save(makeAsset("aaaa1111", "1999", "Prince")); // awaiting_review — excluded

    const res = await app.inject({
      method: "GET",
      url: "/api/tags/pending.csv",
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/csv");
    expect(res.headers["content-disposition"]).toContain("pending.csv");
    expect(res.body).toBe(`curatorId,name,artist\n${ID},Purple Rain,Prince\n`);
  });

  it("agrees with the JSON pending route", async () => {
    const { app, store } = server();
    const a = makeAsset(ID, "Purple Rain", "Prince");
    a.roadie.state = "awaiting_tag_write";
    store.save(a);

    const { pending } = (
      await app.inject({ method: "GET", url: "/api/tags/pending" })
    ).json();
    const csv = (
      await app.inject({ method: "GET", url: "/api/tags/pending.csv" })
    ).body;

    const ids = csv
      .trim()
      .split("\n")
      .slice(1)
      .map((l) => l.split(",")[0]);
    expect(ids).toEqual(pending.map((p: { curatorId: string }) => p.curatorId));
  });
});

describe("mergePendingCsv", () => {
  const purple = {
    curatorId: "2k7bxq9m",
    name: "Purple Rain",
    artist: "Prince",
  };
  const blue = {
    curatorId: "7v3mn2xd",
    name: "Kind of Blue",
    artist: "Miles Davis",
  };

  it("appends to an existing list", () => {
    expect(mergePendingCsv(pendingCsv([purple]), [blue])).toBe(
      pendingCsv([purple, blue]),
    );
  });

  it("starts a list when the card has nothing yet", () => {
    expect(mergePendingCsv("", [purple])).toBe(pendingCsv([purple]));
  });

  /** Pressing "add" twice must not put the same record on the Flipper twice. */
  it("does not duplicate an album already on the list", () => {
    const once = mergePendingCsv(pendingCsv([purple, blue]), [purple]);
    expect(parsePendingCsv(once)).toHaveLength(2);
    expect(once).toBe(pendingCsv([purple, blue]));
  });

  it("updates a row in place, keeping its position, when the album is re-sent", () => {
    const renamed = { ...purple, name: "Purple Rain (Deluxe)" };
    const merged = mergePendingCsv(pendingCsv([purple, blue]), [renamed]);
    expect(parsePendingCsv(merged)).toEqual([renamed, blue]);
  });

  /** A corrupt line should cost that line, not the whole list. */
  it("drops unparseable lines rather than losing the list", () => {
    const merged = mergePendingCsv(
      "curatorId,name,artist\ngarbage-no-comma\n2k7bxq9m,Purple Rain,Prince\n",
      [blue],
    );
    expect(parsePendingCsv(merged)).toEqual([purple, blue]);
  });
});

describe("parsePendingCsv", () => {
  it("round-trips what pendingCsv writes", () => {
    const rows = [
      { curatorId: "2k7bxq9m", name: "Purple Rain", artist: "Prince" },
      { curatorId: "aaaa1111", name: "1999", artist: "Prince" },
    ];
    expect(parsePendingCsv(pendingCsv(rows))).toEqual(rows);
  });

  it("ignores the header and blank lines, and tolerates CRLF", () => {
    expect(
      parsePendingCsv("curatorId,name,artist\r\n\r\n2k7bxq9m,A,B\r\n"),
    ).toEqual([{ curatorId: "2k7bxq9m", name: "A", artist: "B" }]);
  });
});
