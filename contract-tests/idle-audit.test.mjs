import { test } from "node:test";
import assert from "node:assert/strict";
import {
  diffSnapshots,
  descendantsOf,
  formatMarkdownTable,
  labelProcess,
  normalizeSnapshot,
  parseArgs,
  selectPids,
  summarize,
} from "../scripts/idle-audit.mjs";

// The idle harness (issue #137) is the instrument the idle baseline is measured with, so its
// arithmetic has to be trustworthy on its own — a harness that quietly reports 0% is
// indistinguishable from a system that is genuinely quiet, which is the exact failure the baseline
// exists to make visible. Everything here is the pure half: snapshot in, numbers out. The one
// Windows-only piece (the Win32_Process query) is deliberately the only untested line.

const SECOND = 1e7; // Win32_Process CPU counters are in 100-ns units

/** A snapshot in the shape ConvertTo-Json produces, before normalization. */
function rawSnapshot({
  takenAt,
  processes,
  listeners = [],
  logicalProcessors = 8,
}) {
  return { takenAt, logicalProcessors, processes, listeners };
}

function proc(overrides) {
  return {
    pid: 1,
    ppid: 0,
    name: "node.exe",
    commandLine: "node server.js",
    cpu100ns: 0,
    workingSet: 100 * 1024 * 1024,
    createdAt: "2026-08-02T10:00:00.0000000Z",
    ...overrides,
  };
}

test("normalizeSnapshot folds listening ports onto their owning process", () => {
  const snap = normalizeSnapshot(
    rawSnapshot({
      takenAt: "2026-08-02T12:00:00.000Z",
      processes: [proc({ pid: 10 }), proc({ pid: 11 })],
      listeners: [
        { pid: 10, port: 4739 },
        { pid: 10, port: 4739 }, // IPv4 + IPv6 bind of the same port
        { pid: 11, port: 62000 },
      ],
    }),
  );
  assert.deepEqual(snap.processes.get(10).ports, [4739]);
  assert.deepEqual(snap.processes.get(11).ports, [62000]);
});

test("normalizeSnapshot survives PowerShell collapsing single-element arrays", () => {
  // ConvertTo-Json emits a bare object for a one-element array and omits an empty one entirely;
  // both shapes reach this code from a real run with one service up.
  const snap = normalizeSnapshot({
    takenAt: "2026-08-02T12:00:00.000Z",
    logicalProcessors: 4,
    processes: proc({ pid: 7 }),
    listeners: { pid: 7, port: 4737 },
  });
  assert.equal(snap.processes.size, 1);
  assert.deepEqual(snap.processes.get(7).ports, [4737]);

  const empty = normalizeSnapshot({
    takenAt: "2026-08-02T12:00:00.000Z",
    logicalProcessors: 4,
  });
  assert.equal(empty.processes.size, 0);
  assert.equal(empty.logicalProcessors, 4);
});

test("descendantsOf collects a whole tree, not just direct children", () => {
  const { processes } = normalizeSnapshot(
    rawSnapshot({
      takenAt: "2026-08-02T12:00:00.000Z",
      processes: [
        proc({ pid: 100, ppid: 1 }), // turbo
        proc({ pid: 101, ppid: 100 }), // tsx watch
        proc({ pid: 102, ppid: 101 }), // esbuild child of tsx
        proc({ pid: 200, ppid: 1 }), // unrelated
      ],
    }),
  );
  assert.deepEqual(
    [...descendantsOf(processes, [100])].sort(),
    [100, 101, 102],
  );
  assert.deepEqual([...descendantsOf(processes, [999])], [], "unknown root");
});

