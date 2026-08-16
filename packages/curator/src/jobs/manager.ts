// A tiny in-memory job model for the long-running AI generation actions (issue #30 / ADR 0018).
// Card-art and (especially) video generation take minutes; holding the HTTP request open for that
// is fragile (proxy/browser timeouts, no progress, a reload loses the result). Instead the route
// starts a job and returns a `jobId` immediately; the UI polls `GET /api/jobs/:id`.
//
// Cancel + persistence (issue #57): each running job carries an AbortController; `cancel(id)` aborts
// its runner (which threads the signal into the Gemini fetch) and marks it `cancelled`. An optional
// on-disk JobStore survives a Curator restart so the UI can still see recent jobs — a job that was
// mid-flight when the process died can't be resumed (its runner is gone), so it's restored as failed.
// Roadie's queue is untouched (roadie-spec §15: generation lives outside the queue).
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { VideoClip, CardArtCandidate } from "../albums/asset.js";
import type { SpotifyBackfillReport } from "../albums/spotify-backfill.js";
import type { BatchPaletteReport } from "../albums/batch.js";
import type { DiscogsSyncReport } from "../albums/discogs-sync.js";

export type JobKind =
  | "video"
  | "cardArt"
  | "paletteBatch"
  | "mediaTransfer"
  /** Pushing the whole library to the runtime (ADR 0045). Library-scoped: no curatorId. */
  | "runtimeSync"
  /** Sweeping the Discogs collection into the library (issue #234). Library-scoped: no curatorId. */
  | "discogsSync"
  /** Re-matching Discogs albums to Spotify so they can play (ADR 0059). Library-scoped. */
  | "spotifyBackfill"
  /**
   * Sending the default visualizer to Backdrop (ADR 0074). Library-scoped: the clip belongs to the
   * collection, not to an album — and it is a file transfer over the LAN, which on a poor link is
   * the same tens-of-minutes wait that put album media in a job (issue #177).
   */
  | "defaultVisualizerPush";
export type JobStatus = "running" | "done" | "failed" | "cancelled";

/** What one runtime service made of a full push (ADR 0045). */
export interface RuntimeSyncLeg {
  pushed: number;
  failures: Array<{ curatorId: string; error: string }>;
}

/** What a finished job produced — the same payloads the synchronous routes used to return. */
export interface JobResult {
  videoClips?: VideoClip[];
  cardArtCandidates?: CardArtCandidate[];
  paletteBatch?: BatchPaletteReport;
  /** What one Discogs collection sweep added, skipped as already-present, and failed on (issue #234). */
  discogsSync?: DiscogsSyncReport;
  /** What one Spotify-identity backfill matched, and how confidently (ADR 0059). */
  spotifyBackfill?: SpotifyBackfillReport;
  /**
   * A full runtime push, per service. `backdrop` is absent when no Backdrop is configured, which is
   * a different thing from one that pushed nothing — the distinction issue #187 was about.
   */
  runtimeSync?: {
    conductor: RuntimeSyncLeg;
    backdrop?: {
      pushed: number;
      mediaTransfer: "none" | "local" | "push";
      media: { transferred: number; unchanged: number; skipped: number };
      failures: Array<{ curatorId: string; error: string }>;
    };
    /**
     * The tag-writing queue as written to a Flipper on USB. A **discriminated** result rather than
     * presence-or-absence: "no Flipper on the desk" is the ordinary case here, not a failure, and it
     * has to be tellable from "wrote an empty list because nothing is awaiting a tag" — the same
     * distinction issue #187 drew for Backdrop. `overflowed` counts rows past the FAP's own cap,
     * which the device would otherwise drop without saying so.
     */
    flipper?:
      | {
          attached: true;
          albums: number;
          overflowed: number;
          port: string;
          bytes: number;
          path: string;
        }
      | { attached: false; reason: string };
  };
}

