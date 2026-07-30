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

  // Two video elements; `active` is the one currently shown. Swap on each play.
  let active = document.getElementById("video-a");
  let inactive = document.getElementById("video-b");
  let currentPath = null;
  let stopTimer = null; // pending PLAYING → IDLE cleanup; a new play cancels it

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

  function play(filePath) {
    if (filePath === currentPath && active.classList.contains("is-visible"))
      return; // duplicate scan
    currentPath = filePath;

    // Cancel any in-flight stop cleanup. It pauses BOTH layers, so left to fire it would freeze the
    // clip we're about to start — on a physical stand, remove-then-place happens well inside its
    // 650ms window. Cancelling it means we own clearing `is-leaving` ourselves.
    clearTimeout(stopTimer);
    stopTimer = null;
    active.classList.remove("is-leaving");
    inactive.classList.remove("is-leaving");

    inactive.src = fileUrl(filePath);
    inactive.currentTime = 0;

    const onReady = () => {
      inactive.removeEventListener("canplay", onReady);
      inactive.classList.add("is-visible");
      active.classList.remove("is-visible");
      idle.classList.remove("is-visible");
      // Pause the outgoing video NOW, not after the fade (issue #180). The Pi decodes H.264 in
      // software, so letting both layers decode through a 450ms crossfade doubles the decode load at
      // exactly the moment a new clip is also starting up. A paused element still renders its last
      // frame, so the fade looks identical.
      active.pause();
      // After the fade, free the outgoing element and swap roles.
      setTimeout(() => {
        active.removeAttribute("src");
        active.load();
        const tmp = active;
        active = inactive;
        inactive = tmp;
      }, 450);
      send({ type: "playback-started", filePath });
    };
    inactive.addEventListener("canplay", onReady);
    inactive.addEventListener(
      "error",
      () => {
        showToast("video error", 4000);
        send({ type: "playback-error", filePath, error: "load failed" });
      },
      { once: true },
    );

    const p = inactive.play();
    if (p && p.catch) p.catch(() => {}); // muted autoplay is allowed; ignore benign rejections
    if (DEBUG) uriLabel.textContent = filePath;
  }

  function stop() {
    // Act on BOTH layers, not just `active`. The role swap after a play sits behind a 450ms timer, so
    // a stop landing inside that window used to fade out the *outgoing* element and leave the
    // just-started video playing indefinitely behind the idle overlay — invisible, and still burning
    // software-decode budget on the Pi (issue #180). Only one layer is ever visible, so marking both
    // is harmless and immune to a pending swap.
    const leaving = [active, inactive];
    for (const el of leaving) {
      el.classList.add("is-leaving"); // 600ms fade-out on PLAYING → IDLE (spec §7)
      el.classList.remove("is-visible");
    }
    idle.classList.add("is-visible");
    currentPath = null;
    if (DEBUG) uriLabel.textContent = "";
    clearTimeout(stopTimer);
    stopTimer = setTimeout(() => {
      stopTimer = null;
      for (const el of leaving) {
        el.pause();
        el.classList.remove("is-leaving");
      }
    }, 650);
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
