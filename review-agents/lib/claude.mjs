// Invoke Claude Code in headless mode for one specialist review.
//
// Real invocation: pipe the composed prompt to `claude -p --output-format json`.
// Mock mode (REVIEW_MOCK=1): return a canned response so the whole pipeline can be
// exercised in CI/tests without spending tokens or needing auth. REVIEW_MOCK_OUTPUT
// (a JSON findings array) overrides the canned empty result.
import { spawnSync, spawn as nodeSpawn } from "node:child_process";

const BIN = process.env.CLAUDE_CODE_PATH || "claude";
const DEFAULT_TIMEOUT_MS = 90_000; // per-specialist budget (dev-harness §6 failure modes)
const DEFAULT_RETRIES = 1; // extra attempts on a *timeout* only (RA-2)
const DEFAULT_REPAIR_TIMEOUT_MS = 60_000; // a reformat carries no diff (RA-4)
const DEFAULT_CONCURRENCY = 3; // sessions in flight at once
const IS_WIN = process.platform === "win32";

export const isMock = () => process.env.REVIEW_MOCK === "1";

const positiveInt = (v) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
};

/**
 * Spawn budget in ms for one specialist. Precedence: the specialist's own `timeoutMs` in its
 * `config.json`, then REVIEW_TIMEOUT_MS, then 90s.
 *
 * The per-specialist value exists because the budget is not a property of the machine, it is a
 * property of the reviewer: `runtime` triggers on every source file in the repo, so it loads the
 * most context and is reliably the slowest, while `security` finishes in ten seconds. One global
 * number can't fit both — set it for `runtime` and every fast specialist waits far too long before
 * failing; set it for `security` and `runtime` never runs at all, which is what RA-3 was
 * (see review-agents/KNOWN-ISSUES.md, issue #116).
 *
 * A missing, non-numeric, or non-positive value at either level falls through to the next rather
 * than throwing — bad config degrades to the old behaviour instead of breaking the harness.
 */
export function resolveTimeoutMs(env = process.env, config = undefined) {
  return (
    positiveInt(config?.timeoutMs) ??
    positiveInt(env.REVIEW_TIMEOUT_MS) ??
    DEFAULT_TIMEOUT_MS
  );
}

/**
 * Extra attempts on a timeout before giving up (RA-2). Defaults to 1 retry; override with
 * REVIEW_TIMEOUT_RETRIES (a non-negative integer, 0 to disable). Bad input falls back to the
 * default rather than throwing. Only timeouts retry — a real exit-code failure or ENOENT does not.
 */
export function resolveRetries(env = process.env) {
  const raw = env.REVIEW_TIMEOUT_RETRIES;
  if (raw == null || raw === "") return DEFAULT_RETRIES;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : DEFAULT_RETRIES;
}

/**
 * Budget for the reformat round that recovers a prose reply (issue #117). Its own knob rather than a
 * constant, so it follows the same override idiom as every other budget here: a repair carries no
 * diff — it translates a reply the specialist already produced — so it is much cheaper than a review
 * and deserves a tighter default, but a slow machine still needs a way to raise it.
 */
export function resolveRepairTimeoutMs(env = process.env) {
  return positiveInt(env.REVIEW_REPAIR_TIMEOUT_MS) ?? DEFAULT_REPAIR_TIMEOUT_MS;
}

/**
 * How many specialists may have a Claude session open at once (`REVIEW_CONCURRENCY`, default 3).
 *
 * Not unbounded. The original code ran them strictly one at a time and the comment gave the reason
 * — "gentler on a loaded machine than N concurrent sessions" — and a cap keeps that property while
 * letting the roster finish in roughly the slowest reviewer's budget rather than the sum of all of
 * them. With three reviewers the cap and the roster are the same size, so a review is one round.
 */
export function resolveConcurrency(env = process.env) {
  return positiveInt(env.REVIEW_CONCURRENCY) ?? DEFAULT_CONCURRENCY;
}

