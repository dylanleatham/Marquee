// The Spotify-identity backfill's progress panel (ADR 0059).
//
// The summary is the whole point of this screen: it has to make "can now play" and "matched, but
// deliberately silent" two visibly different outcomes, because the second is the one a user would
// otherwise read as a failure.
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

vi.mock("../spotifyBackfillJob", () => ({
  useSpotifyBackfillJob: vi.fn(),
  cancelSpotifyBackfill: vi.fn(),
  dismissSpotifyBackfill: vi.fn(),
}));

import { MemoryRouter } from "react-router-dom";
import { useSpotifyBackfillJob } from "../spotifyBackfillJob";
import { SpotifyBackfillProgress } from "./SpotifyBackfillProgress";
import type { GenerationJob, SpotifyBackfillReport } from "../api";

const report = (
  over: Partial<SpotifyBackfillReport> = {},
): SpotifyBackfillReport => ({
  total: 3,
  matched: 1,
  artOnly: 1,
  noMatch: 1,
  ambiguous: 0,
  skipped: 0,
  failed: 0,
  items: [
    {
      curatorId: "aaaa1111",
      label: "Radiohead — In Rainbows",
      status: "matched",
      matchedTo: "Radiohead — In Rainbows",
    },
    {
      curatorId: "bbbb2222",
      label: "The Who — Live",
      status: "art_only",
      matchedTo: "The Who — Live at Leeds",
    },
    {
      curatorId: "cccc3333",
      label: "Private Press — Demo",
      status: "no_match",
    },
  ],
  ...over,
});

type JobState = ReturnType<typeof useSpotifyBackfillJob>;

const show = (state: Partial<JobState>) => {
  vi.mocked(useSpotifyBackfillJob).mockReturnValue(state as JobState);
  return render(
    <MemoryRouter>
      <SpotifyBackfillProgress />
    </MemoryRouter>,
  );
};

const finished = (r: SpotifyBackfillReport): Partial<JobState> => ({
  job: {
    id: "j1",
    kind: "spotifyBackfill",
    status: "done",
    progress: { done: 3, total: 3 },
    createdAt: "",
    updatedAt: "",
    result: { spotifyBackfill: r },
  } as GenerationJob,
  unreachable: false,
});

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe("SpotifyBackfillProgress", () => {
  it("counts what can now play separately from what matched but stays silent", () => {
    show(finished(report()));
    expect(screen.getByText(/1 can now play/)).toBeTruthy();
    expect(screen.getByText(/1 near matches \(silent\)/)).toBeTruthy();
  });

  /**
   * A near match is the outcome most likely to be misread as a bug, so the row says both that it
   * won't play and what it found — the two facts you need to decide whether to accept it by hand.
   */
  it("names what a near match found, and that it won't play", () => {
    show(finished(report()));
    expect(screen.getByText("Near match — won't play")).toBeTruthy();
    expect(screen.getByText("→ The Who — Live at Leeds")).toBeTruthy();
  });

  /**
   * #289. An ambiguous record is the one outcome the sweep can never improve on, so its row has to
   * send the reader to the record rather than back to this button — and the summary has to say so,
   * because "1 not found" invites exactly the re-run that will refuse it again.
   */
  it("counts records that need a human apart from ones it simply missed", () => {
    show(
      finished(
        report({
          ambiguous: 1,
          items: [
            {
              curatorId: "dddd4444",
              label: "Weezer — Weezer",
              status: "ambiguous",
              matchedTo: "6 albums share this title",
            },
          ],
        }),
      ),
    );
    expect(screen.getByText(/1 need you to pick/)).toBeTruthy();
    expect(screen.getByText(/re-running won't help/)).toBeTruthy();
    expect(
      screen.getByText(
        "Several albums share this title — pick it on the record",
      ),
    ).toBeTruthy();
    // The row is the way there. A sweep that names six records you must visit and then makes you
    // find them by hand is the same dead end #289 is about, one level up.
    expect(
      screen
        .getByRole("link", { name: "Weezer — Weezer" })
        .getAttribute("href"),
    ).toBe("/albums/dddd4444/demo");
  });

  /** A library with no same-titled albums must not carry a permanent "0 need you" chore. */
  it("stays quiet about ambiguity when there is none", () => {
    show(finished(report()));
    expect(screen.queryByText(/need you to pick/)).toBeNull();
    // Rows that need no visit stay plain text — a link that goes nowhere useful is noise.
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("says an abandoned run stopped early rather than letting a short count read as clean", () => {
    show(finished(report({ abandoned: true, failed: 10 })));
    expect(
      screen.getByText(/stopped early after repeated failures/),
    ).toBeTruthy();
  });

  /**
   * A real run is mostly skips — albums already matched, or not from Discogs. Showing them buries
   * the two rows that matter.
   */
  it("leaves the skipped rows out of the list", () => {
    show(
      finished(
        report({
          items: [
            ...report().items,
            {
              curatorId: "dddd4444",
              label: "Already Matched",
              status: "skipped_has_uri",
            },
          ],
        }),
      ),
    );
    expect(screen.queryByText("Already Matched")).toBeNull();
    expect(screen.getByText("Radiohead — In Rainbows")).toBeTruthy();
  });

  it("reports a cancelled run as keeping what it already matched", () => {
    show({
      job: {
        id: "j1",
        kind: "spotifyBackfill",
        status: "cancelled",
        progress: { done: 1, total: 3 },
        createdAt: "",
        updatedAt: "",
      } as GenerationJob,
      unreachable: false,
    });
    expect(screen.getByText(/keep their match/)).toBeTruthy();
  });
});
