// Running commands on a host — the only part of this package that touches the outside world.
//
// Two rules shape it. Everything is an **argv array**, never a shell string, so nothing here has to
// reason about quoting a path with a space in it; and everything carries a **timeout**, because the
// deployer drives subprocesses and the network and a hung `pnpm install` against an unreachable
// registry must fail the deploy rather than park it forever with no output.
//
// `Executor` is an interface so `run.ts` can be tested against a scripted fake — the whole deploy,
// including the failure and rollback paths, runs in unit tests with no Pi switched on.

import { spawn } from "node:child_process";
import { isLocal, type Host } from "./hosts.js";

export interface Command {
  argv: string[];
  /** Absolute path on the host. Defaults to the host's repo. */
  cwd?: string;
  timeoutMs: number;
  /** Human-readable, used in progress output and failure messages. */
  label: string;
  stdin?: string;
  /** Probes set this: a non-zero exit is data, not a failure. */
  allowFailure?: boolean;
}

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface Executor {
  exec(host: Host, cmd: Command): Promise<CommandResult>;
}

export class CommandFailed extends Error {
  constructor(
    readonly host: string,
    readonly command: Command,
    readonly result: CommandResult,
  ) {
    const detail = [result.stderr.trim(), result.stdout.trim()]
      .filter(Boolean)
      .join("\n")
      .split("\n")
      .slice(-12) // the tail is where the actual error is; the head is usually progress noise
      .join("\n");
    super(
      `${host}: ${command.label} failed (exit ${result.code})\n$ ${command.argv.join(" ")}\n${detail}`,
    );
    this.name = "CommandFailed";
  }
}

