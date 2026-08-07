// Pure presentation helpers — no React, no DOM — so they're trivially unit-testable.
//
// **Trimmed 2026-08-05 (ADR 0052).** This file used to be the queue's vocabulary: `STATE_LABEL`
// spelling out all thirteen Roadie states, `STEPPER` / `stepperIndex` for the five-step score,
// `QUEUE_SECTIONS` / `QUEUE_LABEL` for the nine buckets, and `NEXT_ACTION` for the row links. Every
// one of those named a machine state at the user, which the overhaul forbids — what a record still
// needs now lives in `needs.ts`, derived from its assets. They went with the screens that read them.
//
// What remains is the part that was never about the state machine: whether Roadie currently holds a
// record, and how long ago something happened.
import type { RoadieState } from "./api";

/**
 * The states in which Roadie owns the record and a human can't act on it.
 *
 * Still the machine's own list, deliberately: this is the one question the UI genuinely has to ask
 * of `roadie.state`, and `needs.ts` asks it here rather than growing a second copy. The *words* the
 * user sees for these come from `roadieNarration`, which never repeats a state name.
 */
export const PROCESSING_STATES: RoadieState[] = [
  "fresh",
  "fetching_metadata",
  "downloading_art",
  "generating_palette",
  "drafting_prompts",
];

export const isProcessing = (s: RoadieState): boolean =>
  PROCESSING_STATES.includes(s);

/** Compact "3m ago" / "2h ago" / "just now" from an ISO timestamp. */
export function relativeTime(iso: string, now: number = Date.now()): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const secs = Math.max(0, Math.round((now - then) / 1000));
  if (secs < 45) return "a moment ago";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

/**
 * True when the palette was (re)generated or hand-edited *after* a prompt was drafted, so the
 * prompt's embedded hex colors are now out of date. Both timestamps are ISO-8601 UTC, so a lexical
 * string compare is chronological. Absent timestamps → not stale (nothing to compare).
 */
export const promptIsStale = (
  paletteGeneratedAt: string | undefined,
  promptGeneratedAt: string | undefined,
): boolean =>
  paletteGeneratedAt != null &&
  promptGeneratedAt != null &&
  promptGeneratedAt < paletteGeneratedAt;
