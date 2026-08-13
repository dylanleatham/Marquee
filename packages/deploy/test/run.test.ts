// The deploy end to end, against a scripted host.
//
// The tests that matter most here are the ones about what the deployer *refuses* to do: finish over
// a service it couldn't prove restarted, touch a second host after the first failed, or leave a
// rewritten unit file in place when the service won't come up on it. Those are the properties that
// make a green deploy mean something, and each of them is a failure that would otherwise be found
// on the hardware, at night, with the lights off.
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  deploy,
  deployHost,
  describeEffects,
  effectsForHost,
  preflight,
  restrictToHost,
  DeployError,
  type DeployOptions,
} from "../src/run.js";
import { CuratorStaleError } from "../src/curator.js";
import { effectsFor, fullEffects } from "../src/changes.js";
import { parseConfig, type Host } from "../src/hosts.js";
import {
  FakeExecutor,
  RecordingReporter,
  happyRoutes,
  installedHashes,
} from "./fakes.js";

const repoRoot = join(import.meta.dirname, "..", "..", "..");
const OLD = "a".repeat(40);
const TARGET = "b".repeat(40);
const CLOCK = 1_760_000_000_000;

const inventory = parseConfig({
  hosts: {
    pi5: {
      ssh: "pi@backdrop.local",
      repo: "/home/pi/Marquee",
      kiosk: true,
      services: {
        conductor: { unit: "marquee-conductor", port: 4737 },
        backdrop: { unit: "backdrop", port: 4740 },
        amp: { unit: "marquee-amp", port: 4741 },
      },
    },
    pizero: {
      ssh: "pi@marquee-pizero.local",
      repo: "/home/pi/Marquee",
      services: { stylus: { unit: "marquee-stylus", port: 4741 } },
    },
  },
});
const [pi5, pizero] = inventory as [Host, Host];

let report: RecordingReporter;
beforeEach(() => {
  report = new RecordingReporter();
});

function options(over: Partial<DeployOptions> = {}): DeployOptions {
  return {
    targetRef: "origin/main",
    targetSha: TARGET,
    full: false,
    dryRun: false,
    allowDirty: false,
    desktop: false,
    now: () => CLOCK,
    // Tests must never actually wait; the bounded polls would otherwise take minutes.
    sleep: async () => {},
    repoRoot,
    // Default to the working tree, which is what the fixtures on disk represent. The test below
    // proves the deployer uses *this* hook rather than reading the tree itself.
    readAssetSource: async (path: string) =>
      readFileSync(join(repoRoot, path), "utf8"),
    ...over,
  };
}

const fake = (changed: string[], currentSha = OLD) =>
  new FakeExecutor(happyRoutes({ currentSha, changed, clock: CLOCK }));

async function run(
  host: Host,
  changed: string[],
  exec = fake(changed),
  opts = options(),
) {
  const pre = await preflight(host, exec, opts, report);
  return deployHost(pre, effectsForHost(pre, opts), exec, opts, report);
}

