// Types for native-deps.mjs (a plain-Node build script the bundler runs directly, so it stays .mjs).

/** A native dep left external by esbuild, plus the dependency chain that reaches it from a server. */
export interface NativeDep {
  name: string;
  /** Workspace package under `packages/` whose dependencies reach it. Defaults to hue-conductor. */
  from?: string;
  via: string[];
  /**
   * Also stage everything this package requires. Needed when the `.node` lives in a package reached
   * through ordinary `dependencies` rather than a per-platform optional dep (serialport, issue #68).
   */
  transitive?: boolean;
}

/** A resolved package: its name, absolute on-disk directory, and where it is staged. */
export interface ResolvedNativeDep {
  name: string;
  dir: string;
  /** Destination relative to the servers dir, e.g. `node_modules/serialport/node_modules/debug`. */
  dest: string;
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
