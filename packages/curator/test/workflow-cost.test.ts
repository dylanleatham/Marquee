import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parse as parseYaml } from "yaml";

// Repo-wide invariant, hosted here for the same reason adr-numbering.test.ts and
// workflow-turbo-env.test.ts are: this is the leg CI runs (`test:unit`), and the workflows have no
// package of their own.
//
// GitHub Actions on a private free-plan repo allows 2,000 minutes a month, and this repo was
// spending roughly 15,000 (ADR 0064). The shape of the overspend was not one runaway job — it was
// four structural habits, each individually reasonable:
//
//   1. `pull_request` and `push: branches: [main]` on the same workflow, so every merged PR paid
//      twice for one tree.
//   2. No `concurrency` group, so three pushes to a branch in one minute ran three full suites to
//      completion when only the last one's answer was wanted.
//   3. A `windows-latest` leg on every PR. Windows bills at **2x**; that one job was 48% of the bill.
//   4. Five short jobs where one would do. GitHub rounds every job up to a whole billable minute, so
//      five jobs doing 90 seconds of work between them cost six minutes, most of it repeated
//      `checkout` + `pnpm install`.
//
// None of those is visible as a failure. The workflow stays green and the bill arrives at the end of
// the month — and when the allowance does run out, GitHub fails every job in 2-4 seconds with no
// logs and mails about each one, which reads like a broken repo rather than a spent budget. That
// combination — silent while it accrues, then loud and uninformative — is why this is a test and not
// a line in a doc. Adding a job is easy; adding a job that quietly costs a fifth of the month's
// allowance should not be.

const repoRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
);

/**
 * The most jobs a single PR event may fan out to, across all workflows.
 *
 * Not a law of nature — a budget. At the time of writing the PR path is four jobs (`static`,
 * `test:unit`, `test:integration`, `python`) costing about seven billable minutes. The headroom is
 * one job, so a fifth can be added deliberately; a sixth has to move this number, which is the
 * moment to check the arithmetic in ADR 0064 still holds.
 */
const MAX_PR_JOBS = 5;

/** Runner multipliers that make a job cost more than its wall-clock. GitHub's published rates. */
const EXPENSIVE_RUNNERS: Array<[pattern: RegExp, multiplier: number]> = [
  [/windows/i, 2],
  [/macos|mac-/i, 10],
];

interface WorkflowJob {
  if?: unknown;
  "runs-on"?: unknown;
  strategy?: { matrix?: Record<string, unknown> };
}
interface Workflow {
  on?: unknown;
  concurrency?: { group?: string; "cancel-in-progress"?: unknown };
  jobs?: Record<string, WorkflowJob>;
}

/** The event names a workflow's `on:` declares, in any of the three shapes YAML allows. */
function triggersOf(workflow: Workflow): string[] {
  // `on:` is the YAML 1.1 boolean `true`, so a parser that predates YAML 1.2 hands back the key
  // `true` rather than the string "on". Read both, or every check here passes vacuously.
  const on = workflow.on ?? (workflow as Record<string, unknown>)["true"];
  if (typeof on === "string") return [on];
  if (Array.isArray(on))
    return on.filter((e): e is string => typeof e === "string");
  if (on && typeof on === "object") return Object.keys(on);
  return [];
}

/** Every runner label a job can land on, expanding a `runs-on: ${{ matrix.os }}` against its matrix. */
function runnersOf(job: WorkflowJob): string[] {
  const runsOn = job["runs-on"];
  if (typeof runsOn !== "string") return [];
  const expr = runsOn.match(/^\$\{\{\s*matrix\.([\w-]+)\s*\}\}$/);
  if (!expr) return [runsOn];
  const matrix = job.strategy?.matrix ?? {};
  const values = new Set<string>();
  const base = matrix[expr[1]];
  if (Array.isArray(base)) {
    for (const v of base) if (typeof v === "string") values.add(v);
  }
  for (const entry of (matrix.include as Record<string, unknown>[]) ?? []) {
    const v = entry?.[expr[1]];
    if (typeof v === "string") values.add(v);
  }
  return [...values];
}

/**
 * How many jobs a workflow fans out to — a matrix job is as many jobs as it has legs, which is the
 * whole reason the old five-task matrix was invisible as a cost.
 */