describe("a normal deploy", () => {
  it("checks out the pinned commit and restarts only what changed", async () => {
    const exec = fake(["packages/amp/src/server.ts"]);
    await run(pi5, ["packages/amp/src/server.ts"], exec);

    expect(
      exec.ran(new RegExp(`git checkout --detach --force ${TARGET}`)),
    ).toBe(true);
    expect(exec.ran(/pnpm --filter @marquee\/amp build/)).toBe(true);
    expect(exec.ran(/sudo systemctl restart marquee-amp\.service/)).toBe(true);
    // Conductor and Backdrop had no change and no shared-dependency change.
    expect(exec.ran(/restart marquee-conductor/)).toBe(false);
    expect(exec.ran(/restart backdrop\.service/)).toBe(false);
  });

  it("restarts the Backdrop unit under the name that host actually installed", async () => {
    // This inventory says `backdrop`, not `marquee-backdrop`. Assuming the repo's preferred name
    // gives `Unit marquee-backdrop.service not found` after the other units are already restarted.
    const exec = fake(["packages/backdrop/src/server.ts"]);
    await run(pi5, ["packages/backdrop/src/server.ts"], exec);
    expect(exec.ran(/sudo systemctl restart backdrop\.service/)).toBe(true);
    expect(exec.ran(/marquee-backdrop/)).toBe(false);
  });

  it("rebuilds all three services when contracts changed, though two have no source change", async () => {
    const exec = fake(["packages/contracts/schemas/scan-event.schema.json"]);
    await run(pi5, ["packages/contracts/schemas/scan-event.schema.json"], exec);
    for (const pkg of ["hue-conductor", "backdrop", "amp"]) {
      expect(exec.ran(new RegExp(`pnpm --filter @marquee/${pkg} build`))).toBe(
        true,
      );
    }
  });

  it("does nothing at all when the host is already on the target", async () => {
    const exec = fake([], TARGET);
    const outcome = await run(pi5, [], exec, options());
    expect(exec.ran(/git checkout/)).toBe(false);
    expect(exec.ran(/systemctl restart/)).toBe(false);
    expect(describeEffects(outcome.effects)).toBe("");
  });

  it("installs dependencies before building", async () => {
    const exec = fake(["pnpm-lock.yaml"]);
    await run(pi5, ["pnpm-lock.yaml"], exec);
    expect(exec.indexOf(/pnpm install --frozen-lockfile/)).toBeLessThan(
      exec.indexOf(/pnpm --filter .* build/),
    );
  });

  it("uses a frozen lockfile, so a deploy can't quietly resolve different dependencies", async () => {
    const exec = fake(["pnpm-lock.yaml"]);
    await run(pi5, ["pnpm-lock.yaml"], exec);
    expect(exec.ran(/pnpm install --frozen-lockfile/)).toBe(true);
  });
});

describe("Stylus, whose checkout is not what runs", () => {
  it("reinstalls the package rather than trusting the checkout", async () => {
    const exec = fake(["packages/stylus/stylus/state_machine.py"]);
    await run(pizero, ["packages/stylus/stylus/state_machine.py"], exec);
    // Non-editable install: site-packages holds a copy `git pull` never touches (issue #201).
    expect(exec.ran(/\.venv\/bin\/pip install --no-deps --quiet \./)).toBe(
      true,
    );
    expect(exec.ran(/sudo systemctl restart marquee-stylus\.service/)).toBe(
      true,
    );
  });

  it("fails if the installed copy still differs from the checkout", async () => {
    // The exact shape of #201: the service is active, the logs are clean, and it is running code
    // four days old. The diff is the only thing that can tell.
    const exec = fake(["packages/stylus/stylus/state_machine.py"]).route(
      /diff -rq/,
      {
        stdout:
          "Files stylus/state_machine.py and .../site-packages/stylus/state_machine.py differ\n",
      },
    );
    await expect(
      run(pizero, ["packages/stylus/stylus/state_machine.py"], exec),
    ).rejects.toThrow(/running stale code/);
  });

  it("never tries to build Stylus", async () => {
    const exec = fake(["packages/stylus/stylus/state_machine.py"]);
    await run(pizero, ["packages/stylus/stylus/state_machine.py"], exec);
    expect(exec.ran(/pnpm --filter stylus/)).toBe(false);
  });
});

