// Pure presentation helpers — no React, no DOM — so they're trivially unit-testable.
import type { RoadieState, QueueBucket } from "./api";

/** Human label for each Roadie state. */
export const STATE_LABEL: Record<RoadieState, string> = {
  fresh: "Queued",
  fetching_metadata: "Fetching metadata",
  downloading_art: "Downloading art",
  generating_palette: "Generating palette",
  drafting_prompts: "Drafting prompts",
  awaiting_review: "Awaiting review",
  awaiting_video: "Awaiting video",
  awaiting_preview: "Awaiting preview",
  awaiting_tag_write: "Awaiting tag write",
  awaiting_verify: "Awaiting verification",
  verified: "Verified",
  errored: "Errored",
  needs_manual: "Needs manual",
};

/** The onboarding stepper, in order — the milestones a human walks an album through (spec §10). */
export const STEPPER: RoadieState[] = [
  "awaiting_review",
  "awaiting_video",
  "awaiting_preview",
  "awaiting_tag_write",
  "awaiting_verify",
  "verified",
];

export const QUEUE_SECTIONS: Array<{ bucket: QueueBucket; label: string }> = [
  { bucket: "awaiting_review", label: "Awaiting review" },
  { bucket: "awaiting_video", label: "Awaiting video" },
  { bucket: "awaiting_preview", label: "Awaiting preview" },
  { bucket: "awaiting_tag_write", label: "Awaiting tag write" },
  { bucket: "awaiting_verify", label: "Awaiting verification" },
];

export const PROCESSING_STATES: RoadieState[] = [
  "fresh",
  "fetching_metadata",
  "downloading_art",
  "generating_palette",
  "drafting_prompts",
];

export const isProcessing = (s: RoadieState): boolean =>
  PROCESSING_STATES.includes(s);

/**
 * Where an album sits on the stepper: the index of `state`, or — while Roadie is still processing —
 * -1 (nothing done yet), so the stepper renders all steps as upcoming. `verified` is the last index.
 */
export function stepperIndex(state: RoadieState): number {
  if (isProcessing(state)) return -1;
  const i = STEPPER.indexOf(state);
  return i; // -1 for errored/needs_manual (off the happy path)
}

/** Compact "3m ago" / "2h ago" / "just now" from an ISO timestamp. */
export function relativeTime(iso: string, now: number = Date.now()): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const secs = Math.max(0, Math.round((now - then) / 1000));
  if (secs < 45) return "just now";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

/** The next action label for an album parked in a human/terminal state (mirrors the API's status). */
export const NEXT_ACTION: Partial<Record<RoadieState, string>> = {
  awaiting_review: "Review palette",
  awaiting_video: "Attach video",
  awaiting_preview: "Preview & approve",
  awaiting_tag_write: "Write tag",
  awaiting_verify: "Verify physically",
  errored: "Retry",
  needs_manual: "Resolve manually",
};
