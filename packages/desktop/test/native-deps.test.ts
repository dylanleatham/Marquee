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

/*
 * Issue #68 — Curator's "add this album to the Flipper" push. The packaged app failed with
 * `Cannot find package 'serialport'`: esbuild left it external (it carries a NAPI addon), but it was
 * never staged. It is unlike node-aead-crypto in two ways that the staging had to grow to handle —
 * its binary lives in a package it reaches through ordinary `dependencies`, and its tree resolves
 * two versions of some packages, which a flat `node_modules/<name>` cannot represent.
 */
describe("serialport staging (regression: #68)", () => {
  it("resolves serialport together with the package carrying its .node", () => {
    const resolved = resolveRuntimeNativeDeps(repoRoot);
    const names = resolved.map((r) => r.name);

    expect(names).toContain("serialport");
    // The facade is useless alone: the compiled binding lives one level down.
    const bindings = resolved.find(
      (r) => r.name === "@serialport/bindings-cpp",
    );
    expect(bindings, "@serialport/bindings-cpp must resolve").toBeDefined();
    expect(hasNativeBinary(bindings!.dir)).toBe(true);
    // node-gyp-build is what performs the runtime require of that binary.
    expect(names).toContain("node-gyp-build");
  });

  /**
   * Flat staging silently dropped a version: `@serialport/parser-readline` resolves at both 12 and
   * 13 here, and one overwrote the other. Nesting under the requiring package is what makes each
   * consumer get the copy pnpm actually resolved for it.
   */
  it("nests each dependency under the package that requires it", () => {
    const resolved = resolveRuntimeNativeDeps(repoRoot);
    const bindings = resolved.find(
      (r) => r.name === "@serialport/bindings-cpp",
    );
    expect(bindings!.dest).toBe(
      "node_modules/serialport/node_modules/@serialport/bindings-cpp",
    );
    // No two staged packages may target the same directory, or one would clobber the other.
    const dests = resolved.map((r) => r.dest);
    expect(new Set(dests).size).toBe(dests.length);
  });

  it("stages serialport so the packaged server can import it", () => {
    const out = mkdtempSync(join(tmpdir(), "marquee-serial-"));
    tmpDirs.push(out);
    const serversDir = join(out, "servers");

    stageRuntimeNativeDeps(repoRoot, serversDir);

    const serial = join(serversDir, "node_modules", "serialport");
    // The exact specifier the packaged bundle failed to resolve.
    expect(existsSync(join(serial, "package.json"))).toBe(true);
    // …and the binding it loads, reachable from serialport's own node_modules.
    expect(
      hasNativeBinary(
        join(serial, "node_modules", "@serialport", "bindings-cpp"),
      ),
    ).toBe(true);
  });
});