describe("proving a restart actually happened", () => {
  it("fails when a unit has been running since before the checkout", async () => {
    // "Restarted" and "restarted the new code" are different claims, and `systemctl status` makes
    // the same face for both. The unit here reports having started an hour before the checkout.
    const stale = Math.floor(CLOCK / 1000) - 3600;
    const exec = fake(["packages/amp/src/server.ts"]).route(
      /ActiveEnterTimestamp/,
      {
        stdout: `${stale}\n`,
      },
    );
    await expect(
      run(pi5, ["packages/amp/src/server.ts"], exec),
    ).rejects.toThrow(/serving the previous commit/);
  });

  it("accepts a restart a second either side of the checkout", async () => {
    // The timestamp has second resolution and the two readings are separate round trips, so an
    // exact comparison would flag a genuinely fresh restart about half the time.
    const exec = fake(["packages/amp/src/server.ts"]).route(
      /ActiveEnterTimestamp/,
      {
        stdout: `${Math.floor(CLOCK / 1000) - 1}\n`,
      },
    );
    await expect(
      run(pi5, ["packages/amp/src/server.ts"], exec),
    ).resolves.toBeDefined();
  });

  it("warns rather than fails when the start time can't be read", async () => {
    const exec = fake(["packages/amp/src/server.ts"]).route(
      /ActiveEnterTimestamp/,
      {
        code: 1,
      },
    );
    await run(pi5, ["packages/amp/src/server.ts"], exec);
    expect(report.warnings.join("\n")).toMatch(/not independently verified/);
  });

  it("fails if a unit never reaches active", async () => {
    const exec = fake(["packages/amp/src/server.ts"]).route(
      /^systemctl is-active/,
      {
        stdout: "failed\n",
      },
    );
    await expect(
      run(pi5, ["packages/amp/src/server.ts"], exec),
    ).rejects.toThrow(/did not reach active/);
  });
});

describe("the two probes that need a real remote shell", () => {
  // `assertRestartedAfter` needs `$(…)` and the Stylus check needs `python*` to glob, so both build
  // a script rather than an argv. That makes them the only places in this file where a configured
  // value could land in shell syntax, so both route it through a quoted shell variable instead.
  it("quotes the unit name in the restart-time probe", async () => {
    const exec = fake(["packages/amp/src/server.ts"]);
    await run(pi5, ["packages/amp/src/server.ts"], exec);
    const probe = exec.matching(/sh -c u=/)[0] ?? "";
    expect(probe).toContain("u='marquee-amp'");
    // The bare interpolation this replaced.
    expect(probe).not.toContain("--value marquee-amp.service");
  });

  it("survives a repo path containing a space", async () => {
    // Not hypothetical enough to ignore: an unquoted path splits the diff into two wrong operands,
    // which fails and surfaces as "running stale code" — an alarming, entirely wrong diagnosis.
    const spaced = parseConfig({
      hosts: {
        pizero: {
          ssh: "pi@zero",
          repo: "/home/pi/My Marquee",
          services: { stylus: { unit: "marquee-stylus", port: 4741 } },
        },
      },
    })[0]!;
    const exec = fake(["packages/stylus/stylus/state_machine.py"]);
    await run(spaced, ["packages/stylus/stylus/state_machine.py"], exec);

    const diff = exec.matching(/sh -c d=/)[0] ?? "";
    expect(diff).toContain("d='/home/pi/My Marquee'");
    // The two operands stay single words via "$d", and the glob stays outside the quotes.
    expect(diff).toContain('"$d/packages/stylus/stylus/"');
    expect(diff).toContain('"$d"/packages/stylus/.venv/lib/python*/');
  });

  it("keeps the python* glob unquoted, since the venv carries the interpreter version", async () => {
    const exec = fake(["packages/stylus/stylus/state_machine.py"]);
    await run(pizero, ["packages/stylus/stylus/state_machine.py"], exec);
    const diff = exec.matching(/sh -c d=/)[0] ?? "";
    expect(diff).toMatch(/python\*/);
    expect(diff).not.toContain("'python*'");
  });
});

