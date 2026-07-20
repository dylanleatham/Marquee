// @marquee/backdrop — public surface. The runnable entrypoint is server.ts (node dist/server.js).
export { buildServer, type BuildOptions } from "./server.js";
export { loadConfig, type Config } from "./config.js";
export { Library, type LibraryFile } from "./library.js";
export { PlaybackController, type Status, type Timers } from "./controller.js";
export { SocketHub } from "./hub.js";
export type { Command, BrowserEvent, PlaybackState } from "./types.js";
