// What the System screen says, in words (ADR 0052).
//
// The old page's centrepiece was a matrix — every album × every host — which answers "is everything
// fine?" by making you read thirteen rows and compare ticks. This derives the exceptions instead, so
// the screen is as long as the number of things actually wrong.
//
// Pure, no React.
import type { AlbumPresence, JobTransfer, ServiceHealth } from "./api";
import { etaSeconds, formatBytes, humanEta } from "./transfer";

/**
 * What each service *is*, for someone who did not write it. The name alone ("Backdrop") says nothing
 * about which part of the room stops working when its dot goes red.
 */
export const SERVICE_GLOSS: Record<ServiceHealth["service"], string> = {
  conductor: "the lights",
  backdrop: "the screen",
  stylus: "the stand",
  amp: "the sound",
};

/** `:4741` — the part of a service URL worth showing. The host is nearly always the same machine. */
export function servicePort(url: string | undefined): string {
  if (!url) return "";
  try {
    const u = new URL(url);
    return u.port ? `:${u.port}` : u.host;
  } catch {
    return url;
  }
}

/**
 * A service's state, as a word.
 *
 * `configured:false` and `reachable:false` are deliberately different things upstream — "you never
 * set this up" and "it's down" have different fixes — and the screen keeps them apart.
 */
export type ServiceState = "up" | "down" | "unset";

export const serviceState = (s: ServiceHealth): ServiceState =>
  !s.configured ? "unset" : s.reachable ? "up" : "down";

/** The gloss, plus what is wrong with it when something is. */
export function serviceLine(s: ServiceHealth): string {
  const gloss = SERVICE_GLOSS[s.service];
  if (!s.configured) return `${gloss} — not set up`;
  if (!s.reachable) return `${gloss} — not answering`;
  return gloss;
}

/**
 * Why a record is not everywhere it should be, or null when it is.
 *
 * **What "should be" means depends on whether it has a visualizer.** A record with no clip belongs on
 * Conductor and nowhere else, so requiring it on Backdrop too would put every unfinished record on
 * this list and drown the real failures — which is what the old page's per-row "Ready" did.
 */
export function presenceProblem(a: AlbumPresence): string | null {
  if (!a.onConductor) return "NOT ON CONDUCTOR";
  if (!a.hasVideo) return null;
  if (!a.inBackdropLibrary) return "NOT IN BACKDROP'S LIBRARY";
  if (!a.videoOnBackdrop) return "NO VISUALIZER ON BACKDROP";
  return null;
}

export interface Exception {
  album: AlbumPresence;
  problem: string;
}

/** Exceptions only. An empty list is the good news, and the screen says so in words. */
export const exceptions = (albums: readonly AlbumPresence[]): Exception[] =>
  albums.flatMap((album) => {
    const problem = presenceProblem(album);
    return problem ? [{ album, problem }] : [];
  });

/** `3/13` for a countable job, `68%` for one measured in bytes. */
export function jobProgress(kind: string, done: number, total: number): string {
  if (total <= 0) return "…";
  return kind === "mediaTransfer"
    ? `${Math.min(100, Math.round((done / total) * 100))}%`
    : `${done}/${total}`;
}

/** What a running job is doing, in words rather than its kind. */
export const JOB_LABEL: Record<string, string> = {
  mediaTransfer: "visualizer upload",
  runtimeSync: "media-sync",
  paletteBatch: "re-reading the lights",
  discogsSync: "discogs sync",
  video: "making a visualizer",
  cardArt: "drawing card art",
};

/**
 * The upload line under a running sync: what is moving, how far it has got, and — once there is
 * enough history to be honest about it — how much longer.
 *
 * Its own line rather than a second number on the job row, because the two answer different
 * questions. The job row says how much of the *library* is done; this says whether the *file* is
 * moving at all. On 2026-08-08 a sync spent 47 minutes on one visualizer over a bad link, and with
 * only the album counter on screen there was no way to tell that from a wedged process.
 *
 * The percentage is not in here: it goes in the row's count column, where the job row above puts
 * its own, so the two line up rather than one hiding mid-sentence.
 */
export function transferLine(t: JobTransfer, nowMs: number): string {
  const base = `${t.label} — ${formatBytes(t.sent)} of ${formatBytes(t.total)}`;
  const eta = etaSeconds(t.sent, t.total, nowMs - Date.parse(t.startedAt));
  // `etaSeconds` returns null until an estimate is worth showing; a guess made from two bytes is
  // worse than no guess, because it will be believed (issue #177).
  return eta === null ? base : `${base} · ${humanEta(eta)}`;
}

/** How full the upload's own bar is. Clamped: a total that lies must not overflow the track. */
export const transferPercent = (t: JobTransfer): number =>
  t.total > 0 ? Math.min(100, Math.round((t.sent / t.total) * 100)) : 0;
