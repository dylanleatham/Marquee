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

You need one real video to see anything. From **your laptop**, copy an H.264 `.mp4` onto the Pi
(any short clip works for testing):

```
$ scp ~/Downloads/test.mp4 pi@backdrop.local:~/Marquee/packages/backdrop/data/media/visualizers/demo.mp4
```

Then, in an SSH session **on the Pi**, get its absolute path and register it in the library (again,
replace `SECRET`):

```
$ realpath ~/Marquee/packages/backdrop/data/media/visualizers/demo.mp4
/home/pi/Marquee/packages/backdrop/data/media/visualizers/demo.mp4

$ curl -s -H "X-Trigger-Secret: SECRET" -H "content-type: application/json" \
    -X POST http://localhost:4740/api/library/update \
    -d '{"uri":"curator:album:demo","filePath":"/home/pi/Marquee/packages/backdrop/data/media/visualizers/demo.mp4","durationSec":10}'
```

(This won't work unless the backend from step 8 is running — either restart it by hand, or come back
to this after step 10 when it auto-starts.)

## 10. Make the backend start on boot (systemd)

`systemd` is Linux's "start these programs and keep them alive" manager. Create a service file:

```
$ sudo nano /etc/systemd/system/backdrop.service
```

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

Create the script:

```
$ nano ~/kiosk.sh
```

Paste:

```bash
#!/bin/bash
# Wait until the Backdrop backend is listening before opening the browser. /healthz returns 503
# until a browser attaches (which is us), so we just wait for *any* HTTP response — 000 means
# "connection refused / not up yet".
until [ "$(curl -s -o /dev/null -w '%{http_code}' http://localhost:4740/healthz)" != "000" ]; do
  sleep 1
done

# Keep the screen awake (belt-and-braces with raspi-config's screen-blanking setting).
xset s off
xset -dpms
xset s noblank

# Launch Chromium full-screen with no chrome, no update nags, no "restore pages" bubble.
chromium-browser \
  --kiosk --start-fullscreen --window-position=0,0 \
  --noerrdialogs --disable-infobars --disable-session-crashed-bubble \
  --check-for-update-interval=31536000 \
  --autoplay-policy=no-user-gesture-required \
  --app="file:///home/pi/Marquee/packages/backdrop/public/index.html"
```

Save/exit, then make it executable:

```
$ chmod +x ~/kiosk.sh
```

> Add `?debug=1` to the end of the `file://...index.html` URL while testing — it shows a green/red
> WebSocket dot in the bottom-right and the current video path in the bottom-left. Remove it for the
> real thing so the screen stays clean.

### 11c. Auto-start the script with the desktop

Tell the X11 desktop to run the script when it starts:

```
$ mkdir -p ~/.config/lxsession/LXDE-pi
$ nano ~/.config/lxsession/LXDE-pi/autostart
```

Paste these three lines:

```
@lxpanel --profile LXDE-pi
@pcmanfm --desktop --profile LXDE-pi
@/home/pi/kiosk.sh
```

Save/exit.

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

| Symptom                                                                                   | Likely cause / fix                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SSH: `Permission denied` at the password prompt                                           | You're probably logging in as the wrong user — the prompt must say `pi@…` (or whatever username you set in Imager). Plain `ssh <ip>` silently uses your **laptop's** username. Also: nothing appears while typing a password (normal), and if you picked "public-key only" in Imager's SSH setting, all passwords are rejected — log in on the Pi directly and set `PasswordAuthentication yes` in `/etc/ssh/sshd_config`, then `sudo systemctl restart ssh`. |
| `git clone` asks for a username, then fails: _"Password authentication is not supported"_ | The repo is private and GitHub doesn't accept account passwords for git. Do step 6's `gh auth login` browser flow, then clone with `gh repo clone dylanleatham/Marquee`.                                                                                                                                                                                                                                                                                      |
| `gh repo clone` fails: _"Could not resolve to a Repository"_                              | You're authenticated as a GitHub account that can't see the private repo — the browser you approved the device code in was signed into the wrong account. `gh auth status` shows who the Pi is logged in as; if it's wrong, `gh auth logout`, sign into github.com as the repo owner on your laptop, and rerun `gh auth login`. If the account is right but it still fails, the token lacks the `repo` scope: `gh auth refresh -h github.com -s repo`.        |
| Blank desktop, no Backdrop page                                                           | Kiosk script didn't run. Check `~/.config/lxsession/LXDE-pi/autostart` and that `~/kiosk.sh` is executable. Are you on the X11 desktop (step 11a)?                                                                                                                                                                                                                                                                                                            |
| Page loads but **unstyled / frozen**                                                      | The `.css`/`.js` didn't load — make sure you launched the `file://.../public/index.html` path exactly, and that you're on a build that includes this doc (older builds used absolute asset paths that break under `file://`).                                                                                                                                                                                                                                 |
| Idle gradient shows, but a scan does nothing                                              | Open with `?debug=1`. Red dot = backend not reachable (`systemctl status backdrop`). A "video not in library" / "video file missing" toast = the URI isn't registered or the file isn't in `media_dir` — check `journalctl -u backdrop` for the matching warning.                                                                                                                                                                                             |
| Video registered but won't play                                                           | The file must be **H.264 in an .mp4**. Re-encode if unsure: `ffmpeg -i in.mov -c:v libx264 -pix_fmt yuv420p out.mp4`.                                                                                                                                                                                                                                                                                                                                         |
| `401 unauthorized` from a `curl`                                                          | Shared secret mismatch — the `X-Trigger-Secret` header must equal `config.toml`'s `shared_secret`.                                                                                                                                                                                                                                                                                                                                                            |
| Screen goes black after ~10 min                                                           | Screen blanking still on. Re-check step 11a (raspi-config) and the `xset` lines in `kiosk.sh`.                                                                                                                                                                                                                                                                                                                                                                |
| Backend won't start                                                                       | `journalctl -u backdrop -e` shows the error. Common: wrong path/username in the service file, or you never ran the build in step 6.                                                                                                                                                                                                                                                                                                                           |

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
