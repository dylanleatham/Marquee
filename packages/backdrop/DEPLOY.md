# Backdrop on a Raspberry Pi — from unboxing to running

A step-by-step guide that assumes **no prior Raspberry Pi experience**. By the end you'll have a Pi
that boots straight into Backdrop: a full-screen idle gradient that turns into an album's visualizer
when a scan event arrives, and fades back when it stops.

If you just want to hack on Backdrop on your laptop, you don't need any of this — see the
[README](README.md) "Dev" section. This document is specifically about the physical Pi.

> **Time budget:** ~1 hour, most of it waiting on downloads. You do steps 1–2 at a desk with the Pi
> plugged into a display; everything after that can be done from your laptop over SSH.

---

## 0. What you need

**Hardware** (see [backdrop-spec §4](../../docs/specs/backdrop-spec.md) for the full bill of
materials and the "why"):

- Raspberry Pi 5 (4GB is plenty) + the official **27W USB-C** power supply (don't skimp — an
  underpowered Pi 5 browns out under video decode)
- A **high-endurance** microSD card, 128GB, A2-rated (a normal card wears out running 24/7)
- micro-HDMI → HDMI cable, and a display (any HDMI TV/monitor)
- For first-time setup only: a USB keyboard, and a computer with an SD-card reader
- Your Wi-Fi network name + password (or an Ethernet cable)

**On your laptop:** the free **Raspberry Pi Imager** app (raspberrypi.com/software).

A note on terminology: the **Pi** is the little computer. **Raspberry Pi OS** is its operating
system (a Linux). **The terminal** is where you type commands — either on the Pi's own screen, or
from your laptop over **SSH** (a remote terminal). Commands below that start with `$` are things you
type; don't type the `$`.

---

## 1. Flash the OS onto the microSD card

1. Put the microSD card into your laptop's card reader.
2. Open **Raspberry Pi Imager**.
3. **Choose Device:** Raspberry Pi 5.
4. **Choose OS:** _Raspberry Pi OS (64-bit)_ — the normal one with a desktop. (Not "Lite" — Backdrop
   drives a Chromium browser, which needs the desktop.)
5. **Choose Storage:** your microSD card. ⚠️ Double-check you picked the card, not your laptop's own
   drive — this erases it.
6. Click **Next**, then **Edit Settings** (this pre-configures the Pi so you never need to plug in a
   keyboard for long). Set:
   - **Hostname:** `backdrop` (this makes the Pi reachable as `backdrop.local`)
   - **Username / password:** username `pi` and a password you'll remember — you'll type it a lot
   - **Wireless LAN:** your Wi-Fi name (SSID) + password, and set the **Wi-Fi country** correctly or
     Wi-Fi stays off
   - **Locale:** your timezone and keyboard layout
   - On the **Services** tab: tick **Enable SSH** → _Use password authentication_
7. **Save**, then **Yes** to apply, **Yes** to erase and write. Wait ~5 minutes.
8. When it says done, eject the card.

## 2. First boot

1. Put the microSD card into the Pi (the slot is on the underside).
2. Plug in: micro-HDMI → your display, the USB keyboard, and **last** the USB-C power. The Pi has no
   power button — it boots when powered.
3. Wait ~1 minute. You should see the Raspberry Pi desktop. It joins your Wi-Fi automatically using
   what you set in step 1.
4. Find the Pi's address so you can reach it from your laptop. On the Pi, open its **Terminal** app
   (top bar) and run:
   ```
   $ hostname -I
   ```
   Note the first number (e.g. `192.168.1.42`) — that's the Pi's IP address.

## 3. Connect from your laptop (SSH)