/**
 * One invocation of the binary, resolving to the same shape `spawnSync` returns.
 *
 * Written by hand rather than using `spawn`'s own `timeout`/`maxBuffer` because neither exists on
 * `spawn` the way it does on `spawnSync`: `spawn` has no `maxBuffer` at all, and its `timeout` kills
 * the child without producing the `ETIMEDOUT` error code that `interpret` and the retry rule are
 * written against. Both are therefore enforced here, and the result is normalised back to the
 * `spawnSync` shape so `interpret` and every retry test keep working unchanged.
 */
export function spawnOnce(bin, args, { input, timeout, maxBuffer, shell }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = nodeSpawn(bin, args, { shell, stdio: ["pipe", "pipe", "pipe"] });
    } catch (error) {
      return resolve({ error });
    }

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let overflowed = false;
    let settled = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    // A hung Claude session must not wedge the run — this is the bound the whole harness leans on.
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeout);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.length > maxBuffer) {
        overflowed = true;
        child.kill("SIGKILL");
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    child.on("error", (error) => finish({ error }));
    // EPIPE when the child exits before reading the prompt — the close handler owns the outcome.
    child.stdin.on("error", () => {});
    child.on("close", (status, signal) => {
      if (timedOut)
        return finish({
          error: Object.assign(new Error("spawn timed out"), {
            code: "ETIMEDOUT",
          }),
        });
      if (overflowed)
        return finish({
          error: new Error(`output exceeded maxBuffer (${maxBuffer} bytes)`),
        });
      finish({ status, signal, stdout, stderr });
    });

    child.stdin.end(input);
  });
}

export function claudeAvailable() {
  if (isMock()) return true;
  const r = spawnSync(BIN, ["--version"], {
    encoding: "utf8",
    timeout: 15_000,
    shell: IS_WIN,
  });
  return r.status === 0;
}

/** Turn a spawnSync result into { ok, text } | { ok:false, reason, timedOut }. */
function interpret(r) {
  if (r.error) {
    // spawnSync sets error.code === "ETIMEDOUT" when the `timeout` budget fires.
    const timedOut = r.error.code === "ETIMEDOUT";
    const reason =
      r.error.code === "ENOENT" ? "claude not found on PATH" : String(r.error);
    return { ok: false, reason, timedOut };
  }
  if (r.status !== 0) {
    return {
      ok: false,
      reason: `claude exited ${r.status}: ${(r.stderr || "").slice(0, 500)}`,
      timedOut: false,
    };
  }

  // `--output-format json` wraps the reply as { result: "...", ... }; fall back to raw stdout.
  let text = r.stdout;
  try {
    const obj = JSON.parse(r.stdout);
    text = obj.result ?? obj.text ?? r.stdout;
  } catch {
    /* stdout was already plain text */
  }
  return { ok: true, text };
}

/**
 * Run one specialist. Returns { ok, text } on success or { ok:false, reason } on failure.
 * `text` is the model's raw response (expected to contain a JSON findings array).
 *
 * Retries once on a *timeout* (RA-2): a full headless Claude session occasionally overruns the
 * budget on a loaded machine, and losing a blocking reviewer to one transient overrun is worse
 * than spending a second attempt. Non-timeout failures (bad exit, ENOENT) don't retry. `spawn`
 * and `retries` are injectable so the retry path is unit-testable without a real Claude call.
 */
export async function runSpecialist(
  { prompt, model, timeoutMs },
  { spawn = spawnOnce, retries = resolveRetries() } = {},
) {
  if (isMock())
    return { ok: true, text: process.env.REVIEW_MOCK_OUTPUT ?? "[]" };

  const args = ["-p", "--output-format", "json"];
  if (model) args.push("--model", model);
  const budget = resolveTimeoutMs(process.env, { timeoutMs });

  let result;
  for (let attempt = 0; attempt <= retries; attempt++) {
    result = interpret(
      await spawn(BIN, args, {
        input: prompt,
        encoding: "utf8",
        timeout: budget,
        maxBuffer: 32 * 1024 * 1024,
        shell: IS_WIN,
      }),
    );
    if (result.ok || !result.timedOut) return result; // only a timeout is worth retrying
  }
  return result;
}