/**
 * One file in flight, in bytes. `startedAt` is here rather than derived in the UI because an ETA
 * needs a start the client did not witness — a page opened mid-upload would otherwise have to guess,
 * and `transfer.ts` deliberately returns null rather than guess (issue #177).
 */
export interface JobTransfer {
  /** What is moving, in the words the page already uses for an album — its name. */
  label: string;
  sent: number;
  total: number;
  startedAt: string;
}

export interface GenerationJob {
  id: string;
  kind: JobKind;
  /**
   * The album this job works on. **Absent for a library-scoped job** — a batch palette regeneration
   * sweeps the whole collection and belongs to no one album (ADR 0029). Encoding that as a sentinel
   * id would leak a fake album into every filter; absence says it plainly.
   */
  curatorId?: string;
  status: JobStatus;
  /**
   * The prompt-variant index this job generates, for a *per-prompt* generation (ADR 0021/0022); a
   * whole-set job leaves it undefined. Part of the dedup key, so a per-clip job and the set job (and
   * two different per-clip jobs) run side by side instead of one shadowing the other.
   */
  index?: number;
  /** e.g. `{ done: 3, total: 5 }` — the UI shows "Generating 3/5…". */
  progress: { done: number; total: number };
  /**
   * The file currently moving, when a job is streaming bytes — a visualizer upload inside a
   * `runtimeSync`.
   *
   * A **separate channel from `progress` on purpose.** These are bytes; `progress` counts
   * album-legs. Sharing one field is precisely the bug that made a running sync read `24248819/998`
   * ([#268](https://github.com/dylanleatham/Marquee/issues/268)), so the two units get two fields
   * and the display never has to guess which it is holding.
   *
   * Absent whenever nothing is in flight, which is most of the time: a sync spends the Conductor leg
   * and every skipped album with no transfer to report.
   */
  transfer?: JobTransfer;
  createdAt: string;
  updatedAt: string;
  /** Set when `status === "failed"` (or a restart-interrupted job). */
  error?: string;
  /** Set when `status === "done"`. */
  result?: JobResult;
}

/**
 * The work a job performs. Reports progress as items finish; resolves with the result payload. The
 * `signal` aborts when the job is cancelled — runners thread it into their cancellable calls (the
 * Gemini client's fetch) so an in-flight generation stops rather than running to completion.
 */
export type JobRunner = (ctx: {
  onProgress: (done: number, total: number) => void;
  /**
   * Report the file currently streaming, or `null` when none is. Separate from `onProgress` because
   * the units differ — see `GenerationJob.transfer`.
   */
  onTransfer: (transfer: Omit<JobTransfer, "startedAt"> | null) => void;
  signal: AbortSignal;
}) => Promise<JobResult>;

/** Persistence seam: load/save the serializable job list. Injected so it's unit-testable without fs. */
export interface JobStore {
  load(): GenerationJob[];
  save(jobs: GenerationJob[]): void;
}

/** A file-backed JobStore (a single JSON array). Best-effort: a corrupt/missing file loads as empty. */
export class FileJobStore implements JobStore {
  constructor(private readonly file: string) {}
  load(): GenerationJob[] {
    if (!existsSync(this.file)) return [];
    const parsed = JSON.parse(readFileSync(this.file, "utf8")) as unknown;
    return Array.isArray(parsed) ? (parsed as GenerationJob[]) : [];
  }
  save(jobs: GenerationJob[]): void {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(jobs, null, 2) + "\n");
  }
}

export interface JobManagerOptions {
  now?: () => string;
  /** How long a terminal (done/failed/cancelled) job is retained before GC. Default 30 min. */
  ttlMs?: number;
  /** Optional on-disk persistence so jobs survive a restart (issue #57). */
  store?: JobStore;
}

/** Public view of a job (the map value is mutated in place; callers get a snapshot copy). */
const snapshot = (j: GenerationJob): GenerationJob => ({
  ...j,
  progress: { ...j.progress },
  ...(j.transfer ? { transfer: { ...j.transfer } } : {}),
  ...(j.result ? { result: j.result } : {}),
});