function jobCount(job: WorkflowJob): number {
  const matrix = job.strategy?.matrix;
  if (!matrix) return 1;
  const axes = Object.entries(matrix).filter(
    ([k]) => k !== "include" && k !== "exclude",
  );
  const product = axes.reduce(
    (n, [, values]) => n * (Array.isArray(values) ? values.length : 1),
    1,
  );
  const includes = Array.isArray(matrix.include) ? matrix.include.length : 0;
  // An `include` entry that matches an existing leg refines it rather than adding one; counting them
  // all as additions over-estimates, which is the safe direction for a budget.
  return product + includes;
}

export interface CostViolation {
  workflow: string;
  problem: string;
}

/**
 * Every way the workflows can quietly cost more than intended.
 *
 * Deliberately structural — it reads triggers, runners and job counts, and never tries to guess a
 * job's runtime. Runtime is what a `timeout-minutes` is for; this catches the multipliers, the
 * duplicates and the fan-out, which is where the 7x overspend actually lived.
 */
export function costViolations(
  workflows: Record<string, string>,
): CostViolation[] {
  const found: CostViolation[] = [];
  let prJobs = 0;

  for (const [name, text] of Object.entries(workflows)) {
    const workflow = parseYaml(text) as Workflow;
    const triggers = triggersOf(workflow);
    const jobs = Object.entries(workflow.jobs ?? {});
    const onPullRequest = triggers.includes("pull_request");

    if (onPullRequest) {
      // #1: the duplicate. `pull_request` already builds PR-head merged into the current main base,
      // so a `push` trigger on the same workflow re-tests a tree that just went green.
      if (triggers.includes("push")) {
        found.push({
          workflow: name,
          problem:
            "triggers on both `pull_request` and `push` — every merged PR pays twice for one tree",
        });
      }
      // #2: superseded runs. Without this, a branch pushed three times runs three suites to the end.
      if (workflow.concurrency?.["cancel-in-progress"] !== true) {
        found.push({
          workflow: name,
          problem:
            "runs on `pull_request` without `concurrency.cancel-in-progress: true` — superseded pushes keep burning minutes",
        });
      }
      prJobs += jobs.reduce((n, [, job]) => n + jobCount(job), 0);
    }

    for (const [jobName, job] of jobs) {
      // #3: the multiplier. Fine on a nightly, ruinous on a per-PR job.
      if (onPullRequest) {
        for (const runner of runnersOf(job)) {
          const expensive = EXPENSIVE_RUNNERS.find(([pattern]) =>
            pattern.test(runner),
          );
          if (expensive) {
            found.push({
              workflow: name,
              problem: `job \`${jobName}\` runs on \`${runner}\` (${expensive[1]}x billing) on every PR — move it to nightly.yml`,
            });
          }
        }
      }
      // The kill switch only works if it reaches every job. A job that forgets the gate still fails
      // in 2-4s and still mails, which is the noise the switch exists to stop.
      if (!String(job.if ?? "").includes("CI_ENABLED")) {
        found.push({
          workflow: name,
          problem: `job \`${jobName}\` has no \`if: \${{ vars.CI_ENABLED != 'false' }}\` gate — it can't be silenced when the allowance runs out`,
        });
      }
    }
  }

  // #4: fan-out. Each job is a whole billable minute floor plus its own checkout and install.
  if (prJobs > MAX_PR_JOBS) {
    found.push({
      workflow: "(all)",
      problem: `a PR event fans out to ${prJobs} jobs, over the budget of ${MAX_PR_JOBS} — every job costs a full billable minute floor plus its own checkout + install`,
    });
  }
  return found;
}

function readWorkflows(dir: string): Record<string, string> {
  return Object.fromEntries(
    readdirSync(dir)
      .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
      .map((f) => [f, readFileSync(join(dir, f), "utf8")]),
  );
}

describe("CI stays inside its Actions budget", () => {
  const workflows = readWorkflows(join(repoRoot, ".github", "workflows"));

  // Without this, a bad path or a parser change makes the assertion below pass on an empty set —
  // the same trap workflow-turbo-env.test.ts guards against.
  it("finds the workflows and a pull_request trigger (so this can't pass vacuously)", () => {
    expect(Object.keys(workflows).length).toBeGreaterThanOrEqual(2);
    const prWorkflows = Object.values(workflows).filter((text) =>
      triggersOf(parseYaml(text) as Workflow).includes("pull_request"),
    );
    expect(prWorkflows.length).toBeGreaterThanOrEqual(1);
  });

  it("has no structural cost regressions", () => {
    expect(costViolations(workflows)).toEqual([]);
  });
});

