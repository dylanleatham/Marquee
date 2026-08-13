// Argument parsing. Small, but every one of these flags changes what happens to real hardware, and
// an option silently ignored because it was misspelled is the worst outcome available — the deploy
// runs, reports success, and did something other than what was asked.
import { describe, it, expect } from "vitest";
import { main, parseArgs } from "../src/cli.js";
import { ConfigError } from "../src/hosts.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe("defaults", () => {
  it("deploys origin/main to every host with no flags", () => {
    const args = parseArgs([]);
    expect(args.ref).toBe("origin/main");
    expect(args.only).toBeNull();
    expect(args.full).toBe(false);
    expect(args.dryRun).toBe(false);
    expect(args.desktop).toBe(false);
    expect(args.allowDirty).toBe(false);
  });

  it("defaults to the safe side of every risky flag", () => {
    // --allow-dirty discards work and --full is slow; neither should ever be reached by accident.
    const args = parseArgs([]);
    expect(args.allowDirty).toBe(false);
    expect(args.dryRun).toBe(false);
  });
});

describe("options", () => {
  it("takes a ref, which is also how a rollback is expressed", () => {
    expect(parseArgs(["--ref", "53b39d3"]).ref).toBe("53b39d3");
    expect(parseArgs(["--ref", "v1.2.0"]).ref).toBe("v1.2.0");
  });

  it("splits --only on commas and trims", () => {
    expect(parseArgs(["--only", "pi5, pizero"]).only).toEqual([
      "pi5",
      "pizero",
    ]);
  });

  it("ignores empty entries in --only rather than looking for a host named ''", () => {
    expect(parseArgs(["--only", "pi5,,"]).only).toEqual(["pi5"]);
  });

  it.each([
    [["--full"], "full"],
    [["--dry-run"], "dryRun"],
    [["--desktop"], "desktop"],
    [["--allow-dirty"], "allowDirty"],
    [["--help"], "help"],
    [["-h"], "help"],
  ])("%s sets %s", (argv, key) => {
    expect(parseArgs(argv)[key as keyof ReturnType<typeof parseArgs>]).toBe(
      true,
    );
  });

  it("combines flags", () => {
    const args = parseArgs([
      "--ref",
      "abc123",
      "--only",
      "pi5",
      "--full",
      "--dry-run",
    ]);
    expect(args).toMatchObject({
      ref: "abc123",
      only: ["pi5"],
      full: true,
      dryRun: true,
    });
  });
});

describe("rejections", () => {
  it("rejects an unknown option instead of ignoring it", () => {
    // A typo'd flag that parses as "no flag" is the failure this test exists for: the deploy runs
    // and does something other than what was asked, reporting success either way.
    expect(() => parseArgs(["--dryrun"])).toThrow(ConfigError);
    expect(() => parseArgs(["--dryrun"])).toThrow(/unknown option/);
  });

  it("prints the usage alongside an unknown option", () => {
    expect(() => parseArgs(["--nope"])).toThrow(/--dry-run/);
  });

  it.each(["--ref", "--only", "--hosts"])(
    "rejects %s with no value",
    (flag) => {
      expect(() => parseArgs([flag])).toThrow(/needs a value/);
    },
  );
});

describe("main", () => {
  it("prints usage and exits 0 for --help, touching no host", async () => {
    const printed: string[] = [];
    const log = console.log;
    console.log = (m: string) => printed.push(m);
    try {
      expect(await main(["--help"])).toBe(0);
    } finally {
      console.log = log;
    }
    expect(printed.join("\n")).toMatch(/--dry-run/);
  });

  it("exits 1 with the fix, not a stack trace, when there is no inventory", async () => {
    // The first thing a new operator hits. It has to name the file and the command that creates it.
    const printed: string[] = [];
    const error = console.error;
    console.error = (m: string) => printed.push(m);
    try {
      expect(
        await main(["--hosts", "definitely-not-a-real-inventory.json"]),
      ).toBe(1);
    } finally {
      console.error = error;
    }
    expect(printed.join("\n")).toMatch(/hosts\.example\.json/);
  }, 30_000);
});

describe("main --only", () => {
  // The lookup against the loaded inventory, which parseArgs never sees: it only splits the string.
  // A typo'd host name has to stop the run *before* the fetch, or the deploy silently covers fewer
  // hosts than asked for and still reports success.
  const inventory = (hosts: Record<string, unknown>) => {
    const dir = mkdtempSync(join(tmpdir(), "deploy-cli-"));
    dirs.push(dir);
    const path = join(dir, "hosts.json");
    writeFileSync(path, JSON.stringify({ hosts }));
    return path;
  };

  const pi5 = {
    ssh: "pi@backdrop.local",
    repo: "/home/pi/Marquee",
    services: { backdrop: { unit: "backdrop", port: 4740 } },
  };

  it("exits 1 and lists the known hosts when --only names one that isn't there", async () => {
    const printed: string[] = [];
    const error = console.error;
    console.error = (m: string) => printed.push(m);
    try {
      expect(
        await main(["--hosts", inventory({ pi5 }), "--only", "pi-5"]),
      ).toBe(1);
    } finally {
      console.error = error;
    }
    const out = printed.join("\n");
    expect(out).toMatch(/pi-5/);
    expect(out).toMatch(/Known hosts: pi5/);
  }, 30_000);

  it("names every unknown host, not just the first", async () => {
    const printed: string[] = [];
    const error = console.error;
    console.error = (m: string) => printed.push(m);
    try {
      await main(["--hosts", inventory({ pi5 }), "--only", "nope,also-nope"]);
    } finally {
      console.error = error;
    }
    expect(printed.join("\n")).toMatch(/nope, also-nope/);
  }, 30_000);
});
