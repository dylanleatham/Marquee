#!/usr/bin/env node
// Measure what Marquee costs when nothing is happening (issue #137).
//
// Marquee is an always-on system: Curator, Conductor, Backdrop and Amp sit at zero traffic for
// hours at a time, so idle cost is a product requirement. "The laptop runs hot" is a feeling; this
// turns it into a number, the same number every time, so a regression is detectable rather than
// felt. The measured baseline lives in docs/specs/idle-cost-baseline.md.
//
// Method: two snapshots of Win32_Process, `--duration` seconds apart. Every process carries
// KernelModeTime + UserModeTime as monotonic 100-ns counters, so the delta between snapshots is
// exactly the CPU time that process burned during the window — no sampling error, no dependency on
// perf-counter names (which are localized) or on Task Manager's qualitative "power usage" bucket.
//
// Usage (PowerShell — see CLAUDE.md, Git Bash mangles the path env vars the services read):
//   node scripts/idle-audit.mjs --label baseline --duration 120
//   node scripts/idle-audit.mjs --label pnpm-dev --root 12345 --settle 60
//   node scripts/idle-audit.mjs --label curator-alone --match "curator" --out perf-samples
//
// With no --root/--match the run is a machine-only control: the noise floor to subtract. Every run
// reports the machine-wide total too, because a per-process number is meaningless if the machine
// under it was busy.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const PS_TIMEOUT_MS = 60_000; // a WMI enumeration that hangs must not wedge the run
const MAX_BUFFER = 64 * 1024 * 1024;
const HUNDRED_NS_PER_SECOND = 1e7;

/** Chromium's own `--type=` values. Anything else on a `--type=` flag is some other program's. */
const CHROMIUM_CHILD_TYPES = new Set([
  "renderer",
  "gpu-process",
  "utility",
  "zygote",
  "crashpad-handler",
  "ppapi",
  "broker",
]);

/** Listening port → the service that owns it, so a wall of identical `node.exe` rows reads. */
export const SERVICE_PORTS = new Map([
  [4737, "hue-conductor"],
  [4739, "curator"],
  [4740, "backdrop"],
  [4741, "amp"],
]);

/**
 * One PowerShell round-trip for the whole snapshot: processes (with the CPU counters, the command
 * line, and the parent link) plus the listening sockets that name them. `-Compress` because the
 * default formatter is slower than the query.
 */
const SNAPSHOT_PS = `
$ErrorActionPreference = 'Stop'
$procs = Get-CimInstance Win32_Process | ForEach-Object {
  [pscustomobject]@{
    pid          = [int]$_.ProcessId
    ppid         = [int]$_.ParentProcessId
    name         = $_.Name
    commandLine  = $_.CommandLine
    cpu100ns     = [double]$_.KernelModeTime + [double]$_.UserModeTime
    workingSet   = [double]$_.WorkingSetSize
    createdAt    = if ($_.CreationDate) { $_.CreationDate.ToUniversalTime().ToString('o') } else { $null }
  }
}
$listeners = @()
try {
  $listeners = Get-NetTCPConnection -State Listen -ErrorAction Stop | ForEach-Object {
    [pscustomobject]@{ pid = [int]$_.OwningProcess; port = [int]$_.LocalPort }
  }
} catch { $listeners = @() }
[pscustomobject]@{
  takenAt           = [DateTime]::UtcNow.ToString('o')
  logicalProcessors = [int]$env:NUMBER_OF_PROCESSORS
  processes         = @($procs)
  listeners         = @($listeners)
} | ConvertTo-Json -Depth 4 -Compress
`;

function powershell(script) {
  return execFileSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { encoding: "utf8", timeout: PS_TIMEOUT_MS, maxBuffer: MAX_BUFFER },
  );
}

/** Take one snapshot. Separated from the parsing so the pure half stays testable off-Windows. */
export function takeSnapshot() {
  return normalizeSnapshot(JSON.parse(powershell(SNAPSHOT_PS)));
}