test("descendantsOf refuses a 'child' older than its parent (recycled pid)", () => {
  // The real thing, from the first full sweep: figma_agent.exe had run for five days, its actual
  // parent was long dead, and Windows had handed that pid to Marquee's renderer — so the orphan
  // still pointed at it and got charged to the desktop app's idle cost.
  const { processes } = normalizeSnapshot(
    rawSnapshot({
      takenAt: "2026-08-02T12:00:00.000Z",
      processes: [
        proc({ pid: 100, ppid: 1, createdAt: "2026-08-02T11:58:00.0000000Z" }),
        proc({
          pid: 30624, // the renderer, freshly started
          ppid: 100,
          createdAt: "2026-08-02T11:58:02.0000000Z",
        }),
        proc({
          pid: 23064, // five-day-old orphan pointing at the recycled pid
          ppid: 30624,
          name: "figma_agent.exe",
          createdAt: "2026-07-28T15:37:14.0000000Z",
        }),
      ],
    }),
  );
  assert.deepEqual(
    [...descendantsOf(processes, [100])].sort((a, b) => a - b),
    [100, 30624],
    "the stranger is not adopted",
  );
});

test("descendantsOf keeps a child whose creation time is unreadable", () => {
  // Dropping a real child understates the cost being measured, which is the worse failure; an
  // unparseable timestamp must not silently shrink the tree.
  const { processes } = normalizeSnapshot(
    rawSnapshot({
      takenAt: "2026-08-02T12:00:00.000Z",
      processes: [
        proc({ pid: 100, ppid: 1, createdAt: "2026-08-02T11:58:00.0000000Z" }),
        proc({ pid: 101, ppid: 100, createdAt: null }),
      ],
    }),
  );
  assert.deepEqual(
    [...descendantsOf(processes, [100])].sort((a, b) => a - b),
    [100, 101],
  );
});

test("selectPids unions the root tree with the command-line match", () => {
  const { processes } = normalizeSnapshot(
    rawSnapshot({
      takenAt: "2026-08-02T12:00:00.000Z",
      processes: [
        proc({ pid: 100, ppid: 1 }),
        proc({ pid: 101, ppid: 100 }),
        proc({
          pid: 300,
          ppid: 1,
          commandLine: "node dist/server.js --curator",
        }),
      ],
    }),
  );
  assert.deepEqual(
    [...selectPids(processes, { roots: [100], match: "curator" })].sort(),
    [100, 101, 300],
  );
});

test("labelProcess names a service by its listening port before anything else", () => {
  assert.equal(
    labelProcess({
      name: "node.exe",
      commandLine: "node dist/server.js",
      ports: [4739],
    }),
    "curator (:4739)",
  );
  assert.equal(
    labelProcess({
      name: "node.exe",
      commandLine: "node dist/server.js",
      ports: [4737],
    }),
    "hue-conductor (:4737)",
  );
});

test("labelProcess distinguishes Electron's child processes", () => {
  const cases = [
    ["electron.exe", "electron.exe dist/main.js", "electron main"],
    [
      "electron.exe",
      "electron.exe --type=renderer --lang=en-US",
      "electron renderer",
    ],
    ["electron.exe", "electron.exe --type=gpu-process", "electron gpu-process"],
    [
      "electron.exe",
      "electron.exe --type=utility --utility-sub-type=x",
      "electron utility",
    ],
  ];
  for (const [name, commandLine, expected] of cases) {
    assert.equal(labelProcess({ name, commandLine, ports: [] }), expected);
  }
});

test("labelProcess still separates Electron's children once electron-builder renames the exe", () => {
  // Caught on the first real run against the packaged app: electron-builder renames electron.exe to
  // the product name, so matching on the executable name collapsed main/gpu/renderer/utility into
  // five indistinguishable `Marquee.exe` rows — and the renderer is the row this audit exists to
  // watch. The `--type=` flag is the signal that survives the rename.
  const cases = [
    ["Marquee.exe --type=renderer --user-data-dir=x", "Marquee renderer"],
    [
      "Marquee.exe --type=gpu-process --gpu-preferences=x",
      "Marquee gpu-process",
    ],
    [
      "Marquee.exe --type=utility --utility-sub-type=network.mojom.NetworkService",
      "Marquee utility",
    ],
  ];
  for (const [commandLine, expected] of cases) {
    assert.equal(
      labelProcess({ name: "Marquee.exe", commandLine, ports: [] }),
      expected,
    );
  }
  // A non-Chromium program that happens to take a --type flag must not be mislabelled.
  assert.equal(
    labelProcess({
      name: "node.exe",
      commandLine: "node build.mjs --type=esm",
      ports: [],
    }),
    "node.exe build.mjs",
  );
});

