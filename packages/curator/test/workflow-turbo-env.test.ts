import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parse as parseYaml } from "yaml";

// Repo-wide invariant, hosted here for the same reason adr-numbering.test.ts is: this is the leg CI
// runs (`test:unit`), and neither the workflows nor turbo.json have a package of their own.
//
// Issue #223: ci.yml set VITEST_MAX_FORKS/VITEST_MIN_FORKS on the Windows `test:unit` leg to cap
// vitest's fork pool — the second half of the mitigation for two flakes (#131, #156). Turbo runs in
// `envMode: strict`, which strips any variable not declared in turbo.json, and neither was declared
// anywhere. The setting was inert from the day it was written: the workflow said one thing, the
// runner did another, and nothing was red.
//
// That was the *second* instance. PR #222 had just declared MARQUEE_REQUIRE_FFMPEG/FFMPEG_PATH/
// FFPROBE_PATH on test:integration for exactly this reason — its turbo.json comment even spells the
// rule out — while the VITEST_* vars sat undeclared two files away. Twice is a blind spot, not two
// accidents, so the guard is a check rather than a third careful reading.
//
// What makes this class nasty is that both failure modes are silent: an undeclared variable doesn't
// error, it just isn't there, and the thing it was supposed to configure quietly keeps its default.
// The only cheap moment to catch it is when the variable is added.

const repoRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
);

/**
 * Variables that never need declaring: turbo's own configuration, which it reads before the env
 * filter applies. Deliberately short — every entry here is a hole in the check, so an entry earns
 * its place by being something turbo genuinely handles itself, not by being inconvenient.
 */
const NEVER_NEEDS_DECLARING = [/^TURBO_/];

/** Strip `//` line comments from JSONC, leaving string literals (which may contain `//`) alone. */
function stripJsonComments(text: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
      continue;
    }
    out += ch;
  }
  return out;
}

interface TurboConfig {
  globalEnv?: string[];
  globalPassThroughEnv?: string[];
  tasks?: Record<string, { env?: string[]; passThroughEnv?: string[] }>;
}

/** The variables turbo.json declares, as a map of variable name → the tasks that declare it. */
function declarationsIn(turbo: TurboConfig): Map<string, Set<string>> {
  const byVar = new Map<string, Set<string>>();
  const add = (name: string, task: string) => {
    if (!byVar.has(name)) byVar.set(name, new Set());
    byVar.get(name)!.add(task);
  };
  // "*" reads as "available to every task", which is what global declarations mean.
  for (const name of turbo.globalEnv ?? []) add(name, "*");
  for (const name of turbo.globalPassThroughEnv ?? []) add(name, "*");
  for (const [task, config] of Object.entries(turbo.tasks ?? {})) {
    for (const name of config.env ?? []) add(name, task);
    for (const name of config.passThroughEnv ?? []) add(name, task);
  }
  return byVar;
}

interface WorkflowStep {
  run?: string;
  env?: Record<string, unknown>;
}
interface WorkflowJob {
  env?: Record<string, unknown>;
  steps?: WorkflowStep[];
  strategy?: { matrix?: Record<string, unknown> };
}
interface Workflow {
  env?: Record<string, unknown>;
  jobs?: Record<string, WorkflowJob>;
}

/**
 * The turbo tasks a shell command may run, or `null` if it doesn't reach turbo at all.
 *
 * Follows one hop through the root package.json scripts, because a workflow reaches turbo both ways:
 * ci.yml calls `pnpm turbo run <task>` directly, contract-tests.yml calls `pnpm run test:contracts`,
 * which is itself `turbo run test:contracts`. A check that only understood the direct form would
 * pass contract-tests.yml vacuously.
 */
function turboTasksFor(
  command: string,
  rootScripts: Record<string, string>,
  depth = 0,
): string[] | null {
  const direct = command.match(/\bturbo\s+run\s+([^\n&|;]*)/);
  if (direct) {
    // `${{ matrix.task }}` contains spaces, so it has to be matched before falling back to
    // whitespace splitting — otherwise the expression arrives as three meaningless tokens.
    // Flags are dropped after expansion, not here: `${{ matrix.turboFlags }}` is an expression at
    // this point and only turns into `--concurrency=1` once the matrix is applied.
    return direct[1].match(/\$\{\{[^}]*\}\}|\S+/g) ?? [];
  }
  if (depth > 0) return null;
  // `pnpm run <script>` / `pnpm <script>` — resolve against the root scripts and look again.
  const viaScript = command.match(/\bpnpm\s+(?:run\s+)?([\w:.-]+)/);
  const script = viaScript && rootScripts[viaScript[1]];
  return script ? turboTasksFor(script, rootScripts, depth + 1) : null;
}

/**
 * Expand `${{ matrix.foo }}` against a job's matrix, returning every value `foo` can take.
 * A task name that isn't an expression stands for itself.
 */
