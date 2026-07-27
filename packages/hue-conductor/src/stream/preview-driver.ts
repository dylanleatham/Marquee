// The animation loop behind the offline streaming preview page (issue #135).
//
// This module is unusual on purpose: `drivePreview` is *inlined into the generated HTML* via
// `Function.prototype.toString`, so it must stay self-contained — no imports, no references to
// anything outside its own body. In exchange it is a plain function that takes its whole browser
// surface (clock, frame scheduler, visibility) by injection, which is what lets the node test
// suite exercise it with a hand-cranked fake instead of a headless browser.

export interface PreviewDriverOptions {
  /** The rate the *content* advances at — well under a modern display's refresh rate. */
  fps: number;
  /** Called once per distinct content frame, with a tick that increases by 1 each time. */
  onTick: (tick: number) => void;
  now: () => number;
  requestFrame: (cb: () => void) => number;
  cancelFrame: (handle: number) => void;
  isHidden: () => boolean;
  /** Subscribe to visibility changes. Returns the unsubscribe. */
  onVisibilityChange: (listener: () => void) => () => void;
}

/**
 * Run one animation loop for the whole page and return a stop().
 *
 * Three properties the previous per-card loop lacked:
 *  - **No redundant paints.** A 60Hz display against 25fps content repeats ~58% of frames; the
 *    tick only fires when the computed frame index actually changes.
 *  - **Idle when unwatched.** A hidden page cancels the frame outright rather than relying on the
 *    browser's rAF throttling, and resumes where it left off — hidden time doesn't fast-forward
 *    the animation.
 *  - **Cancellable.** The frame handle is retained, so the caller can tear the loop down.
 */
export function drivePreview(options: PreviewDriverOptions): () => void {
  const {
    fps,
    onTick,
    now,
    requestFrame,
    cancelFrame,
    isHidden,
    onVisibilityChange,
  } = options;
  let handle = 0;
  let running = false;
  /** Milliseconds of *visible* playback already elapsed; hidden time never lands here. */
  let played = 0;
  let resumedAt = 0;
  let lastTick = -1;

  function step() {
    const tick = Math.floor(((played + now() - resumedAt) / 1000) * fps);
    if (tick !== lastTick) {
      lastTick = tick;
      onTick(tick);
    }
    handle = requestFrame(step);
  }

  function start() {
    if (running) return;
    running = true;
    resumedAt = now();
    handle = requestFrame(step);
  }

  function stop() {
    if (!running) return;
    running = false;
    played += now() - resumedAt;
    cancelFrame(handle);
  }

  const unsubscribe = onVisibilityChange(() => {
    if (isHidden()) stop();
    else start();
  });

  if (!isHidden()) start();

  return () => {
    stop();
    unsubscribe();
  };
}