From here on you can put the keyboard away and work from your laptop's terminal. Open a terminal on
your laptop and run (use `backdrop.local`, or the IP from step 2 if `.local` doesn't resolve):

```
$ ssh pi@backdrop.local
```

Type `yes` to trust it the first time, then the password you set. You're now typing commands **on the
Pi**. (If `ssh` isn't found on Windows, use the same command in PowerShell — it's built in — or use
PuTTY.)

> ⚠️ **Include the `pi@`.** If you run `ssh 192.168.1.42` with no username, SSH silently fills in
> your **laptop's** username — which doesn't exist on the Pi, so every password gets
> `Permission denied` no matter how correctly you type it. The prompt itself tells you who you're
> logging in as (`pi@…`). Also normal: **nothing appears while you type a password** — no dots, no
> asterisks. Type it blind and press Enter.

## 4. Update the system and confirm the clock

Backdrop's idle-timeout is time-based, so an accurate clock matters. Run:

```
$ sudo apt update && sudo apt full-upgrade -y
$ sudo reboot
```

The reboot drops your SSH connection; wait a minute and `ssh pi@backdrop.local` back in. Confirm time
sync is on (look for `System clock synchronized: yes`):

```
$ timedatectl
```

## 5. Install Node.js, pnpm, git, and Chromium

Backdrop is a Node.js program. Install **Node 22** (the version this project targets), the **pnpm**
package manager, **git**, and the **Chromium** browser:

```
$ curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
$ sudo apt install -y nodejs git chromium-browser
$ sudo corepack enable          # lets pnpm self-manage its version from the repo
```

Verify each one prints a version (Node should be v22.x):

```
$ node -v
$ git --version
$ chromium-browser --version
```

> If `chromium-browser` isn't found, your image ships it as `chromium` — install that instead and use
> `chromium` in place of `chromium-browser` everywhere below.

## 6. Get the code and build Backdrop

The Marquee repo is **private**, so the Pi has to authenticate to GitHub before it can clone — and
GitHub no longer accepts account passwords for git (a plain `git clone` prompts for a password and
then always fails with _"Password authentication is not supported"_). The easiest path is GitHub's
CLI with a browser login — no tokens to create or paste:

```
$ sudo apt install -y gh
$ gh auth login
```

Answer its prompts: **GitHub.com** → protocol **HTTPS** → _"Authenticate Git with your GitHub
credentials?"_ **Yes** (this wires git up so `clone`/`pull` work from then on) → **Login with a web
browser**. It prints a one-time code and a URL — open the URL on your laptop, sign in, type the
code, approve.

Now clone and build. The first install downloads the whole monorepo's dependencies and takes a few
minutes on a Pi — that's normal.

```
$ cd ~
$ gh repo clone dylanleatham/Marquee
$ cd Marquee
$ pnpm install
$ pnpm --filter @marquee/backdrop build
```

That last command compiles Backdrop **and** its `@marquee/contracts` dependency. When it finishes you
have `~/Marquee/packages/backdrop/dist/server.js` — the thing you'll run.

## 7. Configure Backdrop

```
$ cd ~/Marquee/packages/backdrop
$ cp config.example.toml config.toml
$ nano config.toml
```

In the editor set at least the **shared secret** — it must be the _same_ value as your Conductor and
Stylus use (`TRIGGER_SHARED_SECRET`), or they won't be allowed to talk to Backdrop:

```toml
[auth]
shared_secret = "the-same-secret-your-other-services-use"
```

Leave the rest at defaults (port 4740, `data_dir = "data"`, `media_dir = "data/media/visualizers"`,
90-minute idle timeout). Save and exit nano with **Ctrl+O, Enter, Ctrl+X**.

Create the folder where visualizer videos will live:

```
$ mkdir -p ~/Marquee/packages/backdrop/data/media/visualizers
```

## 8. Smoke-test the backend (no video yet)

Start Backdrop by hand to confirm it runs:

```
$ node ~/Marquee/packages/backdrop/dist/server.js
```

You should see a log line ending `Backdrop up on http://0.0.0.0:4740`. Leave it running. Open a
**second** SSH session to the Pi (new laptop terminal, `ssh pi@backdrop.local`) and ask it its
status — replace `SECRET` with your shared secret:

```
$ curl -s -H "X-Trigger-Secret: SECRET" http://localhost:4740/api/status
```

You should get back JSON with `"state":"idle"` and `"browserConnected":false`. That confirms the
backend works. Back in the first terminal, press **Ctrl+C** to stop it — the next steps make it start
automatically.

## 9. Put a test video in place

You need one **H.264 `.mp4`** on the Pi to see anything. Chromium here only plays H.264 — a phone clip
usually is; an H.265/HEVC or VP9 file will copy fine but then play as a black screen. Keep the test
clip modest (**1080p30 and under ~10 Mbps**): this Pi decodes H.264 in software, so a 20 Mbps file
stutters even though it is the right codec (see the note in step 11b, and
[ADR 0040](../../docs/adrs/0040-visualizers-carry-a-decode-budget.md)). Real visualizers arriving from
Curator are already held to that budget on ingest; a clip you supply by hand is not.

**Option A — generate one on the Pi** (no file to find; a moving colour-bars test pattern):

```
$ sudo apt install -y ffmpeg
$ ffmpeg -f lavfi -i testsrc=size=1280x720:rate=30 -t 10 -c:v libx264 -pix_fmt yuv420p -y ~/Marquee/packages/backdrop/data/media/visualizers/demo.mp4
```

**Option B — copy one from your computer.** Run this in a terminal **on your computer** (not the Pi):

```
# macOS / Linux
$ scp ~/Downloads/test.mp4 pi@backdrop.local:/home/pi/Marquee/packages/backdrop/data/media/visualizers/demo.mp4

# Windows (PowerShell or Command Prompt) — quote the path; drag-and-drop the file to auto-fill it
> scp "C:\Users\you\Downloads\test.mp4" pi@backdrop.local:/home/pi/Marquee/packages/backdrop/data/media/visualizers/demo.mp4
```

It'll ask for the Pi's password (the one you SSH with). Copy to a name ending in `.mp4`.

> ⚠️ **Make sure nothing already exists at that path as a _directory_.** A stray `mkdir` or a
> mangled earlier paste can leave a folder named `demo.mp4`, and then ffmpeg and the video player
> both fail with _"Is a directory"_. Check with `ls -l …/visualizers/` — `demo.mp4` should be a file
> with a KB/MB size, not a `d`-prefixed directory. Remove a bad one with
> `rm -rf ~/Marquee/packages/backdrop/data/media/visualizers/demo.mp4` and redo.

Confirm it landed and is really H.264 (the second command must print `h264`):

```
$ ls -l ~/Marquee/packages/backdrop/data/media/visualizers/demo.mp4
$ ffprobe -v error -select_streams v:0 -show_entries stream=codec_name -of csv=p=0 ~/Marquee/packages/backdrop/data/media/visualizers/demo.mp4
```

If that prints anything other than `h264` (e.g. `hevc`, `vp9`), re-encode it in place. These flags are
the same decode budget Curator applies on ingest — the bitrate cap is the part that matters on this
board, not just the codec:

```
$ ffmpeg -i <the-copied-file> -an -vf "crop=trunc(iw/2)*2:trunc(ih/2)*2" -c:v libx264 -profile:v high -level 4.0 -preset veryfast -crf 21 -maxrate 8M -bufsize 16M -g 60 -pix_fmt yuv420p -movflags +faststart -y ~/Marquee/packages/backdrop/data/media/visualizers/demo.mp4
```

The `crop` is not decoration — `-pix_fmt yuv420p` cannot encode an odd width or height, and it fails
the whole command with "width not divisible by 2" rather than degrading. HEVC is exactly where that
bites, because it can carry odd dimensions and this command is the one you run _on_ an HEVC file. It
is a no-op on the even frames that are the norm. Curator applies the same clamp on ingest
([issue #217](https://github.com/dylanleatham/Marquee/issues/217)).

Now register it in Backdrop's library — `SECRET` is your `shared_secret` from `config.toml`. Run this
**on the Pi**:

```
$ curl -s -H "X-Trigger-Secret: SECRET" -H "content-type: application/json" -X POST http://localhost:4740/api/library/update -d '{"uri":"curator:album:demo","filePath":"/home/pi/Marquee/packages/backdrop/data/media/visualizers/demo.mp4","durationSec":10}'
```

The backend from step 8 must be running for this — restart it by hand, or come back after step 10
when it auto-starts. A `{"updated":"curator:album:demo"}` reply means it took.

## 10. Make the backend start on boot (systemd)

`systemd` is Linux's "start these programs and keep them alive" manager. Create a service file:

```
$ sudo nano /etc/systemd/system/backdrop.service
```

> **Unit naming.** This guide calls it `backdrop`; [docs/runbook.md](../../docs/runbook.md) A3 calls it
> `marquee-backdrop`, matching `marquee-conductor` and `marquee-stylus`. Both exist on real installs.
> Either works — just use the name you actually created in every `systemctl` command, and if you're
> unsure which one you have:
> `systemctl list-units --all 'marquee*' 'backdrop*' --no-pager`.

Paste this exactly (it assumes username `pi` — change the paths if you used a different username):

```ini
[Unit]
Description=Marquee Backdrop backend
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=pi
WorkingDirectory=/home/pi/Marquee/packages/backdrop
ExecStart=/usr/bin/node /home/pi/Marquee/packages/backdrop/dist/server.js
Restart=on-failure
RestartSec=3
# Log to journald (bounded) rather than a file that grows forever and wears the SD card.
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

Save and exit, then enable and start it:

```
$ sudo systemctl daemon-reload
$ sudo systemctl enable --now backdrop
$ systemctl status backdrop        # should say "active (running)"; press q to exit
```

Watch its logs live any time with:

```
$ journalctl -u backdrop -f        # Ctrl+C to stop watching
```

The backend now survives reboots and restarts itself if it crashes. Now do step 9's `curl` commands
if you skipped them.

## 11. Make the kiosk browser start on boot

This is the fiddliest part, because it depends on the graphical desktop. We'll (a) make the Pi log
into its desktop automatically, (b) stop the screen from blanking, and (c) auto-launch Chromium
pointed at Backdrop's page.

### 11a. Use the X11 desktop and auto-login

Recent Raspberry Pi OS defaults to a "Wayland" desktop, but the classic **X11** desktop is far
better-documented for kiosks and lets the screen-blanking commands below work. Switch to it and turn
on desktop auto-login:

```
$ sudo raspi-config
```

- **Advanced Options → Wayland → W1 X11** (Openbox/X11)
- **System Options → Boot / Auto Login → Desktop Autologin**
- **Display Options → Screen Blanking → No** (stops the display going black after 10 minutes and
  looking like a crash)

Choose **Finish**, but say **No** to rebooting yet — one more file to create.

### 11b. The kiosk launch script

> **Why a `file://` path and not `http://localhost`?** Backdrop's page loads its video straight off
> the SD card as a `file://` URL. Chromium refuses to load `file://` videos from a page served over
> `http://` (a cross-scheme security rule), so the _page itself_ must also be opened as `file://`.
> Everything still works — the page connects back to the backend over a WebSocket regardless of how
> it was opened. (This corrects [backdrop-spec §6](../../docs/specs/backdrop-spec.md), which shows an
> `http://localhost` launch.)

Install `unclutter` (hides the mouse cursor) and create the script:

```
$ sudo apt install -y unclutter
$ nano ~/kiosk.sh
```

Paste:

```bash
#!/bin/bash
# Log to /tmp so an autostart failure is debuggable: if the kiosk doesn't appear on boot, an empty
# or missing /tmp/kiosk.log means the script never ran; lines in it mean Chromium's own error.
exec >> /tmp/kiosk.log 2>&1
echo "=== kiosk.sh started $(date) DISPLAY=$DISPLAY ==="

sleep 3   # let the X session finish coming up before launching Chromium (else it can die on boot)

# Keep the screen awake, and hide the mouse cursor.
xset s off; xset -dpms; xset s noblank
unclutter -idle 0 -root &

# Launch Chromium. --password-store=basic stops it touching the GNOME keyring — without it, first
# launch demands a keyring password and every boot after blocks on unlocking it. No backend wait:
# the page is a local file:// that shows the idle gradient immediately and reconnects on its own.
echo "=== launching chromium $(date) ==="
chromium --password-store=basic \
  --kiosk --start-fullscreen --window-position=0,0 \
  --noerrdialogs --disable-infobars --disable-session-crashed-bubble \
  --check-for-update-interval=31536000 \
  --autoplay-policy=no-user-gesture-required \
  --app="file:///home/pi/Marquee/packages/backdrop/public/index.html"
```

> ⚠️ **Do not add GPU flags here speculatively.** `--ignore-gpu-blocklist`,
> `--enable-gpu-rasterization` and `--enable-zero-copy` look like free headroom on a board that
> decodes video in software — and this runbook briefly recommended them
> ([#180](https://github.com/dylanleatham/Marquee/issues/180)) — but the Pi's vc4/V3D driver is on
> Chromium's blocklist for reasons, and overriding it is a known way to get a **kiosk that boots to a
> solid black screen** (the GPU process falls over and nothing ever paints). The flags above are the
> set that is actually known to work on this hardware.
>
> If you want to try them anyway, add **one at a time**, reboot, and confirm the idle gradient still
> appears before adding the next. `chrome://gpu` tells you what changed; a black screen means back
> the flag out. The decode budget on the Curator side ([ADR 0040](../../docs/adrs/0040-visualizers-carry-a-decode-budget.md))
> is where the real playback win came from — these flags were never measured to help.

> ⚠️ **The Pi 5 has no hardware H.264 decoder.** VideoCore VII dropped the Pi 4's H.264 block and kept
> only HEVC, so every frame Backdrop plays is decoded on the CPU while that same CPU composites the
> page. This is not a footnote — it set the whole video pipeline's shape. Curator now enforces a
> **decode budget** on every visualizer it ingests (≤1080p30, ≤10 Mbps, no audio track;
> [ADR 0040](../../docs/adrs/0040-visualizers-carry-a-decode-budget.md)), because before it did,
> ~20 Mbps files reached this Pi and flickered and stuttered continuously —
> [#180](https://github.com/dylanleatham/Marquee/issues/180).
>
> Two Pi-specific things worth ruling out if playback is still
> rough: `vcgencmd get_throttled` (non-zero = thermal or undervoltage throttling — a Pi 5 doing
> software video decode runs hot, and an underpowered supply browns out under exactly this load), and
> `xrandr | grep '\*'` — if the panel is running at **4K**, Chromium renders the whole page at
> 3840x2160 and rescales every 1080p frame, which costs far more than the decode itself. Forcing the
> mode to 1920x1080 is the fix.

(Bookworm's browser binary is `chromium`; if your image only has `chromium-browser`, use that name.)
Save/exit, then make it executable:

```
$ chmod +x ~/kiosk.sh
```

> Add `?debug=1` to the end of the `file://...index.html` URL while testing — it shows a labelled
> WebSocket indicator bottom-right (`ws online` / `ws connecting…` / `ws offline`) and the current
> video path bottom-left. `ws online` is the one you want. Remove `?debug=1` for the real thing so
> the screen stays clean.

### 11c. Auto-start the kiosk on boot (XDG autostart)

Register the script as a desktop-standard **autostart entry**. Don't use the older LXDE
`lxsession` autostart file (`~/.config/lxsession/LXDE-pi/autostart`) — on Bookworm it silently
skips custom entries more often than not. The `~/.config/autostart` XDG entry below is honoured
across desktop sessions and fires at the right point in startup:

```
$ mkdir -p ~/.config/autostart
$ nano ~/.config/autostart/backdrop-kiosk.desktop
```

Paste:

```
[Desktop Entry]
Type=Application
Name=Backdrop Kiosk
Exec=/home/pi/kiosk.sh
X-GNOME-Autostart-enabled=true
```

Save/exit. That's the whole autostart — no lxsession file needed.

## 12. The moment of truth — reboot

```
$ sudo reboot
```

The Pi should come up, log into the desktop by itself, and within a few seconds show Backdrop's
near-black **idle gradient** full-screen. Then trigger a play from your laptop or the Pi (replace
`SECRET`), and the `demo.mp4` should fade in and loop:

```
$ curl -s -H "X-Trigger-Secret: SECRET" -H "content-type: application/json" \
    -X POST http://localhost:4740/api/scan \
    -d '{"event":"start","uri":"curator:album:demo","tagUid":"04:A1","at":"now"}'
```

Send a stop to fade back to idle:

```
$ curl -s -H "X-Trigger-Secret: SECRET" -H "content-type: application/json" \
    -X POST http://localhost:4740/api/scan -d '{"event":"stop","at":"now"}'
```

Finally, the real test: **pull the power, wait, plug it back in.** It should boot straight back to the
idle screen with no interaction. That's a working appliance.

## 13. Connect Backdrop to the rest of Marquee

Backdrop just waits for HTTP calls; two other things drive it, both over your LAN using the Pi's
address (`backdrop.local` or its IP) on port **4740**:

- **Stylus** (the NFC reader in the stand) POSTs scan events to `/api/scan` with the shared secret
  when you place/remove a sleeve. This is what plays videos in real use — the `curl`s above just
  imitate it.
- **Curator** (on your workstation) keeps the Pi stocked: it pushes the URI→video map to
  `/api/library/sync` (or `/api/library/update` per album) and copies the actual `.mp4` files into
  `~/Marquee/packages/backdrop/data/media/visualizers/` (e.g. with `rsync`/`scp`). Metadata and files
  sync independently — Backdrop tolerates a library entry whose file hasn't landed yet (it shows a
  quiet "video file missing" hint instead of crashing).

To make the Pi easy to find, give it a fixed address: add a **DHCP reservation** for it in your
router, or rely on the `backdrop.local` name (mDNS) if your network supports it.

## 14. Troubleshooting

| Symptom                                                                                   | Likely cause / fix                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| SSH: `Permission denied` at the password prompt                                           | You're probably logging in as the wrong user — the prompt must say `pi@…` (or whatever username you set in Imager). Plain `ssh <ip>` silently uses your **laptop's** username. Also: nothing appears while typing a password (normal), and if you picked "public-key only" in Imager's SSH setting, all passwords are rejected — log in on the Pi directly and set `PasswordAuthentication yes` in `/etc/ssh/sshd_config`, then `sudo systemctl restart ssh`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `git clone` asks for a username, then fails: _"Password authentication is not supported"_ | The repo is private and GitHub doesn't accept account passwords for git. Do step 6's `gh auth login` browser flow, then clone with `gh repo clone dylanleatham/Marquee`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `gh repo clone` fails: _"Could not resolve to a Repository"_                              | You're authenticated as a GitHub account that can't see the private repo — the browser you approved the device code in was signed into the wrong account. `gh auth status` shows who the Pi is logged in as; if it's wrong, `gh auth logout`, sign into github.com as the repo owner on your laptop, and rerun `gh auth login`. If the account is right but it still fails, the token lacks the `repo` scope: `gh auth refresh -h github.com -s repo`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Boots to the **desktop**, no kiosk                                                        | The autostart didn't launch `kiosk.sh`. Check `/tmp/kiosk.log`: **missing/empty** = the autostart entry never ran the script — use the XDG entry `~/.config/autostart/backdrop-kiosk.desktop` (step 11c), _not_ the lxsession file, which skips entries on Bookworm; **has lines** = the script ran, so read the Chromium error it logged. Also confirm `~/kiosk.sh` is executable and you're on the X11 desktop (step 11a).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Kiosk shows but the **mouse cursor** is visible                                           | Install `unclutter` and add `unclutter -idle 0 -root &` to `kiosk.sh` before the Chromium line (step 11b).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| **Blank white screen** in the kiosk                                                       | The `.css`/`.js` didn't load, so the black background never applied. Almost always: your clone predates the relative-asset-path fix (`grep styles.css ~/Marquee/packages/backdrop/public/index.html` — `href="/styles.css"` with the leading slash is the broken version). Fix: `cd ~/Marquee && git pull`. Also confirm you launched the exact `file://…/public/index.html` path.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Chromium asks to **create/unlock a keyring password**                                     | Chromium is trying to use the GNOME keyring, which auto-login never unlocks — on a headless boot this silently blocks the kiosk. Make sure `kiosk.sh` launches Chromium with `--password-store=basic` (step 11b).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Idle gradient shows, but a scan does nothing                                              | Objective check (no colour needed): `curl -s -o /dev/null -w '%{http_code}' localhost:4740/healthz` → `503` means no browser is connected. Or open `?debug=1` and read the `ws online/offline` label. A "video not in library" / "video file missing" toast = the URI isn't registered or the file isn't in `media_dir` — check `journalctl -u backdrop` for the matching warning.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Scan is accepted but the screen **stays black** (plays nothing)                           | `{"accepted":true}` only means the scan was received, not that a video played. Usual causes: the file isn't actually on disk, or it isn't **H.264** — `ffprobe -v error -select_streams v:0 -show_entries stream=codec_name -of csv=p=0 <file>` must print `h264`; re-encode otherwise (use the full flag set from step 9). `api/status` showing `"state":"playing"` confirms the backend found the file (so it's a codec/decode issue).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Video plays but **flickers, stutters, or tears** throughout                               | **Ask the Pi first — don't guess.** `curl -s -H "X-Trigger-Secret: SECRET" localhost:4740/api/status` now reports `playbackQuality` while something is playing ([ADR 0046](../../docs/adrs/0046-layer-roles-swap-on-screen-and-the-pi-reports-its-own-decode.md)). `"degraded": true` with a `droppedPct` over 2 means the board genuinely can't decode this clip — it decodes H.264 in software ([ADR 0040](../../docs/adrs/0040-visualizers-carry-a-decode-budget.md)) — so check the bitrate (`ffprobe -v error -select_streams v:0 -show_entries stream=bit_rate -of csv=p=0 <file>`; much over `10000000` will stutter at 1080p) and re-encode with step 9's flags. `"degraded": false` means decode is **not** the problem: rule out the two board-level causes, `vcgencmd get_throttled` (non-zero = thermal/undervoltage throttling) and `xrandr \| grep '\*'` (a 4K panel makes Chromium rescale every frame — force 1920x1080). `journalctl -u backdrop` logs one line the first time a clip goes degraded, so an evening's worth is greppable after the fact. |
| Video **cuts to black, restarts, or flashes the idle gradient when you swap sleeves**     | Your clone predates [#211](https://github.com/dylanleatham/Marquee/issues/211). The kiosk's two video layers swapped roles on a timer, so any command landing inside a 450 ms crossfade was handed the element already on screen. `cd ~/Marquee && git pull`, rebuild (step 15) and **reload the kiosk browser** — the SPA is static, so a backend restart alone changes nothing.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Kiosk boots to a **solid black screen** (no idle gradient at all)                         | Distinct from the white-screen row above. First: did you add GPU flags to `kiosk.sh`? `--ignore-gpu-blocklist` / `--enable-gpu-rasterization` / `--enable-zero-copy` override Chromium's blocklist for the Pi's vc4/V3D driver and can take the GPU process down so nothing ever paints — remove them and reboot (see the warning in step 11b). Otherwise check `/tmp/kiosk.log` for a Chromium error, and confirm Chromium is actually running (`pgrep -a chromium`); a dead launcher shows the desktop, not black, so black usually means Chromium is up but not rendering. A backend that is down does **not** cause this — the page is a local `file://` that paints the gradient with no backend at all.                                                                                                                                                                                                                                                                                                                                                            |
| ffmpeg / player says **"Is a directory"**                                                 | Something created a _folder_ where the `.mp4` should be. `rm -rf ~/Marquee/packages/backdrop/data/media/visualizers/demo.mp4` and recreate the file (step 9).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `401 unauthorized` from a `curl`                                                          | Shared secret mismatch — the `X-Trigger-Secret` header must equal `config.toml`'s `shared_secret`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Screen goes black after ~10 min                                                           | Screen blanking still on. Re-check step 11a (raspi-config) and the `xset` lines in `kiosk.sh`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Backend won't start                                                                       | `journalctl -u backdrop -e` shows the error. Common: wrong path/username in the service file, or you never ran the build in step 6.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

## 15. Updating Backdrop later

When there's new code:

```
$ cd ~/Marquee
$ git pull
$ pnpm install
$ pnpm --filter @marquee/backdrop build
$ sudo systemctl restart backdrop
```

Then reload the kiosk browser so it picks up any SPA changes — simplest is `sudo reboot`.
