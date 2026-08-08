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
  return render(<SpotifyBackfillProgress />);
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