/**
 * ConvertTo-Json collapses a one-element array to a bare object and drops an empty one, so both
 * lists get coerced back. Ports are folded onto their process here: after this, a snapshot is a
 * plain map of pid → process, which is the only shape the rest of the file knows about.
 */
export function normalizeSnapshot(raw) {
  const asArray = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);
  const portsByPid = new Map();
  for (const { pid, port } of asArray(raw.listeners)) {
    if (!portsByPid.has(pid)) portsByPid.set(pid, new Set());
    portsByPid.get(pid).add(port);
  }
  const processes = new Map();
  for (const p of asArray(raw.processes)) {
    processes.set(p.pid, {
      ...p,
      commandLine: p.commandLine ?? "",
      ports: [...(portsByPid.get(p.pid) ?? [])].sort((a, b) => a - b),
    });
  }
  return {
    takenAt: raw.takenAt,
    logicalProcessors: Number(raw.logicalProcessors) || 1,
    processes,
  };
}

/**
 * Every descendant of `roots`, roots included. Walks children rather than parents because a
 * launcher that has already exited (pnpm hands off to turbo and lingers only sometimes) would
 * otherwise orphan the whole subtree out of the measurement.
 *
 * **A child may not predate its parent.** Windows never clears `ParentProcessId`, so an orphan keeps
 * pointing at a pid the OS is free to hand to somebody else — and then the orphan looks like a child
 * of whatever now holds that number. This is not hypothetical: the first full sweep charged the
 * desktop app with a `figma_agent.exe` that had been running for five days, because the pid of its
 * long-dead parent had been recycled into Marquee's renderer. It inflated the app's measured idle
 * cost by 0.2% of a core — about 18% of the real figure, in the one configuration the baseline cares
 * most about. Comparing creation times is the whole fix: a real child is always younger.
 */
export function descendantsOf(processes, roots) {
  const childrenOf = new Map();
  for (const p of processes.values()) {
    if (!childrenOf.has(p.ppid)) childrenOf.set(p.ppid, []);
    childrenOf.get(p.ppid).push(p.pid);
  }
  const bornAt = (pid) => Date.parse(processes.get(pid)?.createdAt ?? "");
  const seen = new Set();
  const queue = roots.filter((pid) => processes.has(pid));
  while (queue.length > 0) {
    const pid = queue.shift();
    if (seen.has(pid)) continue;
    seen.add(pid);
    for (const child of childrenOf.get(pid) ?? []) {
      if (seen.has(child)) continue;
      // Unparseable timestamps on either side → keep the link. Dropping a real child is the worse
      // error: it silently understates the very cost being measured.
      const [parentBorn, childBorn] = [bornAt(pid), bornAt(child)];
      if (
        Number.isFinite(parentBorn) &&
        Number.isFinite(childBorn) &&
        childBorn < parentBorn
      ) {
        continue;
      }
      queue.push(child);
    }
  }
  return seen;
}

/** The pids in scope for this run: the root trees, plus anything whose command line matches. */
export function selectPids(processes, { roots = [], match = null } = {}) {
  const selected = descendantsOf(processes, roots);
  if (match) {
    const re = new RegExp(match, "i");
    for (const p of processes.values()) {
      if (re.test(p.commandLine) || re.test(p.name)) selected.add(p.pid);
    }
  }
  return selected;
}

/**
 * A readable name for a process whose `name` is `node.exe` forty times over. Ordered most-specific
 * first: a listening port is the strongest signal (it says which *service* this is), then the
 * Electron child-process type, then the tool on the command line.
 */
