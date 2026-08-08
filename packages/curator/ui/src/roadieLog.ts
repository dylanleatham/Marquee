// Roadie's log — what Roadie has done since Curator started (ADR 0052).
//
// **Session-only, and deliberately so.** It is not persisted and it is not fetched as history; it
// accumulates from the activity feed the status poll already returns, and it is gone on restart.
// Nothing important depends on it: a record that *failed* lives durably in the collection's Stuck
// group, which is where you go to fix it. The log is for glancing at, not for auditing.
//
// The server's feed is machine-shaped — `{ curatorId, from, to, at }`. Turning it into "Pulled the
// lights from **Kind of Blue**" is this module's whole job, because ADR 0052 forbids showing a state
// name or an id anywhere in the UI.
import { useSyncExternalStore } from "react";
import type { ActivityEntry, AgentStatus, RoadieState } from "./api";

/**
 * One line of the log, already split around the album title so the component can bold it without
 * parsing a sentence back apart.
 */
export interface LogLine {
  /** Stable across polls — the same transition must not be appended twice. */
  id: string;
  at: string;
  before: string;
  album: string;
  after: string;
  /** Drawn in the accent. A failure here is a pointer; the Stuck group is the durable record. */
  failed: boolean;
}

/**
 * The sentence for one transition, or `null` for one that has nothing to say.
 *
 * Returning `null` is the important case: the alternative to "no line" is a line naming a machine
 * state, and there is no transition worth breaking that rule for. Human-driven steps are left out
 * too — you were there, and the screen you did it on already told you.
 */
export function logSentence(
  from: RoadieState,
  to: RoadieState,
  album: string,
): Omit<LogLine, "id" | "at"> | null {
  const say = (before: string, after = "", failed = false) => ({
    before,
    album,
    after,
    failed,
  });
  switch (to) {
    case "fetching_metadata":
      return say("Looking up ");
    case "downloading_art":
      return say("Matched ", " — finding the sleeve");
    case "generating_palette":
      return say("Found the sleeve for ");
    case "drafting_prompts":
      return say("Pulled the lights from ");
    case "awaiting_review":
      // Prompt drafting is on request (ADR 0027), so review is reached from either step.
      return from === "drafting_prompts"
        ? say("Drafted the prompts for ")
        : say("Pulled the lights from ");
    case "verified":
      return say("", " is ready");
    case "errored":
      return say("Gave up on ", " — it's in the stuck list", true);
    case "needs_manual":
      return say("", " needs sorting out by hand", true);
    default:
      return null;
  }
}

/**
 * Where Roadie stands right now — the strip's own state, as distinct from what it has *done*.
 *
 * This exists because a finished Roadie and a wedged one looked identical. Roadie moves a record
 * through in ~130ms, so a whole sync's transitions land in the same minute; the log renders at
 * `HH:MM` and then simply stops changing. On a 499-record sync that read as "Roadie died halfway",
 * and it sent us hunting for a stalled pipeline that had in fact finished (ADR 0056, ADR 0057).
 *
 * **The word is the signal, never the dot.** The dot stops pulsing when Roadie is idle, but a
 * pulsing and a still dot are the same shape and nearly the same colour — this project's own user is
 * colour-blind, and curator-ui-ux §3.4 makes the pairing a rule rather than a courtesy.
 *
 * Each label is literally true of the state it names: `IDLE · NOTHING QUEUED` claims only that
 * Roadie's queue is empty, not that the *collection* is finished — 482 records can still want your
 * eyes. Claiming "all caught up" here would repeat the mistake in the other direction.
 */
export interface RoadieStanding {
  /** The mono word in the strip. */
  label: string;
  /** Roadie is actually doing something. Drives the pulse, and only the pulse. */
  busy: boolean;
}

export function roadieStanding(
  status: Pick<AgentStatus, "paused" | "current" | "queueDepth"> | null,
): RoadieStanding {
  // Before the first poll answers we know nothing, and "IDLE" would be a claim we can't make yet.
  if (!status) return { label: "CHECKING…", busy: false };
  if (status.paused) return { label: "PAUSED", busy: false };
  if (!status.current && status.queueDepth === 0)
    return { label: "IDLE · NOTHING QUEUED", busy: false };
  return {
    label: status.queueDepth
      ? `WORKING · ${status.queueDepth} QUEUED`
      : "WORKING",
    busy: true,
  };
}

/** Bounded: a long session must not grow this without limit, and nothing reads past the first few. */
const CAP = 60;

/**
 * And so is the dedup set. It grows once per *transition Roadie makes*, not once per line kept — so
 * unlike `lines` it is not naturally trimmed by the cap above, and Curator is meant to stay open for
 * days.
 *
 * Sized far above the server's own activity window (20 entries, `ACTIVITY_CAP` in `roadie/worker.ts`)
 * on purpose: an id only falls out of here once it is hundreds of transitions old, by which point the
 * server cannot still be returning it, so eviction can never re-admit a line that is already on
 * screen. Anything near 20 would make that a live race.
 */
const SEEN_CAP = 500;

let lines: LogLine[] = [];
/** Insertion-ordered, which is what makes "drop the oldest" a `for…of` over its own keys. */
const seen = new Set<string>();
const listeners = new Set<() => void>();

function remember(id: string): void {
  seen.add(id);
  if (seen.size <= SEEN_CAP) return;
  for (const old of seen) {
    seen.delete(old);
    if (seen.size <= SEEN_CAP) return;
  }
}

const emit = () => {
  for (const l of listeners) l();
};

/**
 * Fold a poll's worth of activity in. Idempotent: the server returns a rolling window that overlaps
 * every poll, so the same transition arrives over and over and is recognised by `id`.
 *
 * `titleOf` returns null for an album that has since been deleted — there is no sentence to write
 * without a name, and the id is exactly what must not be shown.
 */
export function recordActivity(
  activity: readonly ActivityEntry[],
  titleOf: (curatorId: string) => string | null,
): void {
  let added = false;
  // Oldest first, so the accumulated list stays in order as it is unshifted onto.
  for (const e of [...activity].reverse()) {
    const id = `${e.curatorId}:${e.at}:${e.to}`;
    if (seen.has(id)) continue;
    remember(id);
    const title = titleOf(e.curatorId);
    if (!title) continue;
    const said = logSentence(e.from, e.to, title);
    if (!said) continue;
    lines = [{ id, at: e.at, ...said }, ...lines].slice(0, CAP);
    added = true;
  }
  if (added) emit();
}

const EMPTY: LogLine[] = [];

/**
 * The published snapshot, newest first. Referentially stable between folds, which is what lets
 * `useSyncExternalStore` use it directly.
 */
export const roadieLogSnapshot = (): LogLine[] => lines;

const subscribe = (cb: () => void): (() => void) => {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
};

/** Newest first. Empty until Roadie does something — the log genuinely starts blank each session. */
export const useRoadieLog = (): LogLine[] =>
  useSyncExternalStore(subscribe, roadieLogSnapshot, () => EMPTY);

/** Test seam. Also what "cleared when Curator restarts" means, mechanically. */
export function resetRoadieLog(): void {
  lines = [];
  seen.clear();
  emit();
}

/** Test seam: how much the dedup set is holding, so its bound is assertable rather than assumed. */
export const roadieLogSeenSize = (): number => seen.size;

/** "19:04" — a wall-clock time, because the log is read as "what just happened". */
export function logTime(iso: string, locale?: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString(locale, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}