export class GenerationJobs {
  private readonly jobs = new Map<string, GenerationJob>();
  /** Per-running-job abort handles — not part of the serializable job, kept alongside it. */
  private readonly controllers = new Map<string, AbortController>();
  private readonly now: () => string;
  private readonly ttlMs: number;
  private readonly store?: JobStore;

  constructor(opts: JobManagerOptions = {}) {
    this.now = opts.now ?? (() => new Date().toISOString());
    this.ttlMs = opts.ttlMs ?? 30 * 60 * 1000;
    this.store = opts.store;
    this.restore();
  }

  /** Load persisted jobs on boot. A job left `running` can't be resumed (its runner died with the
   * process), so it's restored as a failed "interrupted" job rather than a zombie that never ends. */
  private restore(): void {
    if (!this.store) return;
    let saved: GenerationJob[];
    try {
      saved = this.store.load();
    } catch {
      return; // unreadable/corrupt log — start clean rather than crash
    }
    let normalized = false;
    for (const j of saved) {
      if (j.status === "running") {
        this.jobs.set(j.id, {
          ...j,
          status: "failed",
          error: "interrupted by a Curator restart",
          updatedAt: this.now(),
        });
        normalized = true;
      } else {
        this.jobs.set(j.id, j);
      }
    }
    if (normalized) this.persist();
  }

  private persist(): void {
    if (!this.store) return;
    try {
      this.store.save([...this.jobs.values()].map(snapshot));
    } catch {
      // best-effort: a failed persist must not break generation (in-memory state is authoritative)
    }
  }

  /** A job by id, or undefined if unknown/expired. */
  get(id: string): GenerationJob | undefined {
    this.gc();
    const j = this.jobs.get(id);
    return j ? snapshot(j) : undefined;
  }

  /**
   * Active + recent jobs for an album, newest first — lets the UI re-attach after a reload. A
   * library-scoped job never matches (its `curatorId` is undefined), which is right: a collection-wide
   * sweep is not any one album's job.
   */
  forAlbum(curatorId: string, kind?: JobKind): GenerationJob[] {
    this.gc();
    return [...this.jobs.values()]
      .filter((j) => j.curatorId === curatorId && (!kind || j.kind === kind))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(snapshot);
  }

  /**
   * Active + recent **library-scoped** jobs of a kind, newest first (ADR 0029). The batch panel calls
   * this on mount to reattach to a sweep that was already running when the window reloaded.
   */
  library(kind: JobKind): GenerationJob[] {
    this.gc();
    return [...this.jobs.values()]
      .filter((j) => j.curatorId === undefined && j.kind === kind)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(snapshot);
  }

  /**
   * Every job still running, newest first, whatever its kind or album.
   *
   * The complement of `forAlbum`/`library`, which both need to know what they are looking for. The
   * system-status page needs the opposite — "is this machine busy, and with what" — and asking that
   * per album would mean one request per album in the library.
   */
  active(): GenerationJob[] {
    this.gc();
    return [...this.jobs.values()]
      .filter((j) => j.status === "running")
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(snapshot);
  }

  private running(
    curatorId: string | undefined,
    kind: JobKind,
    index?: number,
  ): GenerationJob | undefined {
    return [...this.jobs.values()].find(
      (j) =>
        j.curatorId === curatorId &&
        j.kind === kind &&
        j.index === index &&
        j.status === "running",
    );
  }