// --- proof that the check above actually fails ---------------------------------------------------
//
// The assertion above is `toEqual([])`, which passes just as happily if the detection is broken and
// silently returns nothing. These are the four real shapes, as they were in the repo before ADR 0064.

const gated = "${{ vars.CI_ENABLED != 'false' }}";

const problem = (violations: CostViolation[]) =>
  violations.map((v) => v.problem);

describe("cost check — it detects what it claims to", () => {
  it("catches the pull_request + push duplicate", () => {
    const found = costViolations({
      "ci.yml": `
on:
  pull_request:
  push:
    branches: [main]
concurrency:
  group: ci-\${{ github.ref }}
  cancel-in-progress: true
jobs:
  test:
    if: "${gated}"
    runs-on: ubuntu-latest
`,
    });
    expect(problem(found)).toEqual([
      expect.stringContaining("both `pull_request` and `push`"),
    ]);
  });

  it("catches a missing concurrency group", () => {
    const found = costViolations({
      "ci.yml": `
on:
  pull_request:
jobs:
  test:
    if: "${gated}"
    runs-on: ubuntu-latest
`,
    });
    expect(problem(found)).toEqual([
      expect.stringContaining("cancel-in-progress"),
    ]);
  });

  // `cancel-in-progress: false` is the near-miss: the key is present, so a diff reads as fixed.
  it("rejects a concurrency group that doesn't cancel", () => {
    const found = costViolations({
      "ci.yml": `
on:
  pull_request:
concurrency:
  group: ci
  cancel-in-progress: false
jobs:
  test:
    if: "${gated}"
    runs-on: ubuntu-latest
`,
    });
    expect(problem(found)).toEqual([
      expect.stringContaining("cancel-in-progress"),
    ]);
  });

  // The exact shape of the old matrix: Windows arrives through `include`, not the `os` axis, so a
  // check that only read `runs-on` literally would miss it.
  it("catches a 2x Windows leg reached through a matrix include", () => {
    const found = costViolations({
      "ci.yml": `
on:
  pull_request:
concurrency:
  group: ci
  cancel-in-progress: true
jobs:
  node:
    if: "${gated}"
    runs-on: \${{ matrix.os }}
    strategy:
      matrix:
        os: [ubuntu-latest]
        task: [test:unit]
        include:
          - os: windows-latest
            task: test:unit
`,
    });
    expect(problem(found)).toEqual([
      expect.stringContaining("windows-latest` (2x billing)"),
    ]);
  });

  it("allows the same expensive runner on a workflow that isn't PR-triggered", () => {
    expect(
      costViolations({
        "nightly.yml": `
on:
  schedule:
    - cron: "0 2 * * *"
jobs:
  windows:
    if: "${gated}"
    runs-on: windows-latest
`,
      }),
    ).toEqual([]);
  });

  it("catches the fan-out of the old five-task matrix", () => {
    const found = costViolations({
      "ci.yml": `
on:
  pull_request:
concurrency:
  group: ci
  cancel-in-progress: true
jobs:
  node:
    if: "${gated}"
    runs-on: ubuntu-latest
    strategy:
      matrix:
        task: [lint, type-check, test:unit, test:integration, build]
  format:
    if: "${gated}"
    runs-on: ubuntu-latest
  python:
    if: "${gated}"
    runs-on: ubuntu-latest
`,
    });
    expect(problem(found)).toEqual([
      expect.stringContaining("fans out to 7 jobs"),
    ]);
  });

  it("catches a job that forgot the kill switch", () => {
    const found = costViolations({
      "ci.yml": `
on:
  pull_request:
concurrency:
  group: ci
  cancel-in-progress: true
jobs:
  test:
    if: "${gated}"
    runs-on: ubuntu-latest
  newcomer:
    runs-on: ubuntu-latest
`,
    });
    expect(problem(found)).toEqual([
      expect.stringContaining("`newcomer` has no"),
    ]);
  });

  // `on:` parses as the boolean `true` under YAML 1.1. If triggersOf ever loses that fallback every
  // PR-only check above goes quietly inert, so it gets a case of its own rather than a comment.
  it("reads `on:` even when the parser hands it back as the boolean key", () => {
    const parsed = parseYaml(`
on:
  pull_request:
jobs: {}
`) as Workflow;
    expect(triggersOf(parsed)).toEqual(["pull_request"]);
  });
});
