// Roadie's log (ADR 0052): sentences, not state names; session-only; idempotent against a rolling
// activity window that overlaps every poll.
import { describe, it, expect, beforeEach } from "vitest";
import type { ActivityEntry } from "./api";
import {
  logSentence,
  logTime,
  recordActivity,
  resetRoadieLog,
  roadieStanding,
  roadieLogSnapshot as read,
  roadieLogSeenSize as seenSize,
} from "./roadieLog";

beforeEach(() => resetRoadieLog());

const entry = (over: Partial<ActivityEntry> = {}): ActivityEntry => ({
  curatorId: "abc12345",
  from: "generating_palette",
  to: "awaiting_review",
  at: "2026-08-04T19:04:00.000Z",
  ...over,
});

const titles: Record<string, string> = { abc12345: "Kind of Blue" };
const titleOf = (id: string) => titles[id] ?? null;

/**
 * `n` distinct transitions in the shape the server actually sends them: **newest first**
 * (`activity.unshift` in `roadie/worker.ts`). Getting this backwards makes `recordActivity` keep the
 * oldest lines and slice the newest off — which is what a first draft of this helper did.
 */
const manyEntries = (n: number): ActivityEntry[] =>
  Array.from({ length: n }, (_, i) =>
    entry({
      at: new Date(Date.UTC(2026, 7, 4, 0, 0, n - 1 - i)).toISOString(),
    }),
  );

describe("logSentence", () => {
  it("names the album, never the state or the id", () => {
    expect(
      logSentence("generating_palette", "awaiting_review", "Kind of Blue"),
    ).toEqual({
      before: "Pulled the lights from ",
      album: "Kind of Blue",
      after: "",
      failed: false,
    });
  });

  it("distinguishes reaching review via drafting from reaching it directly", () => {
    // Drafting is on request (ADR 0027), so review is reached from either step and the sentence
    // must say which actually happened.
    expect(
      logSentence("drafting_prompts", "awaiting_review", "Aja")?.before,
    ).toBe("Drafted the prompts for ");
    expect(
      logSentence("generating_palette", "awaiting_review", "Aja")?.before,
    ).toBe("Pulled the lights from ");
  });

  it("marks a failure and points at where it durably lives", () => {
    const said = logSentence(
      "downloading_art",
      "errored",
      "Rachel's Greatest Hits",
    );
    expect(said?.failed).toBe(true);
    expect(said?.after).toMatch(/stuck list/);
  });

  it("says nothing at all rather than naming a machine state", () => {
    // A human did these on a screen that already told them; there is no sentence worth the rule.
    expect(logSentence("awaiting_review", "awaiting_video", "Aja")).toBeNull();
    expect(logSentence("awaiting_video", "awaiting_preview", "Aja")).toBeNull();
  });

  it("never leaks a machine state name into any sentence it does write", () => {
    const every = (
      [
        "fetching_metadata",
        "downloading_art",
        "generating_palette",
        "drafting_prompts",
        "awaiting_review",
        "verified",
        "errored",
        "needs_manual",
      ] as const
    )
      .map((to) => logSentence("fresh", to, "X"))
      .filter(Boolean)
      .map((s) => `${s!.before}${s!.after}`)
      .join(" | ");
    expect(every).not.toMatch(/_|awaiting|palette|metadata/i);
  });
});

