import { describe, it, expect, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readdirSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  resolveRuntimeNativeDeps,
  stageRuntimeNativeDeps,
} from "../scripts/native-deps.mjs";

// packages/desktop/test → repo root
const repoRoot = resolve(__dirname, "..", "..", "..");

/** True if any `.node` binary (a compiled NAPI addon) exists anywhere under `dir`. */
function hasNativeBinary(dir: string): boolean {
  if (!existsSync(dir)) return false;
  return readdirSync(dir).some((entry) => {
    const p = join(dir, entry);
    return statSync(p).isDirectory()
      ? hasNativeBinary(p)
      : entry.endsWith(".node");
  });
}

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0))
    rmSync(d, { recursive: true, force: true });
});

// regression: #125 — the packaged conductor exited 1 with `Cannot find module 'node-aead-crypto'`
// because bundle-servers.mjs never shipped the native module esbuild leaves as an external require.
describe("runtime native deps (regression: #125)", () => {
  it("resolves node-aead-crypto and its installed platform binding (with a real .node)", () => {
    const resolved = resolveRuntimeNativeDeps(repoRoot);
    const names = resolved.map((r) => r.name);

    expect(names).toContain("node-aead-crypto");
    // The JS loader alone is useless without the compiled binary — the per-platform package that
    // actually carries the `.node` must resolve for the build host.
    const binding = resolved.find((r) => /^node-aead-crypto-/.test(r.name));
    expect(
      binding,
      "a platform binding package must resolve for this build host",
    ).toBeDefined();
    expect(hasNativeBinary(binding!.dir)).toBe(true);
  });

  it("stages the loader + native binary beside the bundled server", () => {
    const out = mkdtempSync(join(tmpdir(), "marquee-native-"));
    tmpDirs.push(out);
    const serversDir = join(out, "servers");

    stageRuntimeNativeDeps(repoRoot, serversDir);

    const modules = join(serversDir, "node_modules");
    // The exact module the packaged conductor failed to require.
    expect(existsSync(join(modules, "node-aead-crypto", "package.json"))).toBe(
      true,
    );
    // And the compiled binary it dynamically loads — the thing whose absence broke #125.
    expect(hasNativeBinary(modules)).toBe(true);
  });
});
