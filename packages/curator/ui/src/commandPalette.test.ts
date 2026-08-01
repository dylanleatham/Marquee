// The ⌘K ranking (curator-ui-ux §9.1, ADR 0043). Kept as a pure function precisely so "typing three
// letters finds the album you meant" is checkable without a DOM — the same split as `queueKeys.ts`.
import { describe, it, expect } from "vitest";
import {
  ALBUM_LIMIT,
  clampCursor,
  rankPalette,
  scoreItem,
  scoreMatch,
  type PaletteItem,
} from "./commandPalette";

const album = (id: string, label: string, sublabel: string): PaletteItem => ({
  id,
  group: "album",
  label,
  sublabel,
});
const command = (
  id: string,
  label: string,
  keywords?: string[],
): PaletteItem =>
  keywords
    ? { id, group: "command", label, keywords }
    : { id, group: "command", label };

const labels = (items: PaletteItem[]) => items.map((i) => i.label);

describe("scoreMatch", () => {
  it("matches letters in order, not just as a substring", () => {
    expect(scoreMatch("pnk", "Pink Floyd")).not.toBeNull();
    expect(scoreMatch("pkf", "Pink Floyd")).not.toBeNull();
  });

  it("rejects letters that aren't there in order", () => {
    expect(scoreMatch("zzz", "Pink Floyd")).toBeNull();
    expect(scoreMatch("knip", "Pink Floyd")).toBeNull();
  });

  it("ranks a prefix above a mid-word hit", () => {
    const prefix = scoreMatch("dark", "Dark Side of the Moon")!;
    const middle = scoreMatch("dark", "In the Dark")!;
    expect(prefix).toBeGreaterThan(middle);
  });

  it("ranks a tight match above a scattered one", () => {
    const tight = scoreMatch("pnk", "Pnkx")!;
    const loose = scoreMatch("pnk", "Panic in the Kitchen")!;
    expect(tight).toBeGreaterThan(loose);
  });

  it("rewards word starts, so initials find a multi-word title", () => {
    const initials = scoreMatch("dsotm", "Dark Side of the Moon")!;
    const scattered = scoreMatch("dsotm", "Doo Wop Songs of the Modern era")!;
    expect(initials).toBeGreaterThan(scattered);
  });

  it("is case-insensitive and ignores surrounding whitespace", () => {
    expect(scoreMatch("  RUMOURS ", "Rumours")).toBe(
      scoreMatch("rumours", "Rumours"),
    );
  });

  it("scores an empty query as neutral rather than no-match", () => {
    expect(scoreMatch("", "anything")).toBe(0);
  });
});

describe("scoreItem", () => {
  it("prefers a title hit over an artist hit", () => {
    const byTitle = scoreItem("blue", album("a", "Blue", "Joni Mitchell"))!;
    const byArtist = scoreItem(
      "blue",
      album("b", "Agents of Fortune", "Blue Öyster Cult"),
    )!;
    expect(byTitle).toBeGreaterThan(byArtist);
  });

  it("matches unshown keywords, at a discount", () => {
    const item = command("cmd:settings", "Settings", ["preferences"]);
    expect(scoreItem("preferences", item)).not.toBeNull();
    expect(scoreItem("preferences", item)!).toBeLessThan(
      scoreItem("settings", item)!,
    );
  });

  it("returns null when nothing in the item matches", () => {
    expect(scoreItem("zqx", album("a", "Blue", "Joni Mitchell"))).toBeNull();
  });
});

describe("rankPalette", () => {
  const items = [
    album("a1", "Rumours", "Fleetwood Mac"),
    album("a2", "Tusk", "Fleetwood Mac"),
    album("a3", "Blue", "Joni Mitchell"),
    command("c1", "Settings", ["preferences"]),
    command("c2", "Add album"),
  ];

  it("lists commands only until something is typed — the library would bury them", () => {
    expect(labels(rankPalette("", items))).toEqual(["Settings", "Add album"]);
  });

  it("puts matching albums above matching commands", () => {
    const rows = rankPalette("a", items);
    const firstCommand = rows.findIndex((r) => r.group === "command");
    const lastAlbum = rows.map((r) => r.group).lastIndexOf("album");
    expect(lastAlbum).toBeLessThan(firstCommand);
  });

  it("finds an album by artist as well as title", () => {
    expect(labels(rankPalette("fleetwood", items))).toEqual([
      "Rumours",
      "Tusk",
    ]);
  });

  it("drops everything that doesn't match", () => {
    expect(rankPalette("zzzz", items)).toEqual([]);
  });

  it("caps the album list so a large library can't crowd out the commands", () => {
    const many = Array.from({ length: 40 }, (_, i) =>
      album(`x${i}`, `Album ${i}`, "Various"),
    );
    const rows = rankPalette("album", [
      ...many,
      command("c1", "Album settings"),
    ]);
    expect(rows.filter((r) => r.group === "album")).toHaveLength(ALBUM_LIMIT);
    expect(rows.filter((r) => r.group === "command")).toHaveLength(1);
  });

  it("breaks ties on label so the order never shuffles between renders", () => {
    const tied = [album("a", "Zebra", "X"), album("b", "Apple", "X")];
    expect(labels(rankPalette("x", tied))).toEqual(
      labels(rankPalette("x", tied)),
    );
  });
});

describe("clampCursor", () => {
  it("keeps the cursor inside a list that just shrank", () => {
    expect(clampCursor(9, 3)).toBe(2);
  });
  it("floors at zero, including for an empty list", () => {
    expect(clampCursor(-4, 3)).toBe(0);
    expect(clampCursor(2, 0)).toBe(0);
  });
});
