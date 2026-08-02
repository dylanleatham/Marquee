// Backdrop-internal messages between the Node backend and the Chromium SPA over the WebSocket
// (backdrop-spec §10). These are NOT cross-service contracts — the browser is the same box as the
// backend — so they live here rather than in @marquee/contracts. Cross-service shapes (ScanEvent,
// LibraryEntry) come from @marquee/contracts.

/** Backend → browser. Drives the video element and idle overlay. */
export type Command =
  | { type: "play"; filePath: string }
  | { type: "stop" }
  | { type: "show-message"; text: string; durationMs?: number }
  | { type: "reload" }; // dev hot-reload

/** Browser → backend. Observability only; the backend doesn't gate state on these. */
export type BrowserEvent =
  | { type: "playback-started"; filePath: string }
  | { type: "playback-error"; filePath: string; error: string }
  | { type: "loop-completed"; filePath: string; iteration: number }
  // Cumulative decoder counters for the clip on screen, sampled periodically by the kiosk
  // (issue #211). The one measurement of whether this board is keeping up — see `quality.ts`.
  | {
      type: "playback-quality";
      filePath: string;
      totalFrames: number;
      droppedFrames: number;
    };

/** The backend's single global playback state (backdrop-spec §7). */
export type PlaybackState = "idle" | "playing";
