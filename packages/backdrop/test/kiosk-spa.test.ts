// The kiosk SPA has never had a test — it's a vanilla IIFE meant for a browser, and an automated
// browser test has been deferred (it needs Playwright). But issue #180 turned that gap into a field
// bug: the SPA kept the outgoing video decoding through the whole 450ms crossfade, which doubles the
// decode load on a Pi that decodes H.264 in software, at exactly the moment a new clip is starting.
//
// `app.js` only reaches for `document`, `location` and `WebSocket`, so it can be driven by shadowing
// those three as function parameters — no jsdom, no new dependency. That's enough to pin the ordering
// this bug was about. The *CSS* half of the fix (parking the idle animation) genuinely needs a real
// browser and is not covered here.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const APP_JS = join(import.meta.dirname, "..", "public", "app.js");

/** A stand-in for one DOM element: just the surface `app.js` actually touches. */
class FakeEl {
  classes = new Set<string>();
  listeners = new Map<string, Array<(e?: unknown) => void>>();
  currentTime = 0;

  // `src` counts its own assignments. In a real browser, assigning `src` — even the same URL — runs
  // the resource selection algorithm and restarts the clip from frame zero, so "was this element's
  // src touched?" is the observable that distinguishes a clean crossfade from loading over the
  // picture (issue #211). The fake can't restart playback, but it can count.
  #src: string | null = null;
  srcSets = 0;
  get src(): string | null {
    return this.#src;
  }
  set src(value: string | null) {
    this.#src = value;
    this.srcSets += 1;
  }

  paused = true;
  hidden = false;
  textContent = "";
  className = "";
  loadCalls = 0;

  classList = {
    add: (c: string) => this.classes.add(c),
    remove: (c: string) => this.classes.delete(c),
    contains: (c: string) => this.classes.has(c),
  };

  addEventListener(type: string, fn: (e?: unknown) => void) {
    const l = this.listeners.get(type) ?? [];
    l.push(fn);
    this.listeners.set(type, l);
  }
  removeEventListener(type: string, fn: (e?: unknown) => void) {
    this.listeners.set(
      type,
      (this.listeners.get(type) ?? []).filter((f) => f !== fn),
    );
  }
  /** Fire a DOM event at this element. */
  fire(type: string, ev?: unknown) {
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn(ev);
  }

  /** Chromium's decoder counters. An own property, so a test can delete it to model an engine
   * that doesn't implement `getVideoPlaybackQuality` at all. */
  videoQuality = { totalVideoFrames: 0, droppedVideoFrames: 0 };
  getVideoPlaybackQuality:
    | (() => {
        totalVideoFrames: number;
        droppedVideoFrames: number;
      })
    | undefined = () => this.videoQuality;

  play() {
    this.paused = false;
    return undefined;
  }
  pause() {
    this.paused = true;
  }
  load() {
    this.loadCalls += 1;
  }
  removeAttribute(name: string) {
    if (name === "src") this.#src = null; // a teardown, not a load — leaves `srcSets` alone
  }
}

