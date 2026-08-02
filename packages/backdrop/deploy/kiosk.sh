#!/bin/bash
# Marquee Backdrop — kiosk launcher (backdrop-spec §10, DEPLOY.md step 11b).
#
# This file is the source of truth for how the kiosk starts. It used to exist only as a blob pasted
# out of DEPLOY.md into ~/kiosk.sh, which meant the Pi and the runbook could disagree with nothing to
# notice — and they did, for the whole life of issue #211. Install it by copying, not by retyping:
#
#     cp ~/Marquee/packages/backdrop/deploy/kiosk.sh ~/kiosk.sh && chmod +x ~/kiosk.sh
#
# Log to /tmp so an autostart failure is debuggable: if the kiosk doesn't appear on boot, an empty or
# missing /tmp/kiosk.log means the script never ran; lines in it mean Chromium's own error.
exec >>/tmp/kiosk.log 2>&1
echo "=== kiosk.sh started $(date) DISPLAY=$DISPLAY ==="

sleep 3 # let the X session finish coming up before touching it (else this can die on boot)

# Keep the screen awake.
xset s off
xset -dpms
xset s noblank

# --- Display mode ---------------------------------------------------------------------------------
# Force 1920x1080@60. Both halves of that matter, and both were measured on the real stand
# (issue #211, 2026-08-02, via /api/status.playbackQuality — see ADR 0047):
#
#   * A 4K panel EDID-defaults to its native mode, and Chromium then renders the whole page at
#     3840x2160 and rescales every decoded 1080p frame. That costs more than the decode itself.
#   * At 30Hz a 30fps clip gets exactly one scanout slot per frame, so any frame that is even
#     slightly late is simply lost — there is no slack at all. At 60Hz a late frame just repeats.
#
# Measured, same file, same board: 5.5% of frames dropped sustained at 3840x2160@30, 0% at
# 1920x1080@60. `xrandr` at runtime does not survive a reboot, which is why this lives here.
#
# The output is detected rather than hardcoded: which HDMI port is live differs per install (this
# board reports HDMI-2), and a wrong name silently does nothing.
OUTPUT="$(xrandr | awk '/ connected/{print $1; exit}')"
if [ -n "$OUTPUT" ]; then
  echo "=== forcing $OUTPUT to 1920x1080@60 ==="
  xrandr --output "$OUTPUT" --mode 1920x1080 --rate 60 ||
    echo "WARN: could not set 1920x1080@60 on $OUTPUT — check 'xrandr' for the modes it offers"
else
  echo "WARN: no connected output found; leaving the display mode alone"
fi

# Hide the mouse cursor (belt-and-braces with `cursor: none` in the SPA's CSS).
unclutter -idle 0 -root &

# --- Chromium -------------------------------------------------------------------------------------
# `--password-store=basic` stops it touching the GNOME keyring — without it, first launch demands a
# keyring password and every boot after blocks on unlocking it. No backend wait: the page is a local
# file:// that shows the idle gradient immediately and reconnects on its own.
#
# ⚠️ Do NOT add GPU flags here. `--ignore-gpu-blocklist`, `--enable-gpu-rasterization` and
# `--enable-zero-copy` look like free headroom on a board that decodes video in software, and this
# launcher briefly carried them (#180) — but the Pi's vc4/V3D driver is on Chromium's blocklist for
# reasons, and overriding it takes the GPU process down so nothing ever paints: a kiosk that boots to
# a solid black screen. `test/deploy-assets.test.ts` fails if they come back.
echo "=== launching chromium $(date) ==="
chromium --password-store=basic \
  --kiosk --start-fullscreen --window-position=0,0 \
  --noerrdialogs --disable-infobars --disable-session-crashed-bubble \
  --check-for-update-interval=31536000 \
  --autoplay-policy=no-user-gesture-required \
  --app="file:///home/pi/Marquee/packages/backdrop/public/index.html"
echo "=== chromium exited ($?) $(date) ==="