export function labelProcess(p) {
  for (const port of p.ports ?? []) {
    const service = SERVICE_PORTS.get(port);
    if (service) return `${service} (:${port})`;
  }
  const cmd = p.commandLine ?? "";
  // Keyed off Chromium's `--type=` flag rather than the executable name, because electron-builder
  // renames electron.exe to the product name: the packaged app's renderer is `Marquee.exe`, and
  // name-matching lost it in a wall of five identical `Marquee.exe` rows on the first real run.
  // The renderer is the row that matters most here — a stray rAF loop or an interval that ignores
  // `visibilitychange` (issues #135, #136) shows up there and nowhere else.
  const childType = /--type=([a-z-]+)/i.exec(cmd)?.[1]?.toLowerCase();
  if (childType && CHROMIUM_CHILD_TYPES.has(childType)) {
    return `${p.name.replace(/\.exe$/i, "")} ${childType}`;
  }
  if (/electron/i.test(p.name)) return "electron main";
  for (const [re, label] of [
    [/\bturbo(\.exe)?\b/i, "turbo"],
    [/\besbuild(\.exe)?\b/i, "esbuild service"],
    [/\bvite\b/i, "vite"],
    [/\btsx\b.*\bwatch\b/i, "tsx watch"],
    [/\btsc\b.*(--watch|-w)\b/i, "tsc --watch"],
    [/\bpnpm\b/i, "pnpm"],
    [/\bvitest\b/i, "vitest"],
  ]) {
    if (re.test(cmd)) return label;
  }
  const script = /\b([\w.-]+\.(?:mjs|cjs|js|ts))\b/.exec(cmd)?.[1];
  return script ? `${p.name} ${script}` : p.name;
}

/**
 * Windows' "System Idle Process" is a real row in Win32_Process and its CPU counter accumulates
 * every *un*used cycle on every core — on an 8-core box at rest it alone reads ~800% of one core.
 * Summing it into a machine-wide total made the first live run of this script report a machine at
 * 101%, which is how it was caught. It is excluded from every total and used instead as a free
 * arithmetic check: busy + idle should land on 100% of the machine.
 */
export const IDLE_PROCESS_PID = 0;

/**
 * CPU burned between two snapshots, per process.
 *
 * Matched on pid **and** creation time: Windows reuses pids aggressively, and a reused pid whose
 * counter reset would otherwise read as a huge negative delta (or, worse, a plausible small one).
 * A process that started mid-window is measured from its own creation; one that exited during the
 * window is reported separately, because churn at idle is itself the finding — nothing should be
 * starting and stopping when no records are being scanned.
 *
 * `ignorePids` drops the measurement apparatus out of its own measurement: this script and the two
 * PowerShell children it spawns to take the snapshots would otherwise show up as 2 started and 2
 * exited on every single run, which trains you to ignore the churn line that is the point of it.
 */
export function diffSnapshots(before, after, { ignorePids = new Set() } = {}) {
  const wallSeconds =
    (Date.parse(after.takenAt) - Date.parse(before.takenAt)) / 1000;
  if (!(wallSeconds > 0)) {
    throw new Error(
      `snapshots are not ${wallSeconds === 0 ? "apart in time" : "in order"}: ${before.takenAt} → ${after.takenAt}`,
    );
  }
  const cores = after.logicalProcessors;
  const rows = [];
  const started = [];
  let idleMachinePct = 0;
  for (const [pid, now] of after.processes) {
    if (ignorePids.has(pid)) continue;
    const was = before.processes.get(pid);
    const sameProcess = was && was.createdAt === now.createdAt;
    const cpu100ns = now.cpu100ns - (sameProcess ? was.cpu100ns : 0);
    // A process born mid-window has had less than the full window to burn CPU; charging it the
    // whole window would understate its rate.
    const bornAt = sameProcess ? null : Date.parse(now.createdAt ?? "");
    const seconds =
      bornAt && Number.isFinite(bornAt)
        ? Math.min(wallSeconds, (Date.parse(after.takenAt) - bornAt) / 1000)
        : wallSeconds;
    const cpuSeconds = cpu100ns / HUNDRED_NS_PER_SECOND;
    const row = {
      pid,
      label: labelProcess(now),
      name: now.name,
      commandLine: now.commandLine,
      // Kept in the saved sample so a suspicious attribution can be re-checked afterwards without
      // re-running: a row far older than the root it was charged to is the pid-reuse tell.
      createdAt: now.createdAt,
      ports: now.ports,
      cpuSeconds,
      // Two denominators, because both questions get asked: "is this process pinning a core?"
      // (coreLoadPct) and "how much of the machine is Marquee?" (machinePct).
      coreLoadPct: seconds > 0 ? (cpuSeconds / seconds) * 100 : 0,
      machinePct: seconds > 0 ? (cpuSeconds / seconds / cores) * 100 : 0,
      workingSetMb: now.workingSet / (1024 * 1024),
      startedDuringWindow: !sameProcess,
    };
    if (pid === IDLE_PROCESS_PID) {
      idleMachinePct = row.machinePct;
      continue;
    }
    rows.push(row);
    if (!sameProcess) started.push(row);
  }
  const exited = [];
  for (const [pid, was] of before.processes) {
    if (ignorePids.has(pid) || pid === IDLE_PROCESS_PID) continue;
    const now = after.processes.get(pid);
    if (!now || now.createdAt !== was.createdAt) {
      exited.push({ pid, label: labelProcess(was), name: was.name });
    }
  }
  rows.sort((a, b) => b.cpuSeconds - a.cpuSeconds);
  return {
    wallSeconds,
    logicalProcessors: cores,
    rows,
    started,
    exited,
    idleMachinePct,
  };
}