class FakeSocket {
  static last: FakeSocket | undefined;
  static OPEN = 1; // `send` compares readyState against WebSocket.OPEN
  readyState = 1;
  sent: string[] = [];
  listeners = new Map<string, Array<(e?: unknown) => void>>();
  constructor(readonly url: string) {
    FakeSocket.last = this;
  }
  addEventListener(type: string, fn: (e?: unknown) => void) {
    const l = this.listeners.get(type) ?? [];
    l.push(fn);
    this.listeners.set(type, l);
  }
  fire(type: string, ev?: unknown) {
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn(ev);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {}
}

/** Load app.js with `document`/`location`/`WebSocket` shadowed, and hand back the pieces to drive. */
function loadSpa() {
  const els = new Map<string, FakeEl>();
  for (const id of [
    "idle",
    "indicators",
    "conn",
    "uri",
    "toast",
    "video-a",
    "video-b",
  ])
    els.set(id, new FakeEl());

  const document = { getElementById: (id: string) => els.get(id) ?? null };
  const location = { search: "", host: "", reload: () => {} };

  const src = readFileSync(APP_JS, "utf8");
  new Function("document", "location", "WebSocket", src)(
    document,
    location,
    FakeSocket,
  );

  const socket = FakeSocket.last!;
  socket.fire("open");
  return { els, socket };
}

/** Deliver a backend command over the socket, the way the hub would. */
const command = (socket: FakeSocket, cmd: unknown) =>
  socket.fire("message", { data: JSON.stringify(cmd) });

describe("kiosk SPA playback (issue #180)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    FakeSocket.last = undefined;
  });

  it("pauses the outgoing video as the fade starts, not after it", () => {
    const { els, socket } = loadSpa();
    const a = els.get("video-a")!;
    const b = els.get("video-b")!;

    // First play: b is the incoming layer (a starts as `active`).
    command(socket, { type: "play", filePath: "/media/one.mp4" });
    b.fire("canplay");
    vi.advanceTimersByTime(500);
    expect(b.classList.contains("is-visible")).toBe(true);

    // Second play swaps back to a. b is now the outgoing layer and must stop decoding immediately —
    // before this fix it kept playing for the full 450ms fade alongside the incoming clip.
    command(socket, { type: "play", filePath: "/media/two.mp4" });
    a.fire("canplay");

    expect(b.paused).toBe(true);
    expect(b.src).not.toBeNull(); // still holds its last frame for the fade
  });

  it("still frees the outgoing element once the fade has finished", () => {
    const { els, socket } = loadSpa();
    const b = els.get("video-b")!;
    const a = els.get("video-a")!;

    command(socket, { type: "play", filePath: "/media/one.mp4" });
    b.fire("canplay");
    vi.advanceTimersByTime(500);

    command(socket, { type: "play", filePath: "/media/two.mp4" });
    a.fire("canplay");
    expect(b.src).not.toBeNull();

    vi.advanceTimersByTime(450);
    expect(b.src).toBeNull();
    expect(b.loadCalls).toBeGreaterThan(0);
  });

  it("does not let a pending stop freeze a video that started after it", () => {
    // Making `stop` act on both layers (above) introduced this: its 650ms cleanup would pause
    // whatever it found, including a clip a *later* play had just started. On a physical stand
    // remove-then-place happens in well under 650ms, and the result was a visible frozen frame.
    const { els, socket } = loadSpa();
    const a = els.get("video-a")!;
    const b = els.get("video-b")!;

    command(socket, { type: "play", filePath: "/media/one.mp4" });
    b.fire("canplay");
    vi.advanceTimersByTime(500);

    command(socket, { type: "stop" });
    vi.advanceTimersByTime(100); // still inside the 650ms stop cleanup

    command(socket, { type: "play", filePath: "/media/two.mp4" });
    a.fire("canplay");
    vi.advanceTimersByTime(2000); // the stale stop timer would have fired in here

    expect(a.paused).toBe(false);
    expect(a.classList.contains("is-visible")).toBe(true);
    expect(a.classList.contains("is-leaving")).toBe(false);
  });

  it("takes the idle overlay out of the way on play and back on stop", () => {
    const { els, socket } = loadSpa();
    const idle = els.get("idle")!;
    const b = els.get("video-b")!;

    expect(idle.classList.contains("is-visible")).toBe(false);

    command(socket, { type: "play", filePath: "/media/one.mp4" });
    b.fire("canplay");
    vi.advanceTimersByTime(500); // let the crossfade settle so b is the active layer
    // The CSS keys the parked animation off this class, so losing it is what would bring the
    // full-screen repaint back over a playing video.
    expect(idle.classList.contains("is-visible")).toBe(false);

    command(socket, { type: "stop" });
    expect(idle.classList.contains("is-visible")).toBe(true);
    expect(b.classList.contains("is-visible")).toBe(false);
  });

  it("stops the video that is actually on screen when stop lands mid-crossfade", () => {
    // `stop` used to act on `active`, but the role swap sits behind a 450ms timer — so a stop arriving
    // inside the crossfade window faded out the *outgoing* layer and left the just-started video
    // playing indefinitely behind the idle overlay. Invisible, and still decoding, which on this Pi is
    // exactly the load issue #180 is about.
    const { els, socket } = loadSpa();
    const b = els.get("video-b")!;

    command(socket, { type: "play", filePath: "/media/one.mp4" });
    b.fire("canplay");
    expect(b.paused).toBe(false); // b is on screen, mid-fade-in

    vi.advanceTimersByTime(100); // stop arrives before the 450ms swap
    command(socket, { type: "stop" });
    vi.advanceTimersByTime(1000);

    expect(b.paused).toBe(true);
    expect(b.classList.contains("is-visible")).toBe(false);
  });

  it("reports playback-started back to the backend", () => {
    const { els, socket } = loadSpa();
    els.get("video-b")!.fire("canplay"); // no play command yet — nothing to report
    expect(socket.sent).toEqual([]);

    command(socket, { type: "play", filePath: "/media/one.mp4" });
    els.get("video-b")!.fire("canplay");

    expect(socket.sent.map((s) => JSON.parse(s))).toEqual([
      { type: "playback-started", filePath: "/media/one.mp4" },
    ]);
  });
});

