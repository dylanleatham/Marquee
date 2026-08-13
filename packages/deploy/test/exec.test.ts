// The command layer: quoting, and the bound.
//
// The timeout tests are the ones worth having. A deploy drives subprocesses and the network on an
// always-on system, and the repo's standing rule is that anything doing either gets a cap — a
// `pnpm install` against an unreachable registry has to fail the deploy rather than park it forever
// with no output. These run the real spawn path, because a mocked timer would prove nothing about
// whether the child is actually killed.
import { describe, it, expect } from "vitest";
import {
  RealExecutor,
  SSH_OPTIONS,
  TIMEOUTS,
  shellQuote,
  sshArgv,
  toRemoteScript,
  CommandFailed,
} from "../src/exec.js";
import type { Command } from "../src/exec.js";
import type { Host } from "../src/hosts.js";

const localHost: Host = {
  name: "local",
  repo: process.cwd(),
  services: {},
  user: "test",
  home: process.cwd(),
};

describe("shell quoting", () => {
  it.each([
    ["plain", "'plain'"],
    ["with space", "'with space'"],
    ["semi;colon", "'semi;colon'"],
    ["$(rm -rf /)", "'$(rm -rf /)'"],
    ["back`tick`", "'back`tick`'"],
    ["C:/Users/dylan/dev", "'C:/Users/dylan/dev'"],
  ])("quotes %s", (input, expected) => {
    expect(shellQuote(input)).toBe(expected);
  });

  it("survives the one character single quotes can't contain", () => {
    // `it's` must close the quote, escape the apostrophe, and reopen — the only correct form, and
    // the one thing a naive `'${x}'` gets wrong.
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
  });

  it("keeps an injected command inert", () => {
    const script = toRemoteScript(
      ["echo", "; rm -rf /home/pi"],
      "/home/pi/Marquee",
    );
    expect(script).toBe(`cd '/home/pi/Marquee' && 'echo' '; rm -rf /home/pi'`);
  });

  it("omits the cd when there is no cwd", () => {
    expect(toRemoteScript(["true"])).toBe("'true'");
  });
});

describe("the remote argv", () => {
  // Regression: the first real run against the Pi 5 reported "fatal: not a git repository" for a
  // host whose checkout was present and healthy. The cause is that `ssh` does not preserve argv
  // boundaries — it joins everything after the target with single spaces and hands the resulting
  // *string* to the remote login shell. Passing ["sh", "-c", script] therefore did not run
  // `sh -c "<script>"`: the remote shell re-split it, `sh -c` got only the script's first word
  // (`cd`), and the real command ran in the home directory.
  //
  // These tests reproduce ssh's joining rather than trusting the argv, which is the only way to see
  // that class of bug from a unit test.
  const remote: Host = {
    name: "pi5",
    ssh: "pi@192.168.86.59",
    repo: "/home/pi/Marquee",
    services: {},
    user: "pi",
    home: "/home/pi",
  };
  const cmd = (argv: string[], cwd?: string): Command => ({
    argv,
    timeoutMs: 1000,
    label: "test",
    ...(cwd ? { cwd } : {}),
  });

  /** What the remote login shell actually receives: everything after `--`, joined with spaces. */
  const asRemoteShellSees = (argv: string[]) =>
    argv.slice(argv.indexOf("--") + 1).join(" ");

  it("puts the script in exactly one argument", () => {
    // The whole bug in one assertion. More than one argument here means the remote shell re-splits.
    const argv = sshArgv(
      remote,
      cmd(["git", "rev-parse", "HEAD"]),
      remote.repo,
    );
    expect(argv.slice(argv.indexOf("--") + 1)).toHaveLength(1);
  });

  it("never wraps the script in its own sh -c", () => {
    const argv = sshArgv(remote, cmd(["git", "status"]), remote.repo);
    expect(argv).not.toContain("-c");
  });

  it("keeps the cd bound to the command the remote shell runs", () => {
    const argv = sshArgv(
      remote,
      cmd(["git", "rev-parse", "HEAD"]),
      remote.repo,
    );
    expect(asRemoteShellSees(argv)).toBe(
      `cd '/home/pi/Marquee' && 'git' 'rev-parse' 'HEAD'`,
    );
  });

  it("honours a per-command cwd over the host's repo", () => {
    // The Stylus pip install runs in packages/stylus, not the repo root.
    const argv = sshArgv(
      remote,
      cmd(
        [".venv/bin/pip", "install", "."],
        "/home/pi/Marquee/packages/stylus",
      ),
      "/home/pi/Marquee/packages/stylus",
    );
    expect(asRemoteShellSees(argv)).toContain(
      `cd '/home/pi/Marquee/packages/stylus'`,
    );
  });

  it("passes a genuinely nested sh -c through as data", () => {
    // The restart-time probe needs a real nested shell for its `$(...)`. It survives because the
    // script quotes it, rather than because ssh preserved the boundary.
    const script = `date -d "$(systemctl show --property=ActiveEnterTimestamp --value amp.service)" +%s`;
    const seen = asRemoteShellSees(
      sshArgv(remote, cmd(["sh", "-c", script]), remote.repo),
    );
    expect(seen).toContain(`'sh' '-c'`);
    expect(seen).toContain("ActiveEnterTimestamp");
  });

  it("keeps an injected command inert after the remote shell parses it", () => {
    const seen = asRemoteShellSees(
      sshArgv(remote, cmd(["echo", "; sudo rm -rf /"]), remote.repo),
    );
    // Quoted as one word, so the remote shell hands it to echo rather than running it.
    expect(seen).toContain(`'echo' '; sudo rm -rf /'`);
  });

  it("targets the host and keeps the hardening options", () => {
    const argv = sshArgv(remote, cmd(["true"]), remote.repo);
    expect(argv).toContain("pi@192.168.86.59");
    expect(argv).toContain("BatchMode=yes");
    expect(argv.indexOf("pi@192.168.86.59")).toBeLessThan(argv.indexOf("--"));
  });
});