test("labelProcess names the dev-mode tooling the audit is aimed at", () => {
  const cases = [
    ["turbo.exe run dev", "turbo"],
    ["node .../tsx/dist/cli.mjs watch src/server.ts", "tsx watch"],
    ["node .../esbuild.exe --service=0.23.0", "esbuild service"],
    ["node .../vite/bin/vite.js", "vite"],
    ["node .../tsc.js --build --watch", "tsc --watch"],
  ];
  for (const [commandLine, expected] of cases) {
    assert.equal(
      labelProcess({ name: "node.exe", commandLine, ports: [] }),
      expected,
      commandLine,
    );
  }
  // Nothing recognizable still beats a bare `node.exe` wall.
  assert.equal(
    labelProcess({
      name: "node.exe",
      commandLine: "node C:/x/scripts/gen-schemas.mjs",
      ports: [],
    }),
    "node.exe gen-schemas.mjs",
  );
});

test("diffSnapshots converts the counter delta into core and machine percentages", () => {
  const before = normalizeSnapshot(
    rawSnapshot({
      takenAt: "2026-08-02T12:00:00.000Z",
      logicalProcessors: 8,
      processes: [proc({ pid: 10, cpu100ns: 100 * SECOND })],
    }),
  );
  const after = normalizeSnapshot(
    rawSnapshot({
      takenAt: "2026-08-02T12:02:00.000Z", // 120s later
      logicalProcessors: 8,
      processes: [proc({ pid: 10, cpu100ns: 106 * SECOND })], // 6 CPU-seconds
    }),
  );
  const diff = diffSnapshots(before, after);
  assert.equal(diff.wallSeconds, 120);
  const [row] = diff.rows;
  assert.equal(row.cpuSeconds, 6);
  assert.ok(Math.abs(row.coreLoadPct - 5) < 1e-9, "6s/120s = 5% of one core");
  assert.ok(
    Math.abs(row.machinePct - 0.625) < 1e-9,
    "5% of one core on 8 cores = 0.625% of the machine",
  );
});

test("diffSnapshots does not credit a reused pid with the previous process's CPU", () => {
  // Windows recycles pids fast. Matching on pid alone would subtract the dead process's counter
  // from the new one's and report a large negative — or, if the new one had run longer, a
  // plausible-looking wrong number, which is worse.
  const before = normalizeSnapshot(
    rawSnapshot({
      takenAt: "2026-08-02T12:00:00.000Z",
      processes: [
        proc({
          pid: 10,
          cpu100ns: 500 * SECOND,
          createdAt: "2026-08-02T09:00:00.0000000Z",
        }),
      ],
    }),
  );
  const after = normalizeSnapshot(
    rawSnapshot({
      takenAt: "2026-08-02T12:02:00.000Z",
      processes: [
        proc({
          pid: 10,
          cpu100ns: 3 * SECOND,
          createdAt: "2026-08-02T12:01:00.0000000Z", // different process, same pid
        }),
      ],
    }),
  );
  const diff = diffSnapshots(before, after);
  const [row] = diff.rows;
  assert.equal(
    row.cpuSeconds,
    3,
    "counted from zero, not from the old counter",
  );
  assert.equal(row.startedDuringWindow, true);
  // Born 60s before the window closed, so its rate is over 60s, not the full 120s.
  assert.ok(Math.abs(row.coreLoadPct - 5) < 1e-9);
  assert.deepEqual(
    diff.exited.map((e) => e.pid),
    [10],
    "the process that vacated the pid is reported as exited",
  );
});

