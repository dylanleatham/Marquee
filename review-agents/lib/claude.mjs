// Invoke Claude Code in headless mode for one specialist review.
//
// Real invocation: pipe the composed prompt to `claude -p --output-format json`.
// Mock mode (REVIEW_MOCK=1): return a canned response so the whole pipeline can be
// exercised in CI/tests without spending tokens or needing auth. REVIEW_MOCK_OUTPUT
// (a JSON findings array) overrides the canned empty result.
import { spawnSync } from "node:child_process";

const BIN = process.env.CLAUDE_CODE_PATH || "claude";
const DEFAULT_TIMEOUT_MS = 90_000; // per-specialist budget (dev-harness §6 failure modes)
const DEFAULT_RETRIES = 1; // extra attempts on a *timeout* only (RA-2)
const DEFAULT_REPAIR_TIMEOUT_MS = 60_000; // a reformat carries no diff (RA-4)
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
export function runSpecialist(
  { prompt, model, timeoutMs },
  { spawn = spawnSync, retries = resolveRetries() } = {},
) {
  if (isMock())
    return { ok: true, text: process.env.REVIEW_MOCK_OUTPUT ?? "[]" };

  const args = ["-p", "--output-format", "json"];
  if (model) args.push("--model", model);
  const budget = resolveTimeoutMs(process.env, { timeoutMs });

  let result;
  for (let attempt = 0; attempt <= retries; attempt++) {
    result = interpret(
      spawn(BIN, args, {
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
