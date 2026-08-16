import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  pendingCsv,
  mergePendingCsv,
  parsePendingCsv,
  sortPendingRows,
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

  /**
   * The store hands back its own order (newest-first, then whatever `readdirSync` gives), so the
   * alphabetical order is the route's doing and has to be tested at the route. The ids here are
   * deliberately in the opposite order to the names: a `sortPendingRows` dropped from `pendingRows`
   * would leave this list in id order and go red.
   */
  it("serves both routes alphabetically, whatever order the store lists in", async () => {
    const { app, store } = server();
    for (const [id, name] of [
      ["aaaa1111", "Purple Rain"],
      ["bbbb2222", "Aja"],
      ["cccc3333", "Kind of Blue"],
    ] as const) {
      const a = makeAsset(id, name, "Prince");
      a.roadie.state = "awaiting_tag_write";
      store.save(a);
    }

    const { pending } = (
      await app.inject({ method: "GET", url: "/api/tags/pending" })
    ).json();
    expect(pending.map((p: { name: string }) => p.name)).toEqual([
      "Aja",
      "Kind of Blue",
      "Purple Rain",
    ]);

    const csv = (
      await app.inject({ method: "GET", url: "/api/tags/pending.csv" })
    ).body;
    expect(csv).toBe(
      "curatorId,name,artist\n" +
        "bbbb2222,Aja,Prince\n" +
        "cccc3333,Kind of Blue,Prince\n" +
        "aaaa1111,Purple Rain,Prince\n",
    );
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

  /** Adding one at a time from the Ship tab must build the same list the batch push writes. */
  it("files an addition alphabetically rather than appending it", () => {
    expect(mergePendingCsv(pendingCsv([purple]), [blue])).toBe(
      pendingCsv([blue, purple]),
    );
  });

  it("re-sorts a list that reached the card out of order", () => {
    const merged = mergePendingCsv(pendingCsv([purple, blue]), []);
    expect(parsePendingCsv(merged)).toEqual([blue, purple]);
  });

  it("starts a list when the card has nothing yet", () => {
    expect(mergePendingCsv("", [purple])).toBe(pendingCsv([purple]));
  });

  /** Pressing "add" twice must not put the same record on the Flipper twice. */
  it("does not duplicate an album already on the list", () => {
    const once = mergePendingCsv(pendingCsv([purple, blue]), [purple]);
    expect(parsePendingCsv(once)).toHaveLength(2);
    expect(once).toBe(pendingCsv([blue, purple]));
  });

  /**
   * Re-sending an unchanged album must produce byte-identical output — `pushFile` compares the
   * read-back against what it wrote, so a list that churns on every add turns that check into noise.
   */
  it("is idempotent when the album is re-sent unchanged", () => {
    const once = mergePendingCsv(pendingCsv([purple, blue]), [purple]);
    expect(mergePendingCsv(once, [purple])).toBe(once);
  });

  it("moves a renamed album to its new place in the alphabet", () => {
    const renamed = { ...purple, name: "Aja" };
    const merged = mergePendingCsv(pendingCsv([purple, blue]), [renamed]);
    expect(parsePendingCsv(merged)).toEqual([renamed, blue]);
  });

  /** A corrupt line should cost that line, not the whole list. */
  it("drops unparseable lines rather than losing the list", () => {
    const merged = mergePendingCsv(
      "curatorId,name,artist\ngarbage-no-comma\n2k7bxq9m,Purple Rain,Prince\n",
      [blue],
    );
    expect(parsePendingCsv(merged)).toEqual([blue, purple]);
  });
});

/**
 * The on-device menu is a d-pad scroll through up to 64 rows, mixing records already tagged with
 * records still to do. Alphabetical is what makes "is this one on here?" answerable.
 */
describe("sortPendingRows", () => {
  const row = (name: string, artist = "", curatorId = "aaaa1111") => ({
    curatorId,
    name,
    artist,
  });
  const names = (rows: readonly { name: string }[]) => rows.map((r) => r.name);

  it("orders by album name", () => {
    expect(
      names(sortPendingRows([row("Purple Rain"), row("Aja"), row("Kid A")])),
    ).toEqual(["Aja", "Kid A", "Purple Rain"]);
  });

  it("ignores case and accents, so a sloppy title still files where you'd look", () => {
    expect(
      names(sortPendingRows([row("bitches brew"), row("Ágætis byrjun")])),
    ).toEqual(["Ágætis byrjun", "bitches brew"]);
  });

  it("orders numbers by value, not by digit", () => {
    expect(
      names(sortPendingRows([row("Vol. 10"), row("Vol. 2"), row("Vol. 1")])),
    ).toEqual(["Vol. 1", "Vol. 2", "Vol. 10"]);
  });

  it("breaks a shared album name on the artist", () => {
    expect(
      sortPendingRows([
        row("Greatest Hits", "Queen"),
        row("Greatest Hits", "Blondie"),
      ]).map((r) => r.artist),
    ).toEqual(["Blondie", "Queen"]);
  });

  /** Two identical labels must still come out in one fixed order, or the CSV bytes wobble. */
  it("is a total order — curatorId breaks the last tie", () => {
    const rows = [
      row("Untitled", "Unknown", "zzzz9999"),
      row("Untitled", "Unknown", "aaaa1111"),
    ];
    expect(sortPendingRows(rows).map((r) => r.curatorId)).toEqual([
      "aaaa1111",
      "zzzz9999",
    ]);
    expect(sortPendingRows([...rows].reverse())).toEqual(sortPendingRows(rows));
  });

  /**
   * The FAP's label is the sanitized text, so sorting the raw metadata would put a row somewhere the
   * screen doesn't explain.
   */
  it("sorts on the sanitized label the Flipper actually draws", () => {
    expect(
      names(sortPendingRows([row('  "Zoo Station"  '), row("Aja")])),
    ).toEqual(["Aja", '  "Zoo Station"  ']);
  });

  it("leaves the caller's array alone", () => {
    const rows = [row("Purple Rain"), row("Aja")];
    sortPendingRows(rows);
    expect(names(rows)).toEqual(["Purple Rain", "Aja"]);
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
