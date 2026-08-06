// What the Discogs screen shows, derived from the collection Curator already holds (ADR 0052).
//
// The design asks for four counts, a "came in today" grid and a durable list of pressings that
// couldn't be matched. None of that needs a new store: the sweep (ADR 0051) already writes every
// Discogs release into the library, so "in Curator", "came in today" and "couldn't match" are all
// questions about albums. Only "in Discogs" — the size of the collection upstream — has to be asked
// of Discogs itself.
//
// Pure, no React.
import type { AlbumSummary } from "./api";

/** Records that came from Discogs. Everything on that screen is a question about these. */
export const fromDiscogs = (albums: readonly AlbumSummary[]): AlbumSummary[] =>
  albums.filter((a) => a.source === "discogs");

/**
 * Arrived today, newest first.
 *
 * "Today" is the local calendar day rather than the last 24 hours: the screen says *today*, and a
 * record added last night should not still be claiming to be new this afternoon.
 */
export function cameInToday(
  albums: readonly AlbumSummary[],
  now: Date = new Date(),
): AlbumSummary[] {
  const sameDay = (iso: string) => {
    const d = new Date(iso);
    return (
      d.getFullYear() === now.getFullYear() &&
      d.getMonth() === now.getMonth() &&
      d.getDate() === now.getDate()
    );
  };
  return fromDiscogs(albums)
    .filter((a) => sameDay(a.createdAt))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/**
 * The records from Discogs that Roadie couldn't finish, and why.
 *
 * **These stay until they are dealt with.** They are ordinary albums in the library that stopped
 * partway, which is what makes the list durable without a second store — and also why the footer says
 * deleting one from the collection is how you get rid of it.
 *
 * The design calls this "couldn't match to Spotify", which is not a state a Discogs record can reach:
 * its metadata comes from Discogs, and the Spotify step is a best-effort *cover art* lookup that
 * never fails the add (roadie-spec §5.2). Filtering to `album_not_on_spotify` would have produced a
 * section that is empty forever. What actually strands a Discogs record is the release fetch —
 * `release_not_on_discogs`, `invalid_discogs_release` — or any ordinary pipeline failure, so the
 * predicate is "stopped, and came from Discogs" and each row carries its own reason in words.
 */
export interface Unmatched {
  album: AlbumSummary;
  /** Plain English, ending the sentence that starts with the record's name. */
  why: string;
}

const WHY: Record<string, string> = {
  release_not_on_discogs: "the release is no longer on Discogs",
  invalid_discogs_release: "the Discogs entry has no usable release id",
  album_not_on_spotify: "no Spotify release matches this pressing",
  spotify_lookup_failed: "no Spotify release matches this pressing",
};

export function unmatched(albums: readonly AlbumSummary[]): Unmatched[] {
  return fromDiscogs(albums)
    .filter((a) => a.state === "errored" || a.state === "needs_manual")
    .map((album) => ({
      album,
      why:
        WHY[album.lastError?.reason ?? ""] ??
        album.lastError?.message ??
        "Roadie couldn't finish this one",
    }));
}

export interface DiscogsCounts {
  /** The collection upstream. Null until Discogs answers — an unknown count is not zero. */
  inDiscogs: number | null;
  inCurator: number;
  today: number;
  unmatched: number;
}

export function discogsCounts(
  albums: readonly AlbumSummary[],
  inDiscogs: number | null,
  now?: Date,
): DiscogsCounts {
  return {
    inDiscogs,
    inCurator: fromDiscogs(albums).length,
    today: cameInToday(albums, now).length,
    unmatched: unmatched(albums).length,
  };
}

/**
 * "today, 18:40 · automatic" — when the sweep last ran and whether it runs itself.
 *
 * Never a bare timestamp: the question is "is this current?", and a date needs converting in your
 * head before it answers that.
 */
export function lastSynced(
  lastRunAt: string | null | undefined,
  automatic: boolean,
  now: Date = new Date(),
  locale?: string,
): string {
  if (!lastRunAt)
    return automatic ? "not yet — the first check is due" : "never";
  const d = new Date(lastRunAt);
  if (Number.isNaN(d.getTime())) return "never";
  const time = d.toLocaleTimeString(locale, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  const day = sameDay
    ? "today"
    : d.toLocaleDateString(locale, { month: "short", day: "numeric" });
  return `${day}, ${time}${automatic ? " · automatic" : " · by hand"}`;
}