describe("recordActivity", () => {
  const window = [
    entry(),
    entry({
      at: "2026-08-04T19:03:00.000Z",
      from: "downloading_art",
      to: "generating_palette",
    }),
  ];

  it("folds the same rolling window in repeatedly without duplicating a line", () => {
    recordActivity(window, titleOf);
    recordActivity(window, titleOf);
    expect(read()).toHaveLength(2);
  });

  it("puts the newest line first", () => {
    recordActivity(window, titleOf);
    expect(read()[0]!.before).toBe("Pulled the lights from ");
    expect(read()[1]!.before).toBe("Found the sleeve for ");
  });

  it("skips a record it can't name — the id is exactly what must not be shown", () => {
    recordActivity([entry({ curatorId: "deleted99" })], titleOf);
    expect(read()).toHaveLength(0);
  });

  it("skips transitions with nothing to say", () => {
    recordActivity(
      [entry({ from: "awaiting_review", to: "awaiting_video" })],
      titleOf,
    );
    expect(read()).toHaveLength(0);
  });

  it("is bounded — a long session must not grow it without limit", () => {
    recordActivity(manyEntries(200), titleOf);
    expect(read().length).toBeLessThanOrEqual(60);
  });

  it("bounds the dedup set too, not just the lines it keeps", () => {
    // The set grows once per transition Roadie makes rather than once per line kept, so the line cap
    // does not trim it. Curator stays open for days.
    recordActivity(manyEntries(1200), titleOf);
    expect(seenSize()).toBeLessThanOrEqual(500);
  });

  it("still refuses a duplicate the server is currently replaying", () => {
    // Eviction must never re-admit a line already on screen. The server's window is 20 entries, so
    // the newest handful has to survive an overflow that dropped hundreds of older ids.
    //
    // Asserted on identity, not length: `lines` is capped, so re-admitting a duplicate pushes an old
    // line off the end and leaves the count unchanged. A length check here passes with the bound set
    // to 5 — which is to say it checks nothing.
    const all = manyEntries(1200);
    recordActivity(all, titleOf);
    const before = read().map((l) => l.id);
    // The server's window is the newest 20 — the front of a newest-first list.
    recordActivity(all.slice(0, 20), titleOf);
    expect(read().map((l) => l.id)).toEqual(before);
    expect(new Set(before).size).toBe(before.length);
  });

  it("starts empty again after a reset — the log is session-only", () => {
    recordActivity([entry()], titleOf);
    expect(read()).toHaveLength(1);
    resetRoadieLog();
    expect(read()).toHaveLength(0);
  });
});

describe("logTime", () => {
  it("is a 24-hour wall clock", () => {
    expect(logTime("2026-08-04T19:04:00.000Z", "en-GB")).toMatch(
      /^\d{2}:\d{2}$/,
    );
  });

  it("renders nothing for an unparseable timestamp rather than 'Invalid Date'", () => {
    expect(logTime("not a date")).toBe("");
  });
});

describe("roadieStanding", () => {
  const at = (over: Partial<Parameters<typeof roadieStanding>[0]> = {}) =>
    roadieStanding({ paused: false, current: null, queueDepth: 0, ...over });

  it("says idle when the queue is empty and nothing is in hand", () => {
    // The whole point: a finished Roadie and a wedged one produce an identical, frozen log line, so
    // the strip has to say which it is (ADR 0057).
    expect(at()).toEqual({ label: "IDLE · NOTHING QUEUED", busy: false });
  });

  it("says what is left while Roadie is working", () => {
    expect(at({ current: "abc12345", queueDepth: 12 })).toEqual({
      label: "WORKING · 12 QUEUED",
      busy: true,
    });
    // Last one in hand, nothing behind it — a count of zero would read as "nothing to do".
    expect(at({ current: "abc12345" })).toEqual({
      label: "WORKING",
      busy: true,
    });
  });

  it("counts a queue with nothing in hand as working, not idle", () => {
    // The gap between `enqueue` and the worker picking it up. Reporting idle here would be a lie
    // that lasts exactly as long as it takes someone to notice and mistrust the strip.
    expect(at({ queueDepth: 3 })).toEqual({
      label: "WORKING · 3 QUEUED",
      busy: true,
    });
  });

  it("says paused, and is not busy, even with work waiting", () => {
    // Paused with a full queue is the one state where "nothing is happening" is true *and* there is
    // work — so it must not read as either idle or working.
    expect(at({ paused: true, queueDepth: 9, current: "abc12345" })).toEqual({
      label: "PAUSED",
      busy: false,
    });
  });

  it("claims nothing before the first poll answers", () => {
    // `IDLE` on first paint would be a claim we cannot make yet — and it is the exact claim the user
    // is now being asked to trust.
    expect(roadieStanding(null)).toEqual({ label: "CHECKING…", busy: false });
  });

  it("never leans on the dot alone — every state carries a word", () => {
    // curator-ui-ux §3.4: state is never encoded in colour or motion alone. The pulse is decoration
    // on top of the label, never the signal.
    for (const s of [
      null,
      { paused: false, current: null, queueDepth: 0 },
      { paused: false, current: "a", queueDepth: 2 },
      { paused: true, current: null, queueDepth: 0 },
    ])
      expect(roadieStanding(s).label.trim().length).toBeGreaterThan(0);
  });
});