/** Roll a diff up into the numbers the baseline doc quotes. */
export function summarize(diff, selectedPids) {
  const inScope = diff.rows.filter((r) => selectedPids.has(r.pid));
  const total = (rows, key) => rows.reduce((sum, r) => sum + r[key], 0);
  return {
    wallSeconds: diff.wallSeconds,
    logicalProcessors: diff.logicalProcessors,
    processCount: inScope.length,
    cpuSeconds: total(inScope, "cpuSeconds"),
    coreLoadPct: total(inScope, "coreLoadPct"),
    machinePct: total(inScope, "machinePct"),
    workingSetMb: total(inScope, "workingSetMb"),
    // Machine-wide, so a per-process figure can be read against what the box was doing. Without
    // this a quiet run and a run competing with a Windows Update look identical on paper.
    machineWideCoreLoadPct: total(diff.rows, "coreLoadPct"),
    machineWideMachinePct: total(diff.rows, "machinePct"),
    // Busy + idle should be 100% of the machine. A number far off that means the snapshots drifted
    // (a suspended laptop mid-window is the usual cause) and the run should be thrown away rather
    // than quoted.
    accountedMachinePct: total(diff.rows, "machinePct") + diff.idleMachinePct,
    startedDuringWindow: diff.started.length,
    exitedDuringWindow: diff.exited.length,
  };
}

const pct = (n) => `${n.toFixed(2)}%`;

/** The table that gets pasted into the baseline doc. */
export function formatMarkdownTable(diff, selectedPids, { top = 20 } = {}) {
  const inScope = diff.rows.filter((r) => selectedPids.has(r.pid));
  if (inScope.length === 0) return "_(no processes in scope)_";
  const lines = [
    "| Process | pid | CPU s | % of 1 core | % of machine | RSS MB |",
    "| --- | ---: | ---: | ---: | ---: | ---: |",
  ];
  for (const r of inScope.slice(0, top)) {
    lines.push(
      `| ${r.label}${r.startedDuringWindow ? " ⚠︎started mid-window" : ""} | ${r.pid} | ${r.cpuSeconds.toFixed(2)} | ${pct(r.coreLoadPct)} | ${pct(r.machinePct)} | ${r.workingSetMb.toFixed(0)} |`,
    );
  }
  if (inScope.length > top) {
    lines.push(`| _…${inScope.length - top} more_ | | | | | |`);
  }
  return lines.join("\n");
}