// Everything above arrives cleanly separated — one command, its `canplay`, the fade, then the next.
// That is not the traffic the hardware sends. Stylus publishes stop-then-start for a sleeve swap
// (stylus-spec §7) and a sleeve can be lifted before a clip has even loaded, so real commands land
// *inside* the crossfade — the one window where the SPA's two layers are not yet in their final
// roles. Issue #211.
describe("kiosk SPA under overlapping commands (issue #211)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    FakeSocket.last = undefined;
  });

  /** Drive one play all the way through its crossfade, so the layers are in a settled state. */
  function playSettled(
    socket: FakeSocket,
    incoming: FakeEl,
    filePath: string,
  ): void {
    command(socket, { type: "play", filePath });
    incoming.fire("canplay");
    vi.advanceTimersByTime(1000);
  }

  it("loads a mid-crossfade play into the spare layer, not the one on screen", () => {
    // The role swap used to sit behind a 450ms timer, so for the length of a fade `inactive` still
    // pointed at the element the viewer was watching. A second play was handed that element: it cut
    // over the picture instead of crossfading, and its extra swap timer then stripped the `src` off
    // the video that was playing — a black screen, with the roles left crossed afterwards.
    const { els, socket } = loadSpa();
    const a = els.get("video-a")!;
    const b = els.get("video-b")!;

    command(socket, { type: "play", filePath: "/media/one.mp4" });
    b.fire("canplay"); // b is on screen; the fade has 450ms to run
    expect(b.classList.contains("is-visible")).toBe(true);

    vi.advanceTimersByTime(100); // a swap lands well inside that window on a real stand
    command(socket, { type: "play", filePath: "/media/two.mp4" });

    // The clip on screen must be left alone until its replacement is ready.
    expect(b.src).toContain("one.mp4");
    expect(a.src).toContain("two.mp4");

    a.fire("canplay");
    vi.advanceTimersByTime(2000); // let every pending timer fire

    expect(a.classList.contains("is-visible")).toBe(true);
    expect(a.src).toContain("two.mp4"); // never torn down by a stale swap
    expect(a.paused).toBe(false);
    expect(b.paused).toBe(true);
  });

  it("survives a burst of overlapping plays without crossing the two layers", () => {
    // The failure above is self-perpetuating: once the role variables are crossed, every later play
    // is handed the on-screen element too. Three overlapping scans is enough to expose it, and the
    // end state — one visible layer, showing the last file asked for, playing — is the invariant.
    const { els, socket } = loadSpa();
    const a = els.get("video-a")!;
    const b = els.get("video-b")!;

    command(socket, { type: "play", filePath: "/media/one.mp4" });
    b.fire("canplay");
    vi.advanceTimersByTime(100); // each swap lands inside the previous crossfade
    command(socket, { type: "play", filePath: "/media/two.mp4" });
    a.fire("canplay");
    vi.advanceTimersByTime(100);
    command(socket, { type: "play", filePath: "/media/three.mp4" });
    b.fire("canplay");
    vi.advanceTimersByTime(2000);

    expect(b.classList.contains("is-visible")).toBe(true);
    expect(a.classList.contains("is-visible")).toBe(false);
    expect(b.src).toContain("three.mp4");
    expect(b.paused).toBe(false);
    expect(a.paused).toBe(true);
  });

  it("ignores a repeat scan of the album already on its way to the screen", () => {
    // The duplicate guard also read `active`, whose `is-visible` is dropped the moment the incoming
    // clip appears — so a repeat inside the fade window missed the guard and re-assigned `src` to the
    // element on screen, restarting the clip from frame 0.
    const { els, socket } = loadSpa();
    const b = els.get("video-b")!;

    command(socket, { type: "play", filePath: "/media/one.mp4" });
    b.fire("canplay");
    vi.advanceTimersByTime(100); // still inside the crossfade
    const setsBefore = b.srcSets;

    command(socket, { type: "play", filePath: "/media/one.mp4" });
    vi.advanceTimersByTime(2000);

    expect(b.src).toContain("one.mp4");
    expect(b.srcSets).toBe(setsBefore); // not re-assigned, so the clip keeps running
    expect(b.paused).toBe(false);
    // And only the first play was ever reported.
    expect(socket.sent.map((s) => JSON.parse(s))).toEqual([
      { type: "playback-started", filePath: "/media/one.mp4" },
    ]);
  });

  it("does not let a clip that was still loading appear after a stop", () => {
    // Place a sleeve, lift it again before the clip has loaded. `stop` never detached the pending
    // `canplay`, so the video still went on screen and hid the idle overlay — and the stop's own
    // cleanup then paused it. A frozen frame, with no idle gradient, until the next scan.
    const { els, socket } = loadSpa();
    const idle = els.get("idle")!;
    const b = els.get("video-b")!;

    command(socket, { type: "play", filePath: "/media/one.mp4" });
    vi.advanceTimersByTime(50);
    command(socket, { type: "stop" }); // lifted before `canplay`

    b.fire("canplay"); // the load finishes anyway
    vi.advanceTimersByTime(2000);

    expect(b.classList.contains("is-visible")).toBe(false);
    expect(idle.classList.contains("is-visible")).toBe(true);
    expect(b.paused).toBe(true);
  });

  it("crossfades a sleeve swap instead of flashing the idle gradient", () => {
    // Stylus publishes `stop` then `start` for a SWAP and documents "No IDLE in between"
    // (stylus-spec §7). The SPA revealed the idle overlay on the stop and only hid it when the new
    // clip reached `canplay` — hundreds of ms later on this Pi — so every swap faded toward the idle
    // gradient and back. backdrop-spec §2 rules that out by name.
    const { els, socket } = loadSpa();
    const idle = els.get("idle")!;
    const a = els.get("video-a")!;
    const b = els.get("video-b")!;

    playSettled(socket, b, "/media/one.mp4");

    command(socket, { type: "stop" });
    command(socket, { type: "play", filePath: "/media/two.mp4" }); // same poll, per §7

    // While the replacement loads, the outgoing clip stays on screen and the gradient stays away.
    expect(idle.classList.contains("is-visible")).toBe(false);
    expect(b.classList.contains("is-visible")).toBe(true);
    expect(b.paused).toBe(false);

    a.fire("canplay");
    vi.advanceTimersByTime(2000);

    expect(a.classList.contains("is-visible")).toBe(true);
    expect(b.paused).toBe(true);
    expect(idle.classList.contains("is-visible")).toBe(false);
  });

  it("holds no video resource at all once it has settled into idle", () => {
    // The whole point of issue #180 is that this board has no decode headroom to spare. A stop left
    // the on-screen element paused but still holding its `src`; only the *outgoing* layer was ever
    // freed. An idle kiosk should be holding nothing.
    const { els, socket } = loadSpa();
    const a = els.get("video-a")!;
    const b = els.get("video-b")!;

    playSettled(socket, b, "/media/one.mp4");
    command(socket, { type: "stop" });
    vi.advanceTimersByTime(2000);

    expect(a.src).toBeNull();
    expect(b.src).toBeNull();
    expect(a.paused).toBe(true);
    expect(b.paused).toBe(true);
  });

  it("samples the decoder while a clip is on screen, and stops on idle", () => {
    // The measurement ADR 0040 never had: a workstation preview can't see a decode-budget defect, so
    // until now nothing but a human watching the display could tell whether the Pi was keeping up.
    const { els, socket } = loadSpa();
    const b = els.get("video-b")!;

    command(socket, { type: "play", filePath: "/media/one.mp4" });
    b.fire("canplay");
    socket.sent.length = 0; // discard playback-started

    b.videoQuality = { totalVideoFrames: 300, droppedVideoFrames: 24 };
    vi.advanceTimersByTime(10_000);
    expect(socket.sent.map((s) => JSON.parse(s))).toEqual([
      {
        type: "playback-quality",
        filePath: "/media/one.mp4",
        totalFrames: 300,
        droppedFrames: 24,
      },
    ]);

    // A second interval keeps reporting — the counters are cumulative, so the backend sees the trend.
    b.videoQuality = { totalVideoFrames: 600, droppedVideoFrames: 51 };
    vi.advanceTimersByTime(10_000);
    expect(socket.sent).toHaveLength(2);

    // Nothing on screen, nothing to measure.
    command(socket, { type: "stop" });
    socket.sent.length = 0;
    vi.advanceTimersByTime(60_000);
    expect(socket.sent).toEqual([]);
  });

  it("reports against the clip that is on screen after a swap, not the one it replaced", () => {
    const { els, socket } = loadSpa();
    const a = els.get("video-a")!;
    const b = els.get("video-b")!;

    command(socket, { type: "play", filePath: "/media/one.mp4" });
    b.fire("canplay");
    vi.advanceTimersByTime(100);
    command(socket, { type: "play", filePath: "/media/two.mp4" });
    a.fire("canplay");
    socket.sent.length = 0;

    a.videoQuality = { totalVideoFrames: 300, droppedVideoFrames: 3 };
    vi.advanceTimersByTime(10_000);

    const reports = socket.sent
      .map((s) => JSON.parse(s))
      .filter((e) => e.type === "playback-quality");
    expect(reports).toEqual([
      {
        type: "playback-quality",
        filePath: "/media/two.mp4",
        totalFrames: 300,
        droppedFrames: 3,
      },
    ]);
  });

  it("stays quiet on an engine with no playback-quality API", () => {
    const { els, socket } = loadSpa();
    const b = els.get("video-b")!;
    b.getVideoPlaybackQuality = undefined;

    command(socket, { type: "play", filePath: "/media/one.mp4" });
    b.fire("canplay");
    socket.sent.length = 0;
    vi.advanceTimersByTime(60_000);

    expect(socket.sent).toEqual([]);
  });

  it("lets a retry through after a load error", () => {
    // `currentPath` is committed before the file is known to be good, so a failed load must release
    // it — otherwise the duplicate guard swallows every retry of the album that just failed.
    const { els, socket } = loadSpa();
    const b = els.get("video-b")!;

    command(socket, { type: "play", filePath: "/media/one.mp4" });
    b.fire("error");
    command(socket, { type: "play", filePath: "/media/one.mp4" });
    b.fire("canplay");

    expect(b.classList.contains("is-visible")).toBe(true);
    expect(socket.sent.map((s) => JSON.parse(s))).toEqual([
      {
        type: "playback-error",
        filePath: "/media/one.mp4",
        error: "load failed",
      },
      { type: "playback-started", filePath: "/media/one.mp4" },
    ]);
  });
});

describe("idle overlay CSS keeps its animation off the playing path (issue #180)", () => {
  // A guard, not a rendering test: `background-position` is not compositor-accelerated, so leaving it
  // animating `infinite` on a full-screen layer repaints every frame — and the layer used to stay in
  // the compositing path while playing, because only `opacity` was dropped. Whether the paint actually
  // stops needs a browser; that this file never goes back to the unconditional form does not.
  const css = readFileSync(
    join(import.meta.dirname, "..", "public", "styles.css"),
    "utf8",
  );
  const idleRule = css.slice(
    css.indexOf(".idle {"),
    css.indexOf(".idle.is-visible"),
  );

  it("parks the animation and hides the layer in the base .idle rule", () => {
    expect(idleRule).toMatch(/animation-play-state:\s*paused/);
    expect(idleRule).toMatch(/visibility:\s*hidden/);
  });

  it("only runs the animation while the overlay is visible", () => {
    const visibleRule = css.slice(css.indexOf(".idle.is-visible"));
    expect(visibleRule).toMatch(/animation-play-state:\s*running/);
  });
});