describe("health checks", () => {
  it("runs them on the host over loopback, never across the LAN", async () => {
    // The runbook is explicit that mDNS resolves for ssh from Windows but not reliably for
    // curl/undici — a check run from the workstation fails for reasons unrelated to the deploy.
    const exec = fake(["packages/amp/src/server.ts"]);
    await run(pi5, ["packages/amp/src/server.ts"], exec);
    expect(exec.ran(/curl .*http:\/\/127\.0\.0\.1:4741\/healthz/)).toBe(true);
    expect(exec.ran(/backdrop\.local\/healthz/)).toBe(false);
  });

  it("fails on an unhealthy service", async () => {
    const exec = fake(["packages/amp/src/server.ts"]).route(/healthz/, {
      stdout: "500",
    });
    await expect(
      run(pi5, ["packages/amp/src/server.ts"], exec),
    ).rejects.toThrow(/returned 500/);
  });

  it("treats Backdrop's 503 as a warning about the kiosk, not a dead backend", async () => {
    // 503 means the backend is fine and no browser is attached — the most useful signal after a
    // Backdrop deploy, because a crashed Chromium is invisible from `systemctl status`.
    const exec = fake(["packages/amp/src/server.ts"]).route(
      /127\.0\.0\.1:4740\/healthz/,
      {
        stdout: "503",
      },
    );
    const outcome = await run(pi5, ["packages/amp/src/server.ts"], exec);
    expect(outcome.warnings.join("\n")).toMatch(/no browser is attached/);
  });

  it("does not treat any other service's 503 as acceptable", async () => {
    const exec = fake(["packages/amp/src/server.ts"]).route(
      /127\.0\.0\.1:4737\/healthz/,
      {
        stdout: "503",
      },
    );
    await expect(
      run(pi5, ["packages/amp/src/server.ts"], exec),
    ).rejects.toThrow(/returned 503/);
  });
});

describe("the kiosk", () => {
  it("reboots and waits for the host when the SPA changed", async () => {
    const exec = fake(["packages/backdrop/public/index.html"]);
    const outcome = await run(
      pi5,
      ["packages/backdrop/public/index.html"],
      exec,
    );
    expect(exec.ran(/sudo systemctl reboot/)).toBe(true);
    expect(outcome.rebooted).toBe(true);
    // No build: the SPA is vanilla JS loaded as file:// straight from the working tree.
    expect(exec.ran(/pnpm --filter .* build/)).toBe(false);
  });

  it("does not reboot for a backend-only change", async () => {
    const exec = fake(["packages/backdrop/src/server.ts"]);
    await run(pi5, ["packages/backdrop/src/server.ts"], exec);
    expect(exec.ran(/reboot/)).toBe(false);
  });

  it("gives up rather than hanging if the host never comes back", async () => {
    const exec = fake(["packages/backdrop/public/index.html"]).route(/^true$/, {
      code: 255,
    });
    await expect(
      run(pi5, ["packages/backdrop/public/index.html"], exec),
    ).rejects.toThrow(/did not come back/);
  });
});