test("diffSnapshots reports processes that vanished during the window", () => {
  const before = normalizeSnapshot(
    rawSnapshot({
      takenAt: "2026-08-02T12:00:00.000Z",
      processes: [proc({ pid: 10 }), proc({ pid: 11, name: "esbuild.exe" })],
    }),
  );
  const after = normalizeSnapshot(
    rawSnapshot({
      takenAt: "2026-08-02T12:02:00.000Z",
      processes: [proc({ pid: 10 })],
    }),
  );
  const diff = diffSnapshots(before, after);
  assert.deepEqual(
    diff.exited.map((e) => e.name),
    ["esbuild.exe"],
  );
});

test("diffSnapshots refuses snapshots that are out of order or simultaneous", () => {
  const at = (takenAt) =>
    normalizeSnapshot(rawSnapshot({ takenAt, processes: [proc({})] }));
  assert.throws(
    () =>
      diffSnapshots(
        at("2026-08-02T12:02:00.000Z"),
        at("2026-08-02T12:00:00.000Z"),
      ),
    /not in order/,
  );
  assert.throws(
    () =>
      diffSnapshots(
        at("2026-08-02T12:00:00.000Z"),
        at("2026-08-02T12:00:00.000Z"),
      ),
    /not apart in time/,
  );
});

test("diffSnapshots keeps the System Idle Process out of the totals", () => {
  // Caught on this script's first live run: pid 0 accumulates every *unused* cycle on every core,
  // so summing it in reported the machine at 101.72% busy while it sat at rest.
  const mk = (takenAt, idleCpu, realCpu) =>
    normalizeSnapshot(
      rawSnapshot({
        takenAt,
        logicalProcessors: 8,
        processes: [
          proc({
            pid: 0,
            name: "System Idle Process",
            cpu100ns: idleCpu * SECOND,
          }),
          proc({ pid: 10, cpu100ns: realCpu * SECOND }),
        ],
      }),
    );
  // 100s window, 8 cores = 800 core-seconds. 8 go to real work, 792 are idle.
  const diff = diffSnapshots(
    mk("2026-08-02T12:00:00.000Z", 0, 0),
    mk("2026-08-02T12:01:40.000Z", 792, 8),
  );
  assert.deepEqual(
    diff.rows.map((r) => r.pid),
    [10],
    "pid 0 is not a row",
  );
  const s = summarize(diff, new Set([10]));
  assert.ok(Math.abs(s.machineWideMachinePct - 1) < 1e-9, "1% busy, not 100%");
  assert.ok(
    Math.abs(s.accountedMachinePct - 100) < 1e-9,
    "busy + idle accounts for the whole machine",
  );
});

test("diffSnapshots drops ignored pids from rows, churn and totals alike", () => {
  // The sampler's own node process and its two PowerShell children would otherwise report as
  // 2 started / 2 exited on every run, teaching you to ignore the churn line.
  const before = normalizeSnapshot(
    rawSnapshot({
      takenAt: "2026-08-02T12:00:00.000Z",
      processes: [
        proc({ pid: 10 }),
        proc({ pid: 900, name: "node.exe" }), // the sampler
        proc({ pid: 901, ppid: 900, name: "powershell.exe" }), // its first snapshot child
      ],
    }),
  );
  const after = normalizeSnapshot(
    rawSnapshot({
      takenAt: "2026-08-02T12:01:40.000Z",
      processes: [
        proc({ pid: 10, cpu100ns: 1 * SECOND }),
        proc({ pid: 900, name: "node.exe", cpu100ns: 5 * SECOND }),
        proc({ pid: 902, ppid: 900, name: "powershell.exe" }), // its second one
      ],
    }),
  );
  const diff = diffSnapshots(before, after, {
    ignorePids: new Set([900, 901, 902]),
  });
  assert.deepEqual(
    diff.rows.map((r) => r.pid),
    [10],
  );
  assert.equal(diff.started.length, 0, "the sampler's own child is not churn");
  assert.equal(diff.exited.length, 0);
  assert.ok(
    Math.abs(summarize(diff, new Set([10])).machineWideCoreLoadPct - 1) < 1e-9,
    "the sampler's own 5 CPU-seconds are not charged to the machine",
  );
});