/** Single-quote for POSIX `sh`. `'` is closed, escaped, and reopened — the only character that can. */
export function shellQuote(arg: string): string {
  return `'${arg.split("'").join(`'\\''`)}'`;
}

/** An argv (plus optional cwd) as one shell-quoted string, for handing to a remote shell. */
export function toRemoteScript(argv: string[], cwd?: string): string {
  const command = argv.map(shellQuote).join(" ");
  return cwd ? `cd ${shellQuote(cwd)} && ${command}` : command;
}

/**
 * The full local argv for running `cmd` on a remote `host`.
 *
 * **The script must be the one and only command argument.** `ssh` does not preserve argv boundaries:
 * it joins everything after the target with single spaces and hands the resulting *string* to the
 * remote login shell, which parses it once. So passing `["sh", "-c", script]` does not run
 * `sh -c "<script>"` remotely — the remote shell re-splits it and `sh -c` receives only the script's
 * first word. That is exactly what happened on the first real run against the Pi 5:
 *
 *     sh -c cd '/home/pi/Marquee' && 'git' 'rev-parse' 'HEAD'
 *
 * which ran a bare `cd`, then `git rev-parse HEAD` in the *home* directory, and reported
 * "fatal: not a git repository" for a host whose checkout was present and fine.
 *
 * `toRemoteScript` already produces a string written to be parsed by exactly one shell, so the fix
 * is to let the remote login shell be that shell. Anything in `cmd.argv` that genuinely needs a
 * nested shell passes its own `sh -c` inside the argv, which survives because this function quotes
 * it as data.
 */
export function sshArgv(host: Host, cmd: Command, cwd: string): string[] {
  return [...SSH_OPTIONS, host.ssh!, "--", toRemoteScript(cmd.argv, cwd)];
}

/**
 * SSH options that make an unattended deploy fail fast instead of hanging.
 *
 * `BatchMode=yes` is the load-bearing one: without it, a host whose key isn't installed drops to an
 * interactive password prompt against a stdin that is either closed or carrying a file, and the
 * deploy stalls with no output rather than saying "you have no key on pizero".
 */
export const SSH_OPTIONS = [
  "-o",
  "BatchMode=yes",
  "-o",
  "ConnectTimeout=10",
  // A deploy is a burst of short commands; one multiplexed connection avoids paying the handshake
  // per step, and the 30s idle close means it doesn't outlive the run by any meaningful amount.
  "-o",
  "ControlMaster=auto",
  "-o",
  "ControlPersist=30",
];

/**
 * Windows resolves `pnpm` to `pnpm.cmd`, which `spawn` cannot execute without a shell — and using a
 * shell would put the quoting problem this module avoids straight back. Naming the shims explicitly
 * is narrower than `shell: true` and fails loudly rather than mysteriously if a new one appears.
 */
const WINDOWS_SHIMS = new Set(["pnpm", "npm", "npx", "node"]);

function localArgv(argv: string[]): string[] {
  const [head, ...rest] = argv;
  if (head === undefined) throw new Error("empty argv");
  if (
    process.platform === "win32" &&
    WINDOWS_SHIMS.has(head) &&
    head !== "node"
  ) {
    return [`${head}.cmd`, ...rest];
  }
  return [head, ...rest];
}

export class RealExecutor implements Executor {
  constructor(private readonly log: (line: string) => void = () => {}) {}

  async exec(host: Host, cmd: Command): Promise<CommandResult> {
    const cwd = cmd.cwd ?? host.repo;
    const [file, ...args] = isLocal(host)
      ? localArgv(cmd.argv)
      : ["ssh", ...sshArgv(host, cmd, cwd)];

    this.log(`${host.name} $ ${cmd.argv.join(" ")}`);

    const result = await this.spawn(
      file!,
      args,
      isLocal(host) ? cwd : undefined,
      cmd,
    );
    if (result.code !== 0 && !cmd.allowFailure) {
      throw new CommandFailed(host.name, cmd, result);
    }
    return result;
  }

  private spawn(
    file: string,
    args: string[],
    cwd: string | undefined,
    cmd: Command,
  ): Promise<CommandResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(file, args, {
        cwd,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });

      let stdout = "";
      let stderr = "";
      let timedOut = false;

      // The bound. `unref` is deliberately not used: this timer must keep the process alive long
      // enough to fire, or a wedged child would let node exit reporting success.
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, cmd.timeoutMs);

      child.stdout.on("data", (d: Buffer) => {
        stdout += d.toString();
      });
      child.stderr.on("data", (d: Buffer) => {
        stderr += d.toString();
      });

      child.on("error", (err) => {
        clearTimeout(timer);
        reject(
          new Error(`${cmd.label}: could not run ${file} — ${err.message}`),
        );
      });

      child.on("close", (code) => {
        clearTimeout(timer);
        if (timedOut) {
          reject(
            new Error(
              `${cmd.label}: timed out after ${cmd.timeoutMs}ms\n$ ${cmd.argv.join(" ")}\n` +
                `${stderr.trim() || stdout.trim()}`,
            ),
          );
          return;
        }
        resolve({ code: code ?? -1, stdout, stderr });
      });

      if (cmd.stdin !== undefined) child.stdin.end(cmd.stdin);
      else child.stdin.end();
    });
  }
}

/** Timeouts, in one place so they can be reviewed as a set rather than found one at a time. */
export const TIMEOUTS = {
  /** Probes and status reads. Generous enough for a loaded Pi Zero, short enough to notice. */
  probe: 20_000,
  /** `git fetch` over a domestic uplink. */
  git: 180_000,
  /** `pnpm install` on a Pi — the slowest routine step, and the one most worth bounding. */
  install: 900_000,
  /** `tsc -b` across the workspace on a Pi 5. */
  build: 900_000,
  /** `pip install --no-deps .` — seconds when the native wheels are already built. */
  pip: 300_000,
  /** `systemctl restart` returns once the unit is started, not once it is healthy. */
  restart: 60_000,
  /** Writing an asset. */
  file: 30_000,
  /** `reboot` disconnects us; the command itself returns immediately or dies with the link. */
  reboot: 30_000,
} as const;