describe("out-of-tree assets", () => {
  const changed = ["packages/backdrop/deploy/kiosk.sh"];

  it("installs a missing asset with the right mode and destination", async () => {
    const exec = fake(changed);
    const outcome = await run(pi5, changed, exec);
    expect(
      exec.ran(/install -D -m 755 \/dev\/stdin \/home\/pi\/kiosk\.sh/),
    ).toBe(true);
    expect(outcome.convergedAssets).toContain("kiosk-launcher");
  });

  it("writes unit files through sudo and reloads systemd once", async () => {
    const exec = fake(changed);
    await run(pi5, changed, exec);
    expect(
      exec.ran(
        /sudo install -D -m 644 \/dev\/stdin \/etc\/systemd\/system\/backdrop\.service/,
      ),
    ).toBe(true);
    expect(exec.matching(/sudo systemctl daemon-reload/)).toHaveLength(1);
  });

  it("leaves an already-matching asset alone", async () => {
    // The common case, and the one that has to stay quiet or the interesting output is buried.
    const exec = fake(changed).route(
      /^sha256sum/,
      installedHashes(pi5, repoRoot),
    );
    const outcome = await run(pi5, changed, exec);
    expect(outcome.convergedAssets).toEqual([]);
    expect(exec.ran(/install -D/)).toBe(false);
    expect(exec.ran(/daemon-reload/)).toBe(false);
  });

  it("backs up an existing file before overwriting it", async () => {
    const exec = fake(changed).route(/^sha256sum/, {
      stdout: `${"f".repeat(64)}  x\n`,
    });
    await run(pi5, changed, exec);
    expect(
      exec.ran(/cp -p -- \/home\/pi\/kiosk\.sh \/home\/pi\/kiosk\.sh\.bak-/),
    ).toBe(true);
  });

  it("restores the previous unit and reloads when the service won't start on the new one", async () => {
    // A deploy that fails is acceptable; a deploy that fails *and* leaves the stand dead is not.
    // Driven by a unit-file change, which is the case that both rewrites a unit and restarts onto it.
    const unitChange = ["packages/backdrop/deploy/marquee-backdrop.service"];
    const exec = fake(unitChange)
      .route(/^sha256sum/, { stdout: `${"f".repeat(64)}  x\n` })
      .route(/sudo systemctl restart backdrop\.service/, {
        code: 1,
        stderr: "Job failed\n",
      });

    await expect(run(pi5, unitChange, exec)).rejects.toThrow();
    expect(
      exec.ran(
        /sudo cp -p -- \/etc\/systemd\/system\/backdrop\.service\.bak-\w+ \/etc\/systemd\/system\/backdrop\.service/,
      ),
    ).toBe(true);
    // Two reloads: one for the install, one for the rollback.
    expect(exec.matching(/daemon-reload/).length).toBeGreaterThanOrEqual(2);
  });

  it("removes a unit file it created, rather than restoring a backup that never existed", async () => {
    // Reachable even though preflight proves the unit exists: `systemctl cat` finds a unit anywhere
    // on the unit path, while this deployer always writes the /etc override. Rolling that back is a
    // removal — restoring nothing would leave the broken new file shadowing the working one.
    const unitChange = ["packages/backdrop/deploy/marquee-backdrop.service"];
    const exec = fake(unitChange)
      .route(/^sha256sum/, { code: 1, stderr: "No such file\n" })
      .route(/sudo systemctl restart backdrop\.service/, { code: 1 });

    await expect(run(pi5, unitChange, exec)).rejects.toThrow();
    expect(
      exec.ran(/sudo rm -f -- \/etc\/systemd\/system\/backdrop\.service/),
    ).toBe(true);
    expect(exec.ran(/sudo cp -p -- .*\.bak-/)).toBe(false);
  });

  it("takes asset content from the target commit, not the working tree", async () => {
    // Found by the first real deploy, and the most expensive bug in this package's short life.
    // Deploying `origin/main` from a feature branch based on an older commit, the deployer compared
    // the Pi's installed `marquee-stylus.service` against the *branch's* copy — where main had
    // changed it from `Type=simple` to `Type=notify` + `WatchdogSec=30`. They matched, nothing was
    // converged, and the Pi ran the new watchdog-sending code under a unit that arms no watchdog.
    // Every check passed. The fix reads assets via `git show <targetSha>:<path>`.
    //
    // The fake returns content that exists in NO file on disk, so a deployer that reads the working
    // tree cannot produce it.
    const fromCommit =
      "[Unit]\nDescription=only in the target commit\nType=notify\n";
    const exec = fake(["packages/stylus/marquee-stylus.service"]).route(
      /^sha256sum/,
      { stdout: `${"f".repeat(64)}  x\n` },
    );

    let written: string | undefined;
    exec.route(/install -D -m 644 \/dev\/stdin/, (cmd) => {
      written = cmd.stdin;
      return {};
    });

    await run(
      pizero,
      ["packages/stylus/marquee-stylus.service"],
      exec,
      options({ readAssetSource: async () => fromCommit }),
    );

    expect(written).toBe(fromCommit);
    expect(written).toContain("Type=notify");
  });

  it("leaves an asset alone when it doesn't exist at the target commit, and says so", async () => {
    // What makes rollback work. The manifest lists assets this repo tracks *now*; deploying a commit
    // from before one was tracked must leave the host's copy alone rather than failing on a `git
    // show` for a path that isn't in that tree. Real case: three of the four units are added by the
    // same change that added this deployer, so any commit before it has no such file.
    const exec = fake(["packages/stylus/marquee-stylus.service"]);
    const outcome = await run(
      pizero,
      ["packages/stylus/marquee-stylus.service"],
      exec,
      options({ readAssetSource: async () => null }),
    );

    expect(outcome.convergedAssets).toEqual([]);
    expect(exec.ran(/install -D/)).toBe(false);
    expect(report.warnings.join("\n")).toMatch(
      /does not exist at .* left as-is/s,
    );
  });

  it("gives the Pi Zero no kiosk assets", async () => {
    const exec = fake(["packages/stylus/marquee-stylus.service"]);
    const outcome = await run(
      pizero,
      ["packages/stylus/marquee-stylus.service"],
      exec,
    );
    expect(outcome.convergedAssets).toEqual(["stylus-unit"]);
    expect(exec.ran(/kiosk\.sh/)).toBe(false);
  });
});

