// Invoke Claude Code in headless mode for one specialist review.
//
// Real invocation: pipe the composed prompt to `claude -p --output-format json`.
// Mock mode (REVIEW_MOCK=1): return a canned response so the whole pipeline can be
// exercised in CI/tests without spending tokens or needing auth. REVIEW_MOCK_OUTPUT
// (a JSON findings array) overrides the canned empty result.
import { spawnSync } from "node:child_process";

const BIN = process.env.CLAUDE_CODE_PATH || "claude";
const DEFAULT_TIMEOUT_MS = 90_000; // per-specialist budget (dev-harness §6 failure modes)
const IS_WIN = process.platform === "win32";

export const isMock = () => process.env.REVIEW_MOCK === "1";

/**
 * Per-specialist spawn budget in ms. Defaults to 90s; override with REVIEW_TIMEOUT_MS
 * (a positive integer) when a slow/loaded machine pushes a specialist past the default
 * and it gets marked unavailable — see review-agents/KNOWN-ISSUES.md (RA-2). A missing,
 * non-numeric, or non-positive value falls back to the default rather than throwing, so
 * a bad env var degrades to the old behaviour instead of breaking the harness.
 */
export function resolveTimeoutMs(env = process.env) {
  const raw = env.REVIEW_TIMEOUT_MS;
  if (raw == null || raw === "") return DEFAULT_TIMEOUT_MS;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_TIMEOUT_MS;
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

/**
 * Run one specialist. Returns { ok, text } on success or { ok:false, reason } on failure.
 * `text` is the model's raw response (expected to contain a JSON findings array).
 */
export function runSpecialist({ prompt, model }) {
  if (isMock())
    return { ok: true, text: process.env.REVIEW_MOCK_OUTPUT ?? "[]" };

  const args = ["-p", "--output-format", "json"];
  if (model) args.push("--model", model);

  const r = spawnSync(BIN, args, {
    input: prompt,
    encoding: "utf8",
    timeout: resolveTimeoutMs(),
    maxBuffer: 32 * 1024 * 1024,
    shell: IS_WIN,
  });

  if (r.error) {
    const reason =
      r.error.code === "ENOENT" ? "claude not found on PATH" : String(r.error);
    return { ok: false, reason };
  }
  if (r.status !== 0) {
    return {
      ok: false,
      reason: `claude exited ${r.status}: ${(r.stderr || "").slice(0, 500)}`,
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
