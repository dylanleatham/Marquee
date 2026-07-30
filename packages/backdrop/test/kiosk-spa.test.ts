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
  src: string | null = null;
  currentTime = 0;
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
    if (name === "src") this.src = null;
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