describe("preflight refuses before it breaks anything", () => {
  it("refuses a dirty tree rather than discarding the work", async () => {
    const exec = fake([]).route(/^git status/, {
      stdout: " M packages/amp/src/server.ts\n",
    });
    await expect(preflight(pi5, exec, options(), report)).rejects.toThrow(
      /local modifications/,
    );
    expect(exec.ran(/git checkout/)).toBe(false);
  });

  it("proceeds over a dirty tree with --allow-dirty, but says so", async () => {
    const exec = fake([]).route(/^git status/, {
      stdout: " M packages/amp/src/server.ts\n",
    });
    await preflight(pi5, exec, options({ allowDirty: true }), report);
    expect(report.warnings.join("\n")).toMatch(/local modifications/);
  });

  it("fails when a configured unit doesn't exist, and says how to find the real name", async () => {
    const exec = fake([]).route(/^systemctl cat --no-pager backdrop/, {
      code: 1,
    });
    await expect(preflight(pi5, exec, options(), report)).rejects.toThrow(
      /systemctl list-units/,
    );
  });

  it("fails when the target commit isn't on the host after a fetch", async () => {
    const exec = fake([]).route(/^git cat-file/, { code: 1 });
    await expect(preflight(pi5, exec, options(), report)).rejects.toThrow(
      /is it pushed to origin/,
    );
  });

  it("fails when the repo path isn't a checkout", async () => {
    const exec = fake([]).route(/^git rev-parse HEAD/, {
      code: 128,
      stderr: "not a git repository",
    });
    await expect(preflight(pi5, exec, options(), report)).rejects.toThrow(
      /no git checkout/,
    );
  });

  it("fails when passwordless sudo isn't available", async () => {
    const exec = fake([]).route(/^sudo -n true/, { code: 1 });
    await expect(preflight(pi5, exec, options(), report)).rejects.toThrow(
      /passwordless sudo/,
    );
  });
});

describe("the run as a whole", () => {
  it("preflights every host before mutating any of them", async () => {
    // The property that stops a typo in the Pi Zero's hostname from being discovered after the
    // Pi 5 has already restarted three services.
    const exec = fake(["packages/contracts/src/index.ts"]);
    await deploy(inventory, exec, options(), report);

    const firstMutation = exec.indexOf(/git checkout/);
    const lastPreflight = exec.calls.reduce(
      (last, call, i) => (/systemctl cat|sudo -n true/.test(call) ? i : last),
      -1,
    );
    expect(lastPreflight).toBeLessThan(firstMutation);
  });

  it("stops before the second host when the first fails", async () => {
    const exec = fake(["packages/contracts/src/index.ts"]).route(
      /sudo systemctl restart marquee-conductor/,
      { code: 1, stderr: "Job for marquee-conductor.service failed\n" },
    );
    await expect(deploy(inventory, exec, options(), report)).rejects.toThrow();
    expect(exec.ran(/pizero: sudo systemctl restart/)).toBe(false);
  });

  it("deploys the Pis in order", async () => {
    const exec = fake(["packages/contracts/src/index.ts"]);
    await deploy(inventory, exec, options(), report);
    expect(exec.indexOf(/^pi5: git checkout/)).toBeLessThan(
      exec.indexOf(/^pizero: git checkout/),
    );
  });

  it("warns once, at plan time, when an unrecognized path forced a full deploy", async () => {
    const exec = fake(["packages/something-new/src/x.ts"]);
    await deploy(inventory, exec, options(), report);
    expect(report.warnings.join("\n")).toMatch(/match no rule/);
    expect(report.warnings.join("\n")).toMatch(
      /packages\/something-new\/src\/x\.ts/,
    );
  });

  it("changes nothing that runs on a dry run", async () => {
    const exec = fake(["packages/amp/src/server.ts"]);
    await deploy(inventory, exec, options({ dryRun: true }), report);
    for (const forbidden of [
      /git checkout/,
      /systemctl restart/,
      /install -D/,
      /pnpm/,
      /pip install/,
      /reboot/,
    ]) {
      expect(exec.ran(forbidden)).toBe(false);
    }
  });

  it("still fetches on a dry run, so the plan is the real one", async () => {
    // Found by running it: without the fetch the hosts don't have the target commit, `git diff`
    // can't resolve, and every host escalates to a full deploy — so --dry-run printed the
    // pessimistic plan rather than what a deploy would actually do. A fetch writes refs and objects
    // into .git and touches neither the working tree nor a running service.
    const exec = fake(["packages/amp/src/server.ts"]);
    await deploy(inventory, exec, options({ dryRun: true }), report);
    expect(exec.ran(/git fetch/)).toBe(true);
    expect(exec.ran(/git diff --name-only/)).toBe(true);
  });

  it("--full rebuilds everything regardless of the diff", async () => {
    const exec = fake(["docs/runbook.md"]);
    await deploy(inventory, exec, options({ full: true }), report);
    expect(exec.ran(/pnpm --filter @marquee\/amp build/)).toBe(true);
    expect(exec.ran(/pip install --no-deps/)).toBe(true);
  });
});