test("summarize totals only the selected processes but keeps the machine-wide floor", () => {
  const mk = (takenAt, cpus) =>
    normalizeSnapshot(
      rawSnapshot({
        takenAt,
        logicalProcessors: 10,
        processes: cpus.map(([pid, cpu, ports]) =>
          proc({ pid, cpu100ns: cpu * SECOND }),
        ),
        listeners: cpus.flatMap(([pid, , port]) =>
          port ? [{ pid, port }] : [],
        ),
      }),
    );
  const before = mk("2026-08-02T12:00:00.000Z", [
    [10, 0, 4739],
    [11, 0, null],
  ]);
  const after = mk("2026-08-02T12:01:40.000Z", [
    // 100s window
    [10, 1, 4739], // ours: 1% of a core
    [11, 9, null], // someone else's: 9% of a core
  ]);
  const diff = diffSnapshots(before, after);
  const s = summarize(diff, new Set([10]));
  assert.equal(s.processCount, 1);
  assert.ok(Math.abs(s.coreLoadPct - 1) < 1e-9);
  assert.ok(Math.abs(s.machinePct - 0.1) < 1e-9);
  assert.ok(
    Math.abs(s.machineWideCoreLoadPct - 10) < 1e-9,
    "the other 9% is still reported, as the floor the 1% sits on",
  );
  assert.equal(s.startedDuringWindow, 0);
  assert.equal(s.exitedDuringWindow, 0);
});

test("formatMarkdownTable emits only in-scope rows, hottest first", () => {
  const mk = (takenAt, cpus) =>
    normalizeSnapshot(
      rawSnapshot({
        takenAt,
        processes: cpus.map(([pid, cpu]) =>
          proc({ pid, cpu100ns: cpu * SECOND }),
        ),
      }),
    );
  const diff = diffSnapshots(
    mk("2026-08-02T12:00:00.000Z", [
      [10, 0],
      [11, 0],
      [12, 0],
    ]),
    mk("2026-08-02T12:01:40.000Z", [
      [10, 1],
      [11, 5],
      [12, 99],
    ]),
  );
  const table = formatMarkdownTable(diff, new Set([10, 11]));
  const pids = [...table.matchAll(/^\| .*? \| (\d+) \|/gm)].map((m) => m[1]);
  assert.deepEqual(pids, ["11", "10"], "hottest first, pid 12 excluded");
  assert.equal(
    formatMarkdownTable(diff, new Set()),
    "_(no processes in scope)_",
  );
});

test("parseArgs takes both --flag value and --flag=value", () => {
  assert.deepEqual(
    parseArgs(["--label", "pnpm-dev", "--duration", "60", "--root", "10,11"]),
    {
      label: "pnpm-dev",
      duration: 60,
      settle: 0,
      roots: [10, 11],
      match: null,
      out: null,
    },
  );
  assert.deepEqual(parseArgs(["--label=curator", "--match=curator"]), {
    label: "curator",
    duration: 120,
    settle: 0,
    roots: [],
    match: "curator",
    out: null,
  });
});

test("parseArgs rejects input that would silently produce a meaningless run", () => {
  assert.throws(
    () => parseArgs(["--duration", "0"]),
    /--duration must be positive/,
  );
  assert.throws(
    () => parseArgs(["--duration", "abc"]),
    /--duration must be positive/,
  );
  assert.throws(() => parseArgs(["--root", "notapid"]), /comma-separated pids/);
  assert.throws(() => parseArgs(["--nope"]), /unknown flag: --nope/);
});