function expandMatrix(
  token: string,
  matrix: Record<string, unknown>,
): string[] {
  const expr = token.match(/^\$\{\{\s*matrix\.([\w-]+)\s*\}\}$/);
  if (!expr) return [token];
  const key = expr[1];
  const values = new Set<string>();
  const base = matrix[key];
  if (Array.isArray(base)) {
    for (const v of base) if (typeof v === "string") values.add(v);
  }
  for (const entry of (matrix.include as Record<string, unknown>[]) ?? []) {
    const v = entry?.[key];
    if (typeof v === "string") values.add(v);
  }
  return [...values];
}

interface UndeclaredVar {
  workflow: string;
  variable: string;
  tasks: string[];
}

/**
 * Every environment variable a workflow sets on a step that reaches turbo, which turbo.json doesn't
 * declare for any task that step can run.
 *
 * The "for any task that step can run" half matters: declaring a variable on a task the workflow
 * never invokes looks like a fix and isn't one. It stops short of demanding the variable be declared
 * on *every* task the leg can run — ci.yml's matrix covers lint and build too, and requiring a
 * vitest setting there would be noise. A gate that cries wolf gets switched off.
 */
function undeclaredTurboEnvVars(
  workflows: Record<string, string>,
  turboText: string,
  rootScripts: Record<string, string>,
): UndeclaredVar[] {
  const declared = declarationsIn(
    JSON.parse(stripJsonComments(turboText)) as TurboConfig,
  );
  const found: UndeclaredVar[] = [];
  for (const [name, text] of Object.entries(workflows)) {
    const workflow = parseYaml(text) as Workflow;
    for (const job of Object.values(workflow.jobs ?? {})) {
      const matrix = job.strategy?.matrix ?? {};
      for (const step of job.steps ?? []) {
        if (!step.run) continue;
        const tokens = turboTasksFor(step.run, rootScripts);
        if (!tokens) continue;
        const tasks = tokens
          .flatMap((t) => expandMatrix(t, matrix))
          .filter((t) => !t.startsWith("-"));
        const inScope = {
          ...workflow.env,
          ...job.env,
          ...step.env,
        };
        for (const variable of Object.keys(inScope)) {
          if (NEVER_NEEDS_DECLARING.some((re) => re.test(variable))) continue;
          const declaringTasks = declared.get(variable);
          const covered =
            declaringTasks &&
            (declaringTasks.has("*") ||
              tasks.some((t) => declaringTasks.has(t)));
          if (!covered) found.push({ workflow: name, variable, tasks });
        }
      }
    }
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

describe("workflow env vars reach turbo", () => {
  const workflows = readWorkflows(join(repoRoot, ".github", "workflows"));
  const turboText = readFileSync(join(repoRoot, "turbo.json"), "utf8");
  const rootScripts = JSON.parse(
    readFileSync(join(repoRoot, "package.json"), "utf8"),
  ).scripts as Record<string, string>;

  // Without this, a bad path or a parser change makes every assertion below pass on an empty set.
  it("finds the workflows and their turbo steps (so this can't pass vacuously)", () => {
    expect(Object.keys(workflows).length).toBeGreaterThanOrEqual(2);
    const stepsReachingTurbo = Object.values(workflows).flatMap((text) =>
      Object.values((parseYaml(text) as Workflow).jobs ?? {}).flatMap((job) =>
        (job.steps ?? []).filter(
          (s) => s.run && turboTasksFor(s.run, rootScripts),
        ),
      ),
    );
    expect(stepsReachingTurbo.length).toBeGreaterThanOrEqual(2);
  });

  // regression: #223 — VITEST_MAX_FORKS/VITEST_MIN_FORKS were set on the Windows test:unit leg but
  // declared nowhere in turbo.json, so strict env mode stripped them and the fork cap never applied.
  it("declares every variable the workflows set on a turbo step", () => {
    expect(undeclaredTurboEnvVars(workflows, turboText, rootScripts)).toEqual(
      [],
    );
  });
});

// --- proof that the check above actually fails --------------------------------------------------
//
// Every assertion in the suite above is `toEqual([])`, which passes just as happily if the detection
// is broken and silently returns nothing — the same trap adr-numbering.test.ts calls out. These
// cases are the real shapes: #223 itself, the near-miss of declaring a variable on the wrong task,
// and the indirection contract-tests.yml uses.

// These fixtures are plain strings rather than temp directories, unlike adr-numbering.test.ts's:
// the check takes workflow text and turbo.json text as arguments, so proving it needs no filesystem
// at all. Only the two top-level `it`s above read the real repo.

const SCRIPTS = { "test:unit": "turbo run test:unit" };

const ciLike = (env: string) => `
jobs:
  node:
    strategy:
      matrix:
        task: [lint, test:unit]
    steps:
      - run: pnpm turbo run \${{ matrix.task }}
        env:
${env}
`;

describe("workflow env check — it detects what it claims to", () => {
  it("catches #223: a variable set on a turbo step and declared nowhere", () => {
    const found = undeclaredTurboEnvVars(
      { "ci.yml": ciLike("          VITEST_MAX_FORKS: 1") },
      `{ "tasks": { "test:unit": {} } }`,
      SCRIPTS,
    );
    expect(found).toEqual([
      {
        workflow: "ci.yml",
        variable: "VITEST_MAX_FORKS",
        tasks: ["lint", "test:unit"],
      },
    ]);
  });

  it("accepts the variable once the task declares it", () => {
    expect(
      undeclaredTurboEnvVars(
        { "ci.yml": ciLike("          VITEST_MAX_FORKS: 1") },
        `{ "tasks": { "test:unit": { "env": ["VITEST_MAX_FORKS"] } } }`,
        SCRIPTS,
      ),
    ).toEqual([]);
  });

  it("accepts a global declaration, which covers every task", () => {
    expect(
      undeclaredTurboEnvVars(
        { "ci.yml": ciLike("          VITEST_MAX_FORKS: 1") },
        `{ "globalEnv": ["VITEST_MAX_FORKS"], "tasks": { "test:unit": {} } }`,
        SCRIPTS,
      ),
    ).toEqual([]);
  });

  // The near-miss: declaring it somewhere real, but on a task this leg never runs. Looks fixed in a
  // diff; still stripped at runtime.
  it("rejects a declaration on a task the step never runs", () => {
    const found = undeclaredTurboEnvVars(
      { "ci.yml": ciLike("          VITEST_MAX_FORKS: 1") },
      `{ "tasks": { "test:integration": { "env": ["VITEST_MAX_FORKS"] } } }`,
      SCRIPTS,
    );
    expect(found).toHaveLength(1);
    expect(found[0].variable).toBe("VITEST_MAX_FORKS");
  });

  it("follows `pnpm run <script>` through the root scripts to find turbo", () => {
    const found = undeclaredTurboEnvVars(
      {
        "contract-tests.yml": `
jobs:
  contracts:
    steps:
      - run: pnpm run test:contracts
        env:
          SOME_VAR: x
`,
      },
      `{ "tasks": { "test:contracts": {} } }`,
      { "test:contracts": "turbo run test:contracts" },
    );
    expect(found).toEqual([
      {
        workflow: "contract-tests.yml",
        variable: "SOME_VAR",
        tasks: ["test:contracts"],
      },
    ]);
  });

  it("ignores steps that never reach turbo", () => {
    expect(
      undeclaredTurboEnvVars(
        {
          "ci.yml": `
jobs:
  format:
    steps:
      - run: pnpm run format:check
        env:
          UNDECLARED_BUT_FINE: 1
`,
        },
        `{ "tasks": {} }`,
        { "format:check": "prettier --check ." },
      ),
    ).toEqual([]);
  });

  it("picks up job-level and workflow-level env, not just step-level", () => {
    const found = undeclaredTurboEnvVars(
      {
        "ci.yml": `
env:
  WORKFLOW_LEVEL: 1
jobs:
  node:
    env:
      JOB_LEVEL: 1
    steps:
      - run: pnpm turbo run test:unit
`,
      },
      `{ "tasks": { "test:unit": {} } }`,
      SCRIPTS,
    );
    expect(found.map((f) => f.variable).sort()).toEqual([
      "JOB_LEVEL",
      "WORKFLOW_LEVEL",
    ]);
  });

  // ci.yml passes `${{ matrix.turboFlags }}` alongside the task, which expands to `--concurrency=1`
  // on the Windows leg. A flag is not a task, and letting one into the list would make the "declared
  // on a task this step runs" comparison quietly meaningless.
  it("drops turbo flags that arrive via a matrix expression, not just literal ones", () => {
    const found = undeclaredTurboEnvVars(
      {
        "ci.yml": `
jobs:
  node:
    strategy:
      matrix:
        task: [test:unit]
        include:
          - task: test:unit
            turboFlags: --concurrency=1
    steps:
      - run: pnpm turbo run \${{ matrix.task }} \${{ matrix.turboFlags }}
        env:
          VITEST_MAX_FORKS: 1
`,
      },
      `{ "tasks": { "test:unit": {} } }`,
      SCRIPTS,
    );
    expect(found).toEqual([
      {
        workflow: "ci.yml",
        variable: "VITEST_MAX_FORKS",
        tasks: ["test:unit"],
      },
    ]);
  });

  it("exempts turbo's own TURBO_* configuration", () => {
    expect(
      undeclaredTurboEnvVars(
        { "ci.yml": ciLike("          TURBO_TELEMETRY_DISABLED: 1") },
        `{ "tasks": { "test:unit": {} } }`,
        SCRIPTS,
      ),
    ).toEqual([]);
  });

  it("strips JSONC comments without mangling strings that contain slashes", () => {
    const parsed = JSON.parse(
      stripJsonComments(`{
        // a comment
        "globalEnv": ["A"], // trailing
        "tasks": { "build": { "env": ["https://not-a-comment"] } }
      }`),
    );
    expect(parsed.globalEnv).toEqual(["A"]);
    expect(parsed.tasks.build.env).toEqual(["https://not-a-comment"]);
  });
});