describe("restricting a change set to one host", () => {
  it("drops services the host doesn't run", () => {
    const e = restrictToHost(fullEffects(), pizero);
    expect([...e.build]).toEqual([]);
    expect([...e.restart]).toEqual(["stylus"]);
    expect(e.kioskReload).toBe(false);
    expect(e.pipInstall).toBe(true);
  });

  it("skips the install when the host will build nothing", () => {
    // A `pnpm install` on the Pi Zero for a lockfile change is minutes of native compilation for a
    // service that is Python and builds nothing.
    expect(
      restrictToHost(effectsFor(["pnpm-lock.yaml"]), pizero).pnpmInstall,
    ).toBe(false);
    expect(
      restrictToHost(effectsFor(["pnpm-lock.yaml"]), pi5).pnpmInstall,
    ).toBe(true);
  });

  it("keeps the kiosk reload only for the host that drives the display", () => {
    const changed = effectsFor(["packages/backdrop/public/index.html"]);
    expect(restrictToHost(changed, pi5).kioskReload).toBe(true);
    expect(restrictToHost(changed, pizero).kioskReload).toBe(false);
  });
});

describe("describeEffects", () => {
  it("summarises a change set in the order the work happens", () => {
    expect(describeEffects(effectsFor(["pnpm-lock.yaml"]))).toMatch(
      /^pnpm install; build .*; pip install stylus; converge assets; restart /,
    );
  });

  it("is empty for an empty change set", () => {
    expect(describeEffects(effectsFor(["docs/x.md"]))).toBe("");
  });
});

describe("errors are the actionable kind", () => {
  it("names the host, the unit and the fix when a restart is stale", async () => {
    const exec = fake(["packages/amp/src/server.ts"]).route(
      /ActiveEnterTimestamp/,
      {
        stdout: `${Math.floor(CLOCK / 1000) - 3600}\n`,
      },
    );
    const err = await run(pi5, ["packages/amp/src/server.ts"], exec).catch(
      (e: Error) => e,
    );
    expect(err).toBeInstanceOf(DeployError);
    expect((err as Error).message).toContain("pi5");
    expect((err as Error).message).toContain("marquee-amp");
  });

  it("distinguishes a stale Curator from a deploy failure", () => {
    // Different class, because the fix is different: nothing on a Pi is wrong, and the operator has
    // to restart an app rather than re-run anything.
    expect(new CuratorStaleError("x")).not.toBeInstanceOf(DeployError);
  });
});