  /**
   * Start a job. If one is already running for the same album+kind (+prompt index for a per-prompt
   * job), returns it instead of launching a duplicate multi-minute run (clicking generate twice is a
   * no-op, and a reload re-attaches to the live job rather than starting a second). A per-prompt job
   * (`index` set) is keyed separately from the whole-set job and from other indices, so they don't
   * shadow each other. Returns immediately; the runner drives in the background.
   *
   * Pass `undefined` for `curatorId` to start a library-scoped job (ADR 0029). The same dedup rule
   * then means at most one sweep of that kind runs at a time — pressing the button twice reattaches
   * instead of walking the collection twice.
   */
  start(
    kind: JobKind,
    curatorId: string | undefined,
    run: JobRunner,
    index?: number,
  ): GenerationJob {
    const existing = this.running(curatorId, kind, index);
    if (existing) return snapshot(existing);

    const at = this.now();
    const job: GenerationJob = {
      id: randomUUID(),
      kind,
      ...(curatorId !== undefined ? { curatorId } : {}),
      status: "running",
      ...(index !== undefined ? { index } : {}),
      progress: { done: 0, total: 0 },
      createdAt: at,
      updatedAt: at,
    };
    const controller = new AbortController();
    this.jobs.set(job.id, job);
    this.controllers.set(job.id, controller);
    this.persist();
    void this.drive(job, run, controller);
    return snapshot(job);
  }

  /**
   * Cancel a running job: abort its runner (stopping the in-flight Gemini fetch) and mark it
   * `cancelled`. Idempotent — cancelling an unknown, done, failed, or already-cancelled job is a
   * no-op that returns the current snapshot (or undefined if unknown).
   */
  cancel(id: string): GenerationJob | undefined {
    this.gc();
    const job = this.jobs.get(id);
    if (!job) return undefined;
    if (job.status !== "running") return snapshot(job);
    this.controllers.get(id)?.abort();
    job.status = "cancelled";
    job.updatedAt = this.now();
    this.persist();
    return snapshot(job);
  }

  private async drive(
    job: GenerationJob,
    run: JobRunner,
    controller: AbortController,
  ): Promise<void> {
    try {
      const result = await run({
        onProgress: (done, total) => {
          // Ignore late progress from an already-cancelled runner winding down.
          if (job.status !== "running") return;
          job.progress = { done, total };
          job.updatedAt = this.now();
        },
        onTransfer: (transfer) => {
          if (job.status !== "running") return;
          if (!transfer) {
            delete job.transfer;
          } else {
            // The manager owns the clock (it already stamps createdAt/updatedAt), so a runner
            // reporting bytes does not need one. Carrying the start forward while a transfer is
            // present, and taking a fresh one when it was absent, relies on the runner clearing to
            // `null` between files — which `resyncAll` does in a `finally`, so it holds even when an
            // upload throws. Without that reset an ETA would be computed from the previous file's
            // start and read as wildly optimistic.
            const startedAt = job.transfer?.startedAt ?? this.now();
            job.transfer = { ...transfer, startedAt };
          }
          job.updatedAt = this.now();
        },
        signal: controller.signal,
      });
      // Cancelled mid-flight (the abort raced the resolve) — keep it cancelled, drop the result.
      if (job.status === "cancelled") return;
      job.status = "done";
      job.result = result;
    } catch (err) {
      if (job.status === "cancelled" || controller.signal.aborted) {
        job.status = "cancelled"; // an abort-induced rejection, not a real failure
      } else {
        job.status = "failed";
        job.error = err instanceof Error ? err.message : String(err);
      }
    }
    // Nothing is in flight once the runner has returned, however it returned. Left set, a job that
    // died mid-upload would sit on the page for its whole TTL claiming to be sending a file — the
    // most misleading state available, and exactly the shape of stall this panel exists to expose.
    delete job.transfer;
    job.updatedAt = this.now();
    this.controllers.delete(job.id);
    this.persist();
  }

  /** Drop terminal jobs past their TTL so the map doesn't grow unbounded over a long-lived process. */
  private gc(): void {
    const cutoff = Date.now() - this.ttlMs;
    let dropped = false;
    for (const [id, j] of this.jobs) {
      if (j.status === "running") continue;
      if (Date.parse(j.updatedAt) < cutoff) {
        this.jobs.delete(id);
        this.controllers.delete(id);
        dropped = true;
      }
    }
    if (dropped) this.persist();
  }
}
