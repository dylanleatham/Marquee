// Backdrop kiosk SPA client (spec §10). Connects to the backend over WebSocket and drives two
// <video> layers for crossfades plus an idle overlay. Vanilla, no framework — one socket, two
// videos, one overlay. Video files load same-origin as file:// URLs, so the kiosk is launched
// against a file:// (or --allow-file-access-from-files http://) origin — see the README deploy notes.

(() => {
  "use strict";

  const params = new URLSearchParams(location.search);
  const DEBUG = params.get("debug") === "1";

  const idle = document.getElementById("idle");
  const indicators = document.getElementById("indicators");
  const connDot = document.getElementById("conn");
  const uriLabel = document.getElementById("uri");
  const toast = document.getElementById("toast");
  let toastTimer = null;

  if (DEBUG) indicators.hidden = false;

  // Two video layers. `showing` is the one on screen; `spare` is the one free to load into.
  //
  // The roles swap the *moment* an incoming clip is put on screen — never on a timer (issue #211).
  // They used to swap 450ms later, alongside the teardown of the outgoing element, which left
  // `spare` pointing at the video the viewer was watching for the whole length of a crossfade. Every
  // command the hardware actually sends lands in that window (Stylus publishes stop-then-start for a
  // sleeve swap, stylus-spec §7), and each one was handed the on-screen element: it loaded over the
  // picture, and its own stale swap timer then stripped the `src` off the clip that was playing.
  let showing = document.getElementById("video-a");
  let spare = document.getElementById("video-b");

  /** What the backend last asked for; `null` while idle. Committed before the file is known good. */
  let currentPath = null;
  /** A clip loading but not yet on screen: `{ el, onReady, onError }`. At most one at a time. */
  let pending = null;
  /** Pending PLAYING → IDLE cleanup; a new play cancels it. */
  let stopTimer = null;
  /** Deferred teardown of a faded-out layer, and the element it targets. */
  let freeTimer = null;
  let freeTarget = null;

  const SWAP_MS = 450; // fade 400ms (spec §7) + margin before the outgoing element is freed
  const STOP_MS = 650; // fade 600ms (spec §7) + margin before PLAYING → IDLE cleanup
  const QUALITY_MS = 10000; // how often to report decoder counters while playing (issue #211)

  let qualityTimer = null;

  function fileUrl(p) {
    let s = String(p).replace(/\\/g, "/");
    if (!s.startsWith("/")) s = "/" + s;
    return encodeURI("file://" + s);
  }

  function showToast(text, durationMs) {
    if (!DEBUG) return; // corner hints are debug-only; the demo screen stays clean
    toast.textContent = text;
    toast.hidden = false;
    clearTimeout(toastTimer);
    if (durationMs)
      toastTimer = setTimeout(() => (toast.hidden = true), durationMs);
  }

  // Connection state is shown as a WORD, not just a colour — the dot alone is unreadable to a
  // colour-blind viewer (and hard to judge on a dim TV). Colour stays as a redundant cue.
  function setConn(state) {
    const label = {
      open: "online",
      connecting: "connecting…",
      offline: "offline",
    }[state];
    const cls = { open: "is-open", connecting: "is-connecting", offline: "" }[
      state
    ];
    connDot.className = "conn " + cls;
    connDot.textContent = "● ws " + label;
  }

  /**
   * Report how the clip on screen is decoding (issue #211).
   *
   * This board has no hardware H.264 decoder ([ADR 0040](../../../docs/adrs/0040-visualizers-carry-a-decode-budget.md)),
   * so when it can't keep up it drops frames — and until now the only thing that noticed was a human
   * watching the display. Curator's preview can't: a workstation eats anything. These counters are
   * the measurement that was missing, which is what lets the next decode-budget decision be made on
   * numbers instead of on reasoning.
   *
   * Counters are cumulative per element and reset when it gets a new source, so a sample is always
   * scoped to the clip named alongside it.
   */
  function reportQuality(el, filePath) {
    if (!el.getVideoPlaybackQuality) return; // not Chromium, or too old — simply no signal
    const q = el.getVideoPlaybackQuality();
    send({
      type: "playback-quality",
      filePath,
      totalFrames: q.totalVideoFrames,
      droppedFrames: q.droppedVideoFrames,
    });
  }

  function startQualityReports(el, filePath) {
    stopQualityReports();
    qualityTimer = setInterval(() => reportQuality(el, filePath), QUALITY_MS);
  }

  function stopQualityReports() {
    clearInterval(qualityTimer);
    qualityTimer = null;
  }

  /** Release a layer's decoder once it has finished fading out. Targets a captured element. */
  function scheduleFree(el) {
    cancelFree();
    freeTarget = el;
    freeTimer = setTimeout(() => {
      freeTimer = null;
      freeTarget = null;
      release(el);
    }, SWAP_MS);
  }

  function cancelFree() {
    clearTimeout(freeTimer);
    freeTimer = null;
    freeTarget = null;
  }

  /** Drop a layer's media resource entirely. Nothing invisible should hold a decoder (issue #180). */
  function release(el) {
    el.removeAttribute("src");
    el.load();
  }

  /** Detach a still-loading clip's listeners. Its element goes back to being the spare. */
  function abandonPending() {
    if (!pending) return;
    pending.el.removeEventListener("canplay", pending.onReady);
    pending.el.removeEventListener("error", pending.onError);
    pending = null;
  }

  /**
   * Cancel an in-flight stop cleanup. It pauses and releases BOTH layers, so left to fire it would
   * freeze the clip we're about to start — on a physical stand, remove-then-place happens well
   * inside its window.
   *
   * A stop we get to cancel was, in practice, the first half of a sleeve swap: Stylus publishes
   * stop-then-start with "No IDLE in between" (stylus-spec §7). So undo its visuals too and put the
   * outgoing clip back on screen. Otherwise the idle gradient fades up while the replacement loads
   * — hundreds of ms on this Pi — and every swap flashes, which backdrop-spec §2 rules out by name.
   * Once the cleanup has actually run there is nothing to put back, and the gradient rightly stays.
   */
  function cancelStop() {
    showing.classList.remove("is-leaving");
    spare.classList.remove("is-leaving");
    if (stopTimer === null) return;
    clearTimeout(stopTimer);
    stopTimer = null;
    showing.classList.add("is-visible");
    idle.classList.remove("is-visible");
  }

  /**
   * Put a loaded layer on screen, retire the other one, and swap the roles — all in one synchronous
   * step, so there is never a window where `spare` is the element being watched (issue #211).
   */
  function show(el) {
    const outgoing = showing;
    el.classList.remove("is-leaving");
    el.classList.add("is-visible");
    outgoing.classList.remove("is-visible");
    idle.classList.remove("is-visible");
    // Pause the outgoing video NOW, not after the fade (issue #180). The Pi decodes H.264 in
    // software, so letting both layers decode through a crossfade doubles the decode load at exactly
    // the moment a new clip is also starting up. A paused element still renders its last frame, so
    // the fade looks identical.
    outgoing.pause();
    showing = el;
    spare = outgoing;
    scheduleFree(outgoing); // free its decoder once the fade has finished
  }

  function play(filePath) {
    // Duplicate scan — already on screen, or already on its way there. Unlike the old guard this
    // reads no class off a layer, so it can't be fooled by a fade in progress.
    if (filePath === currentPath) return;
    currentPath = filePath;

    cancelStop();
    abandonPending(); // a clip still loading is superseded; reuse its element

    const incoming = spare;
    // It may still be queued for teardown from the fade it just lost. We're about to give it a new
    // source anyway, so drop the teardown rather than let it fire mid-load.
    if (freeTarget === incoming) cancelFree();

    const onReady = () => {
      abandonPending();
      show(incoming);
      send({ type: "playback-started", filePath });
      startQualityReports(incoming, filePath);
    };
    const onError = () => {
      abandonPending();
      // Release the path so a retry of the same album isn't swallowed by the duplicate guard.
      if (currentPath === filePath) currentPath = null;
      showToast("video error", 4000);
      send({ type: "playback-error", filePath, error: "load failed" });
    };
    pending = { el: incoming, onReady, onError };
    incoming.addEventListener("canplay", onReady);
    incoming.addEventListener("error", onError);

    incoming.src = fileUrl(filePath);
    incoming.currentTime = 0;

    const p = incoming.play();
    if (p && p.catch) p.catch(() => {}); // muted autoplay is allowed; ignore benign rejections
    if (DEBUG) uriLabel.textContent = filePath;
  }

  function stop() {
    currentPath = null;
    // A clip still loading must not pop onto a screen we've just been told to take to idle — its
    // `canplay` arrives whether we still want it or not (issue #211).
    abandonPending();
    stopQualityReports(); // nothing on screen to measure

    // Act on BOTH layers. Only one is ever visible, so marking both is harmless and immune to
    // whatever the roles happen to be (issue #180).
    const leaving = [showing, spare];
    for (const el of leaving) {
      el.classList.add("is-leaving"); // 600ms fade-out on PLAYING → IDLE (spec §7)
      el.classList.remove("is-visible");
    }
    idle.classList.add("is-visible");
    if (DEBUG) uriLabel.textContent = "";
    clearTimeout(stopTimer);
    stopTimer = setTimeout(() => {
      stopTimer = null;
      cancelFree(); // subsumed by the release below
      for (const el of leaving) {
        el.pause();
        el.classList.remove("is-leaving");
        release(el); // an idle kiosk holds no video resource at all
      }
    }, STOP_MS);
  }

  function handle(cmd) {
    switch (cmd.type) {
      case "play":
        play(cmd.filePath);
        break;
      case "stop":
        stop();
        break;
      case "show-message":
        showToast(cmd.text, cmd.durationMs);
        break;
      case "reload":
        location.reload();
        break;
    }
  }

  // --- WebSocket with auto-reconnect -------------------------------------------------------------
  let ws = null;
  let backoff = 500;

  function send(event) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(event));
  }

  function wsUrl() {
    // Served over http(s): same host. Loaded as a file:// kiosk page: location.host is empty, so
    // fall back to the local backend (override the port with ?port= if you changed it).
    if (location.host) return `ws://${location.host}/ws`;
    const port = params.get("port") || "4740";
    return `ws://localhost:${port}/ws`;
  }

  function connect() {
    setConn("connecting");
    ws = new WebSocket(wsUrl());
    ws.addEventListener("open", () => {
      setConn("open");
      backoff = 500;
    });
    ws.addEventListener("message", (ev) => {
      try {
        handle(JSON.parse(ev.data));
      } catch {
        /* ignore a malformed frame */
      }
    });
    ws.addEventListener("close", () => {
      setConn("offline");
      setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, 10000); // cap reconnect backoff at 10s
    });
    ws.addEventListener("error", () => ws.close());
  }

  connect();
})();
