// A tiny in-memory job model for the long-running AI generation actions (issue #30 / ADR 0018).
// Card-art and (especially) video generation take minutes; holding the HTTP request open for that
// is fragile (proxy/browser timeouts, no progress, a reload loses the result). Instead the route
// starts a job and returns a `jobId` immediately; the UI polls `GET /api/jobs/:id`.
//
// In-memory is deliberate (issue #30: "in-memory is fine to start"): generation is a human-triggered
// convenience, not durable pipeline state — a lost job on restart just means clicking generate again.
// Roadie's queue is untouched (roadie-spec §15: generation lives outside the queue).
import { randomUUID } from "node:crypto";
import type { VideoClip, CardArtCandidate } from "../albums/asset.js";

export type JobKind = "video" | "cardArt";
export type JobStatus = "running" | "done" | "failed";

/** What a finished job produced — the same payloads the synchronous routes used to return. */
export interface JobResult {
  videoClips?: VideoClip[];
  cardArtCandidates?: CardArtCandidate[];
}

export interface GenerationJob {
  id: string;
  kind: JobKind;
  curatorId: string;
  status: JobStatus;
  /** e.g. `{ done: 3, total: 5 }` — the UI shows "Generating 3/5…". */
  progress: { done: number; total: number };
  createdAt: string;
  updatedAt: string;
  /** Set when `status === "failed"`. */
  error?: string;
  /** Set when `status === "done"`. */
  result?: JobResult;
}

/** The work a job performs. Reports progress as items finish; resolves with the result payload. */
export type JobRunner = (ctx: {
  onProgress: (done: number, total: number) => void;
}) => Promise<JobResult>;

export interface JobManagerOptions {
  now?: () => string;
  /** How long a terminal (done/failed) job is retained before GC. Default 30 min. */
  ttlMs?: number;
}

/** Public view of a job (the map value is mutated in place; callers get a snapshot copy). */
const snapshot = (j: GenerationJob): GenerationJob => ({
  ...j,
  progress: { ...j.progress },
  ...(j.result ? { result: j.result } : {}),
});

export class GenerationJobs {
  private readonly jobs = new Map<string, GenerationJob>();
  private readonly now: () => string;
  private readonly ttlMs: number;

  constructor(opts: JobManagerOptions = {}) {
    this.now = opts.now ?? (() => new Date().toISOString());
    this.ttlMs = opts.ttlMs ?? 30 * 60 * 1000;
  }

  /** A job by id, or undefined if unknown/expired. */
  get(id: string): GenerationJob | undefined {
    this.gc();
    const j = this.jobs.get(id);
    return j ? snapshot(j) : undefined;
  }

  /** Active + recent jobs for an album, newest first — lets the UI re-attach after a reload. */
  forAlbum(curatorId: string, kind?: JobKind): GenerationJob[] {
    this.gc();
    return [...this.jobs.values()]
      .filter((j) => j.curatorId === curatorId && (!kind || j.kind === kind))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(snapshot);
  }

  private running(curatorId: string, kind: JobKind): GenerationJob | undefined {
    return [...this.jobs.values()].find(
      (j) =>
        j.curatorId === curatorId &&
        j.kind === kind &&
        j.status === "running",
    );
  }

  /**
   * Start a job. If one is already running for the same album+kind, returns it instead of launching
   * a duplicate multi-minute run (clicking generate twice is a no-op, and a reload re-attaches to the
   * live job rather than starting a second). Returns immediately; the runner drives in the background.
   */
  start(kind: JobKind, curatorId: string, run: JobRunner): GenerationJob {
    const existing = this.running(curatorId, kind);
    if (existing) return snapshot(existing);

    const at = this.now();
    const job: GenerationJob = {
      id: randomUUID(),
      kind,
      curatorId,
      status: "running",
      progress: { done: 0, total: 0 },
      createdAt: at,
      updatedAt: at,
    };
    this.jobs.set(job.id, job);
    void this.drive(job, run);
    return snapshot(job);
  }

  private async drive(job: GenerationJob, run: JobRunner): Promise<void> {
    try {
      const result = await run({
        onProgress: (done, total) => {
          job.progress = { done, total };
          job.updatedAt = this.now();
        },
      });
      job.status = "done";
      job.result = result;
    } catch (err) {
      job.status = "failed";
      job.error = err instanceof Error ? err.message : String(err);
    }
    job.updatedAt = this.now();
  }

  /** Drop terminal jobs past their TTL so the map doesn't grow unbounded over a long-lived process. */
  private gc(): void {
    const cutoff = Date.now() - this.ttlMs;
    for (const [id, j] of this.jobs) {
      if (j.status === "running") continue;
      if (Date.parse(j.updatedAt) < cutoff) this.jobs.delete(id);
    }
  }
}