describe("ssh options", () => {
  it("uses BatchMode so a missing key fails instead of prompting", () => {
    // Without it, a host with no key drops to an interactive password prompt against a stdin that is
    // closed or carrying a file, and the deploy stalls with no output at all.
    expect(SSH_OPTIONS).toContain("BatchMode=yes");
  });

  it("bounds the connection attempt", () => {
    expect(SSH_OPTIONS.join(" ")).toMatch(/ConnectTimeout=\d+/);
  });
});

describe("every operation is bounded", () => {
  it("gives every step a positive, finite timeout", () => {
    for (const [name, ms] of Object.entries(TIMEOUTS)) {
      expect(Number.isFinite(ms), name).toBe(true);
      expect(ms, name).toBeGreaterThan(0);
    }
  });

  it("kills a child that outruns its timeout, and says which command", async () => {
    const exec = new RealExecutor();
    const started = Date.now();
    await expect(
      exec.exec(localHost, {
        argv: ["node", "-e", "setTimeout(() => {}, 60000)"],
        timeoutMs: 700,
        label: "a command that hangs",
      }),
    ).rejects.toThrow(/timed out after 700ms/);
    // Proves the kill happened rather than the promise resolving on its own after 60s.
    expect(Date.now() - started).toBeLessThan(20_000);
  }, 30_000);
});

describe("failures", () => {
  it("throws with the exit code and the tail of the output", async () => {
    const exec = new RealExecutor();
    const err = await exec
      .exec(localHost, {
        argv: [
          "node",
          "-e",
          "console.error('the real error'); process.exit(3)",
        ],
        timeoutMs: 15_000,
        label: "a failing command",
      })
      .catch((e: Error) => e);
    expect(err).toBeInstanceOf(CommandFailed);
    expect(err.message).toMatch(/exit 3/);
    expect(err.message).toMatch(/the real error/);
    expect(err.message).toMatch(/a failing command/);
  }, 20_000);

  it("returns a non-zero exit as data when the caller opted in", async () => {
    const exec = new RealExecutor();
    const result = await exec.exec(localHost, {
      argv: ["node", "-e", "process.exit(1)"],
      timeoutMs: 15_000,
      label: "a probe",
      allowFailure: true,
    });
    expect(result.code).toBe(1);
  }, 20_000);

  it("reports a missing binary as a run failure, not a crash", async () => {
    const exec = new RealExecutor();
    await expect(
      exec.exec(localHost, {
        argv: ["definitely-not-a-real-binary-xyz"],
        timeoutMs: 15_000,
        label: "missing binary",
      }),
    ).rejects.toThrow(/could not run/);
  }, 20_000);
});

describe("stdin", () => {
  it("delivers content to the command, which is how assets are written", async () => {
    const exec = new RealExecutor();
    const result = await exec.exec(localHost, {
      argv: [
        "node",
        "-e",
        "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>process.stdout.write(s.toUpperCase()))",
      ],
      timeoutMs: 15_000,
      label: "echo stdin",
      stdin: "unit file contents",
    });
    expect(result.stdout).toBe("UNIT FILE CONTENTS");
  }, 20_000);
});