export function formatReport(label, diff, selectedPids) {
  const s = summarize(diff, selectedPids);
  return [
    `## ${label}`,
    "",
    `- window: ${s.wallSeconds.toFixed(1)}s on ${s.logicalProcessors} logical processors`,
    `- in scope: ${s.processCount} processes, ${s.cpuSeconds.toFixed(2)} CPU-seconds`,
    `- **idle cost: ${pct(s.coreLoadPct)} of one core = ${pct(s.machinePct)} of the machine**`,
    `- resident: ${s.workingSetMb.toFixed(0)} MB`,
    `- machine-wide during the window: ${pct(s.machineWideMachinePct)} busy (the noise floor this sits on)`,
    `- accounting check: ${pct(s.accountedMachinePct)} of the machine attributed (busy + idle; should be ~100%)`,
    s.startedDuringWindow > 0 || s.exitedDuringWindow > 0
      ? `- churn: ${s.startedDuringWindow} started, ${s.exitedDuringWindow} exited — an idle system should show none`
      : "- churn: none (no process started or exited)",
    "",
    formatMarkdownTable(diff, selectedPids),
  ].join("\n");
}

export function parseArgs(argv) {
  const args = {
    label: "idle",
    duration: 120,
    settle: 0,
    roots: [],
    match: null,
    out: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const [flag, inlineValue] = argv[i].split(/=(.*)/s);
    const value = () => inlineValue ?? argv[++i];
    switch (flag) {
      case "--label":
        args.label = value();
        break;
      case "--duration":
        args.duration = Number(value());
        break;
      case "--settle":
        args.settle = Number(value());
        break;
      case "--root":
        args.roots.push(...value().split(",").map(Number));
        break;
      case "--match":
        args.match = value();
        break;
      case "--out":
        args.out = value();
        break;
      default:
        throw new Error(`unknown flag: ${flag}`);
    }
  }
  if (!(args.duration > 0)) throw new Error("--duration must be positive");
  if (args.roots.some((pid) => !Number.isInteger(pid) || pid <= 0)) {
    throw new Error("--root takes comma-separated pids");
  }
  return args;
}

const sleep = (seconds) =>
  new Promise((resolve) => setTimeout(resolve, seconds * 1000));

async function main(argv) {
  const args = parseArgs(argv);
  if (args.settle > 0) {
    process.stderr.write(
      `settling for ${args.settle}s (watchers and JIT warm-up must finish before the window opens)…\n`,
    );
    await sleep(args.settle);
  }
  const before = takeSnapshot();
  process.stderr.write(`sampling for ${args.duration}s…\n`);
  await sleep(args.duration);
  const after = takeSnapshot();

  // Selection runs against the *after* snapshot so a service that was still binding its port when
  // the window opened is still attributed to its service name rather than to a bare `node.exe`.
  const selected = selectPids(after.processes, {
    roots: args.roots,
    match: args.match,
  });
  // Both snapshots, because the PowerShell child that took the *first* one has already exited by
  // the time the second is taken — it exists only in `before`.
  const selfPids = new Set([
    ...descendantsOf(before.processes, [process.pid]),
    ...descendantsOf(after.processes, [process.pid]),
  ]);
  const diff = diffSnapshots(before, after, { ignorePids: selfPids });
  process.stdout.write(`${formatReport(args.label, diff, selected)}\n`);

  if (args.out) {
    mkdirSync(args.out, { recursive: true });
    const file = join(args.out, `${args.label}.json`);
    writeFileSync(
      file,
      `${JSON.stringify(
        {
          label: args.label,
          takenAt: after.takenAt,
          summary: summarize(diff, selected),
          rows: diff.rows.filter((r) => selected.has(r.pid)),
          exited: diff.exited,
        },
        null,
        2,
      )}\n`,
    );
    process.stderr.write(`wrote ${file}\n`);
  }
}

// CLI. `import.meta.main` is not available on Node 22, so compare argv instead — same shape as
// scripts/check-conflict-markers.mjs.
if (
  process.argv[1] &&
  import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"))
) {
  main(process.argv.slice(2)).catch((err) => {
    process.stderr.write(`${err.message}\n`);
    process.exitCode = 1;
  });
}
