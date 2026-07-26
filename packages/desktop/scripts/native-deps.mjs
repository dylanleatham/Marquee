// Native (NAPI) dependencies that esbuild can't inline into the bundled servers, so they must be
// shipped as real packages beside the bundle (issue #125). esbuild bundles JS, but a native module
// loads a `.node` binary through a runtime `require()` it can't follow, so it leaves the bare
// `require("<pkg>")` in the output. If that package isn't on disk next to the server bundle, the
// packaged app dies at boot with `Cannot find module` — which is exactly how #125 presented
// (hue-conductor exited with code 1, because node-dtls-client's DTLS transport loads node-aead-crypto).
//
// This is the same shape of problem the bundler already solves for ffmpeg (copied in explicitly);
// this module does it for the native node_modules the conductor needs.
import { createRequire } from "node:module";
import { cpSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * The native deps left external by esbuild, each with the dependency chain that reaches it from a
 * server package. node-aead-crypto isn't a direct dependency of anything we author — it comes in
 * under node-dtls-client (the Entertainment DTLS transport, ADR 0024), and pnpm nests it there
 * rather than hoisting it, so we resolve *through* node-dtls-client. Add an entry here if a future
 * dependency is likewise a native module esbuild can't bundle.
 */
export const RUNTIME_NATIVE_DEPS = [
  { name: "node-aead-crypto", via: ["node-dtls-client"] },
];

/**
 * Absolute directory of package `name` as resolved from `fromPackageJson`'s context, found by
 * resolving the package's entry point and walking up to the package root. We avoid
 * `require.resolve("<name>/package.json")` on purpose: packages with an `exports` map (node-dtls-client
 * is one) forbid that subpath and throw ERR_PACKAGE_PATH_NOT_EXPORTED. Resolving the bare entry is
 * always allowed.
 */
function packageDir(fromPackageJson, name) {
  const require = createRequire(fromPackageJson);
  let dir = dirname(require.resolve(name));
  for (let d = dir; d !== dirname(d); d = dirname(d)) {
    const pkgJson = join(d, "package.json");
    if (existsSync(pkgJson)) {
      try {
        if (JSON.parse(readFileSync(pkgJson, "utf8")).name === name) return d;
      } catch {
        // unreadable/!JSON package.json — keep walking up
      }
    }
  }
  throw new Error(`could not locate the package directory for "${name}"`);
}

/**
 * Resolve each runtime-native dep — and whichever platform binding is installed for the *build host*
 * — to its on-disk package directory, following the pnpm dependency chain from hue-conductor. Returns
 * `[{ name, dir }]` ready to copy into a server's sibling `node_modules`. Only the host's platform
 * binding is present (pnpm installs one of node-aead-crypto's optional per-platform packages), so we
 * ship the one that resolves and skip the rest.
 */
export function resolveRuntimeNativeDeps(repoRoot, deps = RUNTIME_NATIVE_DEPS) {
  const resolved = [];
  for (const { name, via } of deps) {
    // Hop through the `via` chain so a nested (non-hoisted) dep resolves from the right context.
    let context = join(repoRoot, "packages", "hue-conductor", "package.json");
    for (const hop of via)
      context = join(packageDir(context, hop), "package.json");

    const dir = packageDir(context, name);
    resolved.push({ name, dir });

    // The actual `.node` binary lives in a per-platform optional dependency; ship the installed one.
    const { optionalDependencies = {} } = JSON.parse(
      readFileSync(join(dir, "package.json"), "utf8"),
    );
    const pkgContext = join(dir, "package.json");
    for (const platformPkg of Object.keys(optionalDependencies)) {
      try {
        resolved.push({
          name: platformPkg,
          dir: packageDir(pkgContext, platformPkg),
        });
      } catch {
        // not installed for this platform — only the host's binding is present
      }
    }
  }
  return resolved;
}

/**
 * Copy the resolved native deps into `<serversDir>/node_modules/<name>`, dereferencing pnpm's
 * symlinks so the staged tree is self-contained (electron-builder ships it as extraResources). The
 * conductor bundle's `require("node-aead-crypto")` then resolves against this sibling node_modules,
 * and node-aead-crypto's own `require("<platform-binding>")` resolves the `.node` next to it.
 * Returns the resolved list (for logging / assertions).
 */
export function stageRuntimeNativeDeps(
  repoRoot,
  serversDir,
  deps = RUNTIME_NATIVE_DEPS,
) {
  const modulesDir = join(serversDir, "node_modules");
  const resolved = resolveRuntimeNativeDeps(repoRoot, deps);
  for (const { name, dir } of resolved) {
    mkdirSync(dirname(join(modulesDir, name)), { recursive: true });
    cpSync(dir, join(modulesDir, name), { recursive: true, dereference: true });
  }
  return resolved;
}
