// Types for native-deps.mjs (a plain-Node build script the bundler runs directly, so it stays .mjs).

/** A native dep left external by esbuild, plus the dependency chain that reaches it from a server. */
export interface NativeDep {
  name: string;
  via: string[];
}

/** A resolved package: its name and absolute on-disk directory, ready to copy. */
export interface ResolvedNativeDep {
  name: string;
  dir: string;
}

export const RUNTIME_NATIVE_DEPS: NativeDep[];

export function resolveRuntimeNativeDeps(
  repoRoot: string,
  deps?: NativeDep[],
): ResolvedNativeDep[];

export function stageRuntimeNativeDeps(
  repoRoot: string,
  serversDir: string,
  deps?: NativeDep[],
): ResolvedNativeDep[];
