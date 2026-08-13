// A scripted host, so the deploy — including its failure and rollback paths — runs in unit tests
// with no Raspberry Pi switched on.
//
// It reproduces `RealExecutor`'s one behavioural contract rather than just recording calls: a
// non-zero exit throws unless the command opted into `allowFailure`. Getting that wrong in the fake
// would make every "does it stop when a step fails?" test pass vacuously.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { assetsFor, destFor, render } from "../src/assets.js";
import {
  CommandFailed,
  type Command,
  type CommandResult,
  type Executor,
} from "../src/exec.js";
import type { Host } from "../src/hosts.js";
import type { Reporter } from "../src/run.js";

export type Reply =
  | Partial<CommandResult>
  | ((cmd: Command, host: Host) => Partial<CommandResult>);
export type Route = [RegExp, Reply];

export class FakeExecutor implements Executor {
  /** Every command run, as `host: argv`, in order. */
  readonly calls: string[] = [];

  constructor(private readonly routes: Route[] = []) {}

  /** Routes added later win — tests state the interesting case first and inherit the rest. */
  route(pattern: RegExp, reply: Reply): this {
    this.routes.unshift([pattern, reply]);
    return this;
  }

  async exec(host: Host, cmd: Command): Promise<CommandResult> {
    const line = cmd.argv.join(" ");
    this.calls.push(`${host.name}: ${line}`);

    let reply: Partial<CommandResult> = {};
    for (const [pattern, r] of this.routes) {
      if (pattern.test(line)) {
        reply = typeof r === "function" ? r(cmd, host) : r;
        break;
      }
    }
    const result: CommandResult = { code: 0, stdout: "", stderr: "", ...reply };
    if (result.code !== 0 && !cmd.allowFailure)
      throw new CommandFailed(host.name, cmd, result);
    return result;
  }

  /** Commands matching `pattern`, for asserting on what ran and in what order. */
  matching(pattern: RegExp): string[] {
    return this.calls.filter((c) => pattern.test(c));
  }

  ran(pattern: RegExp): boolean {
    return this.calls.some((c) => pattern.test(c));
  }

  /** Index of the first matching call, or -1 — for asserting that A happened before B. */
  indexOf(pattern: RegExp): number {
    return this.calls.findIndex((c) => pattern.test(c));
  }
}

export interface FakeOptions {
  /** What every host reports as its current commit. */
  currentSha: string;
  /** What `git diff --name-only` returns. */
  changed: string[];
  /** The host clock, in ms. Units report starting 5s after this unless overridden. */
  clock: number;
}

/**
 * The happy path: a reachable, clean host on `currentSha`, whose units all exist, are active, and
 * report having restarted after the checkout, and whose services answer 200.
 */
export function happyRoutes(opts: FakeOptions): Route[] {
  const startedAt = Math.floor(opts.clock / 1000) + 5;

  // The one piece of state a useful fake needs: a checkout moves the host's HEAD. Without it,
  // `verifyHost`'s "is the checkout what I asked for?" check can never pass, and — worse — a test
  // asserting that the deploy *catches* a checkout that didn't take would pass for the wrong reason.
  const head = new Map<string, string>();
  const shaOf = (host: Host) => head.get(host.name) ?? opts.currentSha;

  return [
    [
      /^git checkout --detach --force (\w+)$/,
      (cmd, host) => {
        head.set(host.name, cmd.argv[cmd.argv.length - 1]!);
        return {};
      },
    ],
    [/^git rev-parse HEAD$/, (_cmd, host) => ({ stdout: `${shaOf(host)}\n` })],
    [/^git status/, { stdout: "" }],
    [/^git diff --name-only/, { stdout: opts.changed.join("\n") }],
    [/^date \+%s$/, { stdout: `${Math.floor(opts.clock / 1000)}\n` }],
    [/^systemctl is-active/, { stdout: "active\n" }],
    // The restart-time probe: `date -d "$(systemctl show …)" +%s`.
    [/^sh -c date -d/, { stdout: `${startedAt}\n` }],
    [/healthz/, { stdout: "200" }],
    [/diff -rq/, { stdout: "" }],
    // No installed copy yet, so every asset converges. A test wanting "already matches" routes
    // sha256sum to `installedHashes(host, repoRoot)`.
    [/^sha256sum/, { code: 1, stderr: "No such file or directory\n" }],
  ];
}

/**
 * `sha256sum` replies that make every asset on `host` look already-converged.
 *
 * The hash has to be computed the way the deployer computes it — read the source, render it for the
 * host, hash the result — or "already matches" would be a claim the test makes rather than one it
 * establishes.
 */
export function installedHashes(host: Host, repoRoot: string): Reply {
  const byDest = new Map<string, string>();
  for (const asset of assetsFor(host)) {
    const rendered = render(
      readFileSync(join(repoRoot, asset.source), "utf8"),
      host,
    );
    byDest.set(
      destFor(asset, host),
      createHash("sha256").update(rendered, "utf8").digest("hex"),
    );
  }
  return (cmd) => {
    const dest = cmd.argv[cmd.argv.length - 1] ?? "";
    const hash = byDest.get(dest);
    return hash ? { stdout: `${hash}  ${dest}\n` } : { code: 1 };
  };
}

/** A reporter that keeps what it was told, so tests can assert on operator-facing output. */
export class RecordingReporter implements Reporter {
  readonly steps: string[] = [];
  readonly oks: string[] = [];
  readonly warnings: string[] = [];
  readonly infos: string[] = [];

  step(host: string, message: string): void {
    this.steps.push(`${host}: ${message}`);
  }
  ok(host: string, message: string): void {
    this.oks.push(`${host}: ${message}`);
  }
  warn(host: string, message: string): void {
    this.warnings.push(`${host}: ${message}`);
  }
  info(message: string): void {
    this.infos.push(message);
  }
}
