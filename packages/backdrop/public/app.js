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

  function setConn(cls) {
    connDot.className = "conn " + cls;
  }

  function play(filePath) {
    if (filePath === currentPath && active.classList.contains("is-visible"))
      return; // duplicate scan
    currentPath = filePath;

    inactive.src = fileUrl(filePath);
    inactive.currentTime = 0;

    const onReady = () => {
      inactive.removeEventListener("canplay", onReady);
      inactive.classList.add("is-visible");
      active.classList.remove("is-visible");
      idle.classList.remove("is-visible");
      // After the fade, free the outgoing element and swap roles.
      setTimeout(() => {
        active.pause();
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
    active.classList.remove("is-visible");
    idle.classList.add("is-visible");
    currentPath = null;
    if (DEBUG) uriLabel.textContent = "";
    setTimeout(() => active.pause(), 650);
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
    setConn("is-connecting");
    ws = new WebSocket(wsUrl());
    ws.addEventListener("open", () => {
      setConn("is-open");
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
      setConn("");
      setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, 10000); // cap reconnect backoff at 10s
    });
    ws.addEventListener("error", () => ws.close());
  }

  connect();
})();
