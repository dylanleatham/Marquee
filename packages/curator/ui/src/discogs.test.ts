// What the Discogs screen derives from the library (ADR 0052). None of it needs a new store: the
// sweep already writes every release in, so these are all questions about albums.
import { describe, it, expect } from "vitest";
import type { AlbumSummary } from "./api";
import { cameInToday, discogsCounts, lastSynced, unmatched } from "./discogs";

const album = (over: Partial<AlbumSummary> & { curatorId: string }) =>
  ({
    title: "Untitled",
    artist: "Nobody",
    source: "discogs",
    createdAt: new Date(2026, 7, 6, 9, 0).toISOString(),
    state: "awaiting_review",
    artwork: null,
    paletteColors: 3,
    hasVideo: false,
    year: 1977,
    genres: [],
    paletteHexes: [],
    hasCardArt: false,
    tagsWritten: false,
    previewApprovedAt: null,
    physicallyVerifiedAt: null,
    subState: null,
    lastError: null,
    ...over,
  }) as AlbumSummary;

const NOW = new Date(2026, 7, 6, 18, 40);
/**
 * Local wall-clock, deliberately: `cameInToday` compares calendar days as the user sees them, so
 * fixtures written in UTC would make this suite pass or fail depending on the machine's timezone.
 */
const at = (h: number, day = 6) => new Date(2026, 7, day, h, 0).toISOString();

describe("cameInToday", () => {
  it("counts the local calendar day, not the last 24 hours", () => {
    // The screen says *today*. A record added last night should not still claim to be new this
    // afternoon just because it is inside a rolling window.
    const list = [
      album({ curatorId: "a", createdAt: at(2) }),
      album({ curatorId: "b", createdAt: at(23, 5) }),
    ];
    expect(cameInToday(list, NOW).map((a) => a.curatorId)).toEqual(["a"]);
  });

  it("ignores records that didn't come from Discogs", () => {
    const list = [
      album({ curatorId: "a" }),
      album({ curatorId: "b", source: "spotify" }),
    ];
    expect(cameInToday(list, NOW).map((a) => a.curatorId)).toEqual(["a"]);
  });

  it("puts the newest first", () => {
    const list = [
      album({ curatorId: "old", createdAt: at(1) }),
      album({ curatorId: "new", createdAt: at(17) }),
    ];
    expect(cameInToday(list, NOW).map((a) => a.curatorId)).toEqual([
      "new",
      "old",
    ]);
  });
});

describe("unmatched", () => {
  it("is the Discogs records Roadie couldn't finish, with a reason in words", () => {
    const list = [
      album({
        curatorId: "a",
        title: "Untitled white label",
        state: "needs_manual",
        lastError: { message: "404", reason: "release_not_on_discogs" },
      }),
      album({ curatorId: "b" }),
      // Not from Discogs — this screen is only about the collection it syncs.
      album({ curatorId: "c", source: "manual", state: "errored" }),
    ];
    const out = unmatched(list);
    expect(out).toHaveLength(1);
    expect(out[0]!.album.curatorId).toBe("a");
    expect(out[0]!.why).toBe("the release is no longer on Discogs");
  });

  it("does not filter on a Spotify no-match, which a Discogs record cannot reach", () => {
    // Its metadata comes from Discogs and the Spotify step is a best-effort *art* lookup that never
    // fails the add (roadie-spec §5.2). Keying the list off `album_not_on_spotify` — which is what
    // the design's heading implies — would make this section empty forever.
    const list = [
      album({
        curatorId: "a",
        state: "errored",
        lastError: { message: "the disk is full" },
      }),
      album({ curatorId: "b", state: "needs_manual" }),
    ];
    expect(unmatched(list).map((u) => u.album.curatorId)).toEqual(["a", "b"]);
  });

  it("falls back to the server's sentence for a failure it doesn't recognise", () => {
    const list = [
      album({
        curatorId: "a",
        state: "errored",
        lastError: { message: "the disk is full" },
      }),
    ];
    expect(unmatched(list)[0]!.why).toBe("the disk is full");
  });
});

describe("discogsCounts", () => {
  it("counts the collection here and reports an unknown upstream count as unknown", () => {
    // Discogs not answering is not the same as an empty collection, and "0" would read as one.
    const list = [
      album({ curatorId: "a" }),
      album({ curatorId: "b", source: "spotify" }),
    ];
    expect(discogsCounts(list, null, NOW)).toMatchObject({
      inDiscogs: null,
      inCurator: 1,
    });
    expect(discogsCounts(list, 312, NOW).inDiscogs).toBe(312);
  });
});

describe("lastSynced", () => {
  it("says when, and whether it happens by itself", () => {
    expect(lastSynced("2026-08-06T18:40:00.000Z", true, NOW, "en-GB")).toMatch(
      /^today, \d{2}:\d{2} · automatic$/,
    );
    expect(lastSynced("2026-08-06T18:40:00.000Z", false, NOW, "en-GB")).toMatch(
      /· by hand$/,
    );
  });

  it("names the day when it wasn't today", () => {
    const out = lastSynced("2026-08-01T09:00:00.000Z", true, NOW, "en-GB");
    expect(out).not.toContain("today");
    expect(out).toMatch(/Aug/);
  });

  it("distinguishes never-yet-run from never-going-to", () => {
    expect(lastSynced(null, true, NOW)).toMatch(/first check is due/);
    expect(lastSynced(null, false, NOW)).toBe("never");
    expect(lastSynced("not a date", true, NOW)).toBe("never");
  });
});
