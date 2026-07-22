# Runbook — set up, bring up, and operate Marquee

Two parts:

- **[Part A — Set up & install](#part-a--set-up--install)** — the step-by-step to go from bare Pis to
  the first real "place record → room reacts" (runtime-overview §10 step 11, issue #52).
- **[Part B — Operate the live system](#part-b--operate-the-live-system)** — the day-to-day reference
  once it's running.

**Topology** (runtime-overview §7): **Curator** on your workstation; **Conductor + Backdrop** on the
**Pi 5** by the TV; **Stylus** on the **Pi Zero 2 W** in the stand. Hue bridge, both Pis, and the
workstation must share one **LAN**.

| Service       | Host        | Port          | Prod start                                      |
| ------------- | ----------- | ------------- | ----------------------------------------------- |
| Curator       | workstation | 4739          | `pnpm --filter @marquee/curator dev`            |
| Hue Conductor | Pi 5        | 4737          | systemd: `marquee-conductor` (`node dist/…`)    |
| Backdrop      | Pi 5        | 4740          | systemd: `marquee-backdrop` (+ Chromium unit)   |
| Stylus        | Pi Zero 2 W | 4741 (status) | systemd: `marquee-stylus`                       |

**One shared secret everywhere.** Every service-to-service call carries `X-Trigger-Secret`; pick one
value and use it in Conductor's `[auth]`, Backdrop's auth, Curator's outbound config, and Stylus's
config. LAN "prevent accidents" auth (runtime-overview §8), not real security — but every hop must
match or you'll get 401s.

---

## Part A — Set up & install

Work top-to-bottom; each step ends with a **Check** so a failure tells you which layer it's in.

### A1. Pi 5 base image (hosts Conductor + Backdrop)

1. Flash **Raspberry Pi OS (64-bit)** with Raspberry Pi Imager; in its settings pre-set the hostname
   (e.g. `marquee-pi5`), enable **SSH**, and give it your Wi-Fi/LAN creds. Boot it, `ssh pi@marquee-pi5`.
2. Install **Node 22** + **pnpm**:
   ```sh
   curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -   # or nvm
   sudo apt-get install -y nodejs git chromium-browser
   sudo corepack enable            # provides pnpm
   ```
3. Clone + build the two services (use one repo path, e.g. `/home/pi/marquee`):
   ```sh
   git clone <repo-url> /home/pi/marquee && cd /home/pi/marquee
   pnpm install
   pnpm --filter @marquee/hue-conductor build
   pnpm --filter @marquee/backdrop build
   ```
   - **Check:** `node /home/pi/marquee/packages/hue-conductor/dist/server.js` starts and logs a port.
     `Ctrl-C` — we'll run it under systemd below.

### A2. Conductor on the Pi 5 (the lights half)

1. **Config** — `packages/hue-conductor/config.toml`:
   ```toml
   [auth]
   shared_secret = "<your-lan-secret>"
   [storage]
   data_dir = "data"                                   # bridge credential + settings
   album_assets_dir = "/home/pi/marquee-data/album-assets"   # the rsync target (issue #45)
   [runtime]
   idle_timeout_minutes = 90                           # safety net for a lost stop
   ```
2. **Pair the Hue bridge:** `pnpm --filter @marquee/hue-conductor pair`, then **press the bridge's link
   button** when prompted. It discovers the bridge, waits for the press, and saves the application key
   into `data_dir`.
3. **systemd unit** — `/etc/systemd/system/marquee-conductor.service`:
   ```ini
   [Unit]
   Description=Marquee Hue Conductor
   Wants=network-online.target
   After=network-online.target
   [Service]
   WorkingDirectory=/home/pi/marquee/packages/hue-conductor
   ExecStart=/usr/bin/node dist/server.js
   Restart=on-failure
   User=pi
   [Install]
   WantedBy=multi-user.target
   ```
   `sudo systemctl enable --now marquee-conductor`.
4. **Set the listening room:** `GET /api/rooms` to find the id, then
   `PUT /api/settings { "listeningRoomId": "<roomId>" }` (or set it from Curator's Demo Room). Scans
   carry no room — they drive this one.
   - **Check:** `GET /healthz` → `{ ok: true, paired: true }`. Then prove the bridge path with
     `POST /api/test/color { "roomId": "<id>", "hex": "#4B0082" }` → that room turns purple.
     (All `/api/*` calls need `-H "X-Trigger-Secret: <secret>"`.)

### A3. Backdrop on the Pi 5 (the video half)

1. **Config** — shared secret + the media dir where visualizer `.mp4`s live on the Pi
   (e.g. `/home/pi/marquee-data/media/visualizers`).
2. **Node service** — `/etc/systemd/system/marquee-backdrop.service`, same shape as Conductor's but
   `WorkingDirectory=…/packages/backdrop` and `ExecStart=/usr/bin/node dist/server.js`.
   `sudo systemctl enable --now marquee-backdrop`.
3. **Kiosk browser** — Backdrop's SPA is a `file://` kiosk that connects back over WebSocket
   (backdrop/README.md). A second unit `marquee-kiosk.service` (needs the desktop/X session) runs:
   ```sh
   chromium-browser --kiosk --start-fullscreen --window-position=0,0 \
     --autoplay-policy=no-user-gesture-required \
     --app=file:///home/pi/marquee/packages/backdrop/public/index.html?debug=0
   ```
   - **Check:** `GET /api/status` shows it up with a browser connected. With a library entry synced
     (A4), `POST /api/admin/simulate-scan { "uri": "curator:album:<id>" }` plays that video on the TV;
     `POST /api/admin/stop` returns it to the idle gradient.

### A4. Curator on the workstation + sync

1. **Config** — `packages/curator/config.toml`:
   ```toml
   [conductor]
   url = "http://marquee-pi5:4737"
   shared_secret = "<your-lan-secret>"
   [backdrop]
   url = "http://marquee-pi5:4740"
   shared_secret = "<your-lan-secret>"
   media_dir = "/home/pi/marquee-data/media/visualizers"   # Backdrop's media dir ON THE PI (roots filePath)
   ```
2. **Prep one album** so both halves have something to show:
   - Add an album (Spotify / Discogs / manual); let Roadie reach at least **`awaiting_review`** —
     Conductor needs a **palette + pattern** (present from `awaiting_review` on) or a scan degrades to
     `202 ignored: album not ready`.
   - Attach or **splice** a visualizer video (issue #29) so Backdrop has a file to play.
3. **Sync to the Pi:**
   - **Asset store → Conductor:** `rsync -a ~/marquee/album-assets/ pi@marquee-pi5:/home/pi/marquee-data/album-assets/`
     (must equal Conductor's `album_assets_dir`).
   - **Videos → Backdrop:** `rsync -a ~/marquee/media/visualizers/ pi@marquee-pi5:/home/pi/marquee-data/media/visualizers/`.
   - **Library projection → Backdrop:** `POST /api/backdrop/sync` on Curator pushes the URI→file map.
   - **Check:** `POST /api/backdrop/verify-sync` on Curator reports no drift.

### A5. Smoke-test the full chain — *before* the stand

Prove the software resolves the album's URI before any NFC is involved. With the album's `curatorId`
from Curator (`URI=curator:album:<curatorId>`, `SECRET=<your-lan-secret>`):

```sh
# Lights (Conductor) — a raw scan, exactly what Stylus will send:
curl -s -XPOST http://marquee-pi5:4737/api/scan -H "X-Trigger-Secret: $SECRET" \
  -H 'content-type: application/json' \
  -d "{\"event\":\"start\",\"uri\":\"$URI\",\"tagUid\":\"test\",\"at\":\"$(date -Iseconds)\"}"
# Video (Backdrop) — its own simulate helper:
curl -s -XPOST http://marquee-pi5:4740/api/admin/simulate-scan -H "X-Trigger-Secret: $SECRET" \
  -H 'content-type: application/json' -d "{\"uri\":\"$URI\"}"
```

- **Lights change and the video plays.**
- **Confirm Conductor actually acted** (issue #54): `GET http://marquee-pi5:4737/api/playback/current`
  → lists the album (`source.name`, `pattern`, `startedAt`). If it's **empty**, read the `action`/
  `reason` from the scan response and see the debug matrix below.
- **Stop:** `POST …/api/scan {"event":"stop","at":"…"}` (Conductor) + `POST …/api/admin/stop`
  (Backdrop) → both fade to idle; `current` empties and `/api/playback/history` shows the playback with
  a `stoppedAt`.

Getting a clean start/stop here isolates "the software chain works" from "the NFC/mount is tuned."

### A6. Stylus on the Pi Zero 2 W

#### A6.1 Wire the PN532 reader to the Pi (physical)

The code drives the PN532 in **I²C mode** (`adafruit_pn532.i2c`), so the module and the wiring must be
I²C. The authoritative pinout lives in **stylus-spec §4**; repeated here so you don't have to leave the
page. **Power off the Pi before wiring.**

1. **Set the module to I²C.** A PN532 board has a little interface selector — a pair of **DIP switches**
   or **solder-jumper pads**. Set it to **I2C** using the combo printed on your board's silkscreen (each
   board revision labels it slightly differently, so trust the label, not a remembered setting; the
   `i2cdetect` check in step 4 confirms you got it right). Adafruit breakouts default to I²C.
2. **Connect 4 jumper wires** PN532 → Pi Zero 2 W (Pi pin numbers are the physical header positions,
   counting the 40-pin header with pin 1 nearest the SD card / corner):

   | PN532 pin | Pi Zero 2 W pin        | Wire      |
   | --------- | ---------------------- | --------- |
   | VCC       | **3.3V** (pin 1)       | red       |
   | GND       | **GND** (pin 6)        | black     |
   | SDA       | **GPIO 2 / SDA** (pin 3)| e.g. blue |
   | SCL       | **GPIO 3 / SCL** (pin 5)| e.g. green|

   ⚠️ Use **3.3V (pin 1), not 5V** — the Pi's I²C lines are 3.3V. Double-check SDA→pin 3 and SCL→pin 5
   before powering on.
3. **Status LED** (optional but nice): LED long leg (anode) → a **330Ω resistor** → **GPIO 17 (pin 11)**;
   LED short leg (cathode) → any GND. GPIO 17 HIGH = LED on. (Configurable — `[led].gpio_pin`, default 17.)
4. **Enable I²C on the Pi:** `sudo raspi-config` → *Interface Options* → *I2C* → *Enable*, then reboot.
   - **Check the bus sees the reader:** `sudo apt-get install -y i2c-tools && i2cdetect -y 1` should show
     a device (the PN532 answers at address **0x24**). If the grid is empty, re-check the 4 wires and the
     I²C DIP/jumper setting before going further.

#### A6.2 Install + run Stylus

1. Clone the repo on the Pi Zero; install Python 3 + the Stylus package **with hardware extras**
   (`adafruit-circuitpython-pn532`, `Adafruit-Blinka` for `board`/`busio`) per `packages/stylus/README.md`
   / `pyproject.toml`. These are imported lazily, only on the Pi (ADR 0016).
2. **Config** (`packages/stylus/config.example.toml` → your `config.toml`): Conductor + Backdrop URLs and
   the shared secret; keep `[led].gpio_pin = 17` unless you wired the LED elsewhere.
3. Run the real reader: `python -m stylus` (the default builds `create_pn532_reader`; `--simulated` uses
   the fake). Then a `marquee-stylus` **systemd** unit with `Wants=network-online.target` +
   restart-on-hang (stylus-spec §12).
   - **Check:** logs show it polling; hold a written NTAG213 near the antenna → it reads the UID + URI and
     POSTs a `start`.

#### A6.3 Simulate a read without a tag

Stylus's status server (port 4741) can inject a fake read that fans out exactly like a real one — handy
before the antenna/mount is tuned:
```sh
curl -XPOST http://marquee-pizero:4741/simulate -d '{"uid":"04:A1:B2","uri":"curator:album:<id>"}'
curl -XPOST http://marquee-pizero:4741/simulate -d '{"clear":true}'   # = sleeve lifted
```
- **Check:** the simulate fires the same start/stop the A5 curl did — now driven through Stylus end-to-end.

### A7. Tag the sleeve + the real scan

**What goes on the tag.** An **NTAG213** carrying one **NDEF well-known record** — a **URI record**
(type `U`) or a **Text record** (type `T`) — whose content is the literal `curator:album:<curatorId>`.
Stylus's parser (`packages/stylus/stylus/ndef.py`) accepts either. `curator:` is a custom scheme, so a
URI record stores it with prefix-code `0x00` (no abbreviation) + the full string — which is exactly
what any writer produces when you give it a non-`http`/`tel`/… URI. NTAG213's ~144 bytes is far more
than enough.

#### Option 1 — phone (simplest for unique per-album URIs)

In **NFC Tools** (or **NXP TagWriter**): *Write* → *Add a record* → **URI/URL** (or **Text**) →
`curator:album:<curatorId>` → *Write*, hold the sticker to the phone. Each album has a unique
`curatorId`, so this is the path of least friction when every tag differs.

#### Option 2 — Flipper Zero

The Flipper shines at **reading/verifying** and **bench-testing**; for *authoring* a brand-new custom
URI its on-device NDEF editor is firmware-dependent, so the reliable pattern is author-once-then-clone.

- **Read / verify a tag** (native, reliable): **NFC → Read**, hold the Flipper over the tag. It
  identifies **NTAG213**, shows the **UID**, and parses the **NDEF** — confirm the `curator:album:<id>`
  string is there and matches the album. Use this to check a sticker after writing, or to debug "the
  stand isn't reacting" (is the tag even readable, and is the URI right?). **Save** it (e.g.
  `album_<curatorId>`) if you want to reuse it below.
- **Write by clone** (for duplicates of the *same* album): author one good tag with the phone (Option
  1), **NFC → Read → Save** it on the Flipper, then **NFC → Saved → _that file_ → Write** onto blank
  NTAG213s. This clones identical tags fast. (For *different* albums, each needs its own source tag —
  the phone is simpler than editing NDEF pages by hand.) If your firmware (official 1.x, Momentum,
  Unleashed, RogueMaster) exposes an NDEF/"Add card → URL" authoring flow, you can compose
  `curator:album:<id>` directly instead of cloning — the menu path varies by firmware.
- **Emulate a tag to test *without a sticker*** (great during bring-up): with a tag saved, **NFC →
  Saved → _file_ → Emulate**, then hold the Flipper against the **PN532** on the stand. Stylus reads it
  as if a sleeve were placed → the whole chain fires. Lets you test read range, debounce, and the
  publish path before you've stuck anything on a sleeve. (UID emulation is reliable; full NTAG NDEF
  emulation depends on firmware — if Stylus doesn't get the URI while emulating, fall back to a real
  written tag.)

> ⚠️ **Don't touch the lock/password pages.** NTAG213 **lock bits** and **password (AUTH0/PWD)** pages
> are one-way — a write that sets them can permanently freeze a tag read-only or lock you out. Stick to
> writing the **NDEF data** only; avoid any "lock", "set password", or "unlock" action on the Flipper
> or the phone app.

2. Stick the written tag on the sleeve. (Marking it written in-app is issue #55 — not required for the test.)
3. **The moment:** place the tagged sleeve on the stand → lights + video become the record. Lift it →
   both fade back.

---

## Part B — Operate the live system

### Common operations

- **Pair / re-pair the Hue bridge:** on the Pi, `pnpm --filter @marquee/hue-conductor pair`, press the
  bridge link button when prompted.
- **Force a service back to idle:** `POST http://<pi>:4737/api/playback/stop` (Conductor) /
  `POST http://<pi>:4740/api/admin/stop` (Backdrop).
- **Re-sync after adding/attaching:** Curator → `POST /api/backdrop/sync` (library projection) + rsync
  the asset store and videos to the Pi (A4.3); `POST /api/backdrop/verify-sync` to confirm.
- **See what's playing / recently played:** `GET /api/playback/current` and
  `GET /api/playback/history?limit=50` on Conductor (issue #54).
- **Check logs:** `journalctl -u marquee-<service> -f` on the Pi.

### Debug matrix

| Symptom | Look at | Likely cause |
| --- | --- | --- |
| `/api/test/color` does nothing | Conductor logs; `GET /api/bridge/status` | Not paired / bridge unreachable — re-run pairing (A2.2) |
| Any scan → 401 | the `X-Trigger-Secret` on every hop | Secret mismatch between Stylus/Curator and Conductor/Backdrop |
| Scan `202 ignored: no listening room` | `GET /api/settings` | Listening room not set (A2.4) |
| Scan `202 ignored: album not synced` | the Pi's `album_assets_dir` | rsync didn't land `{curatorId}.json` (A4.3) |
| Scan `202 ignored: album not ready` | the album's Roadie state in Curator | No palette/pattern yet — advance to `awaiting_review` (A4.2) |
| Lights work, no video | Backdrop logs; `POST /api/backdrop/verify-sync` | Library not synced / video file not on Backdrop's SD (A4.3) |
| `current` empty but scan returned `playing` | Conductor logs | Bridge call failed mid-apply (409 not paired / 502) |
| Sleeve on stand does nothing, but A5/A6 worked | Stylus logs; LED | NFC read/mount tuning, or Stylus can't reach the Pi 5 |
| Effect stays after lifting the sleeve | — | Missed `stop`; the 90-min idle timeout is the backstop, or stop it by hand |

Full failure-mode table: `docs/specs/runtime-overview.md §9`. During bring-up, the scan response's
`action`/`reason` plus Conductor's `/api/playback/current` are your fastest signal for which layer is
at fault.
