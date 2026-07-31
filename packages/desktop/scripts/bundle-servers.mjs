// Bundle Curator's and Conductor's servers into single self-contained ESM files for packaging, so
// the installed app doesn't depend on pnpm's symlinked node_modules. Output layout under build/ is
// arranged so each server's own import.meta.url path math still resolves at runtime:
//
//   staged/servers/curator-server.mjs        → ../dist-ui  == staged/dist-ui  (Fastify static UI)
//   staged/servers/conductor-server.mjs      → ../data     == staged/data     (paired bridge key)
//   staged/servers/node_modules/…            native deps esbuild can't inline (issue #125)
//   staged/dist-ui/…                          (copied from curator)
//   staged/data/conductor.json                (copied from hue-conductor — the bridge pairing)
//
// electron-builder ships staged/ as extraResources, preserving those relative positions. (We avoid
// the name `build/` because electron-builder reserves it for buildResources like the icon.)
import { build } from "esbuild";
import { cpSync, rmSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import ffmpegPath from "ffmpeg-static";
import ffprobeStatic from "ffprobe-static";
import { stageRuntimeNativeDeps } from "./native-deps.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const desktop = resolve(here, "..");
const repo = resolve(desktop, "..", "..");
const out = join(desktop, "staged");

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, "servers"), { recursive: true });

const common = {
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  legalComments: "none",
  logLevel: "info",
  // Keep native/optional bits external rather than trying to inline them. sharp/@img are optional at
  // runtime; node-aead-crypto (node-dtls-client's AEAD cipher, ADR 0024) is a required NAPI addon we
  // stage beside the bundle below — esbuild leaves it as a runtime require either way (issue #125).
  //
  // serialport (Curator's "push the tag list to a USB Flipper", issue #68) is the same shape: a NAPI
  // addon loaded through node-gyp-build. Curator imports it *lazily*, so a packaged build that can't
  // load it still boots and only that one button reports the failure — but keeping it external stops
  // esbuild trying to inline a `.node` binary it cannot follow.
  external: [
    "sharp",
    "@img/*",
    "node-aead-crypto",
    "serialport",
    "@serialport/*",
  ],
  // Fastify/avvio call CommonJS `require` internally; an ESM bundle has none, so shim it (and
  // __dirname/__filename) from import.meta.url. Standard esbuild CJS-in-ESM fix.
  banner: {
    js: [
      "import { createRequire as __cr } from 'module';",
      "import { fileURLToPath as __ftu } from 'url';",
      "import { dirname as __dn } from 'path';",
      "const require = __cr(import.meta.url);",
      "const __filename = __ftu(import.meta.url);",
      "const __dirname = __dn(__filename);",
    ].join("\n"),
  },
};

await build({
  ...common,
  entryPoints: [join(repo, "packages/curator/src/server.ts")],
  outfile: join(out, "servers/curator-server.mjs"),
});
await build({
  ...common,
  entryPoints: [join(repo, "packages/hue-conductor/src/server.ts")],
  outfile: join(out, "servers/conductor-server.mjs"),
});

cpSync(join(repo, "packages/curator/dist-ui"), join(out, "dist-ui"), {
  recursive: true,
});
cpSync(join(repo, "packages/hue-conductor/data"), join(out, "data"), {
  recursive: true,
});

// Native deps esbuild left as runtime require()s (node-aead-crypto + its platform binary) — ship
// them beside the server bundle so the packaged conductor can load them (issue #125). Without this
// the packaged app dies at boot with `Cannot find module 'node-aead-crypto'`.
const staged = stageRuntimeNativeDeps(repo, join(out, "servers"));

// ffmpeg + ffprobe so the packaged app needs no system ffmpeg — the desktop main points Curator's
// FFMPEG_PATH/FFPROBE_PATH at these (resources/ffmpeg/*.exe). Named without the platform subpath so
// resolveFfmpeg() can find them by a fixed name.
mkdirSync(join(out, "ffmpeg"), { recursive: true });
cpSync(ffmpegPath, join(out, "ffmpeg", "ffmpeg.exe"));
cpSync(ffprobeStatic.path, join(out, "ffmpeg", "ffprobe.exe"));

console.log(
  `✓ bundled → staged/servers/{curator,conductor}-server.mjs + dist-ui + data + ffmpeg + native (${staged
    .map((d) => d.name)
    .join(", ")})`,
);
