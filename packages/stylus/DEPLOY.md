# Stylus on a Raspberry Pi Zero 2 W — from unboxing to reading sleeves

The physical bring-up of the NFC reader that lives in the album stand
([issue #52](https://github.com/dylanleatham/Marquee/issues/52), runtime-overview §10 step 11). By
the end, placing a tagged sleeve on the stand fires a `start` to Conductor and Backdrop, and lifting
it fires a `stop`.

Companion docs: [`docs/bring-up-checklist.md`](../../docs/bring-up-checklist.md) is the gated
tick-list for the whole chain — **this file is its Phase 6**. [`docs/runbook.md` A6/A7](../../docs/runbook.md)
is the same ground in prose. If you only want to hack on Stylus on your laptop, you need none of
this — see the [README](README.md) "Run it on the bench".

> **Do GATE 5 first.** The checklist's Phase 5 proves the whole software chain with `curl` and no
> NFC at all. Everything in this document is antenna, wiring, and mount — debugging it while the
> software chain is also unproven means two suspects instead of one. Don't start here.

> **Time budget:** ~1 hour, most of it waiting on `pnpm`-free Python installs and one `apt upgrade`.
> Steps 1–2 need the SD card in your laptop; everything after is SSH.

---

## 0. What you need

- **Raspberry Pi Zero 2 W** — with the 40-pin header **soldered on** (the "WH" variant, or you
  solder it). The four reader wires have nowhere to go otherwise.
- **PN532 NFC module**, I²C-capable (Elechouse v3 or the "PN532 NFC HAT")
- **microSD card**, 16GB+, and a micro-USB 5V/2A supply
- **4× female-female jumper wires**
- Optional: an LED + **330Ω** resistor for the status light
- Your Wi-Fi name/password, and the **shared secret** the rest of Marquee uses

The reader talks I²C, so the module must be _switched_ to I²C — see step 5.

---

## 1. Flash the OS

In **Raspberry Pi Imager**:

1. **Choose Device:** Raspberry Pi Zero 2 W.
2. **Choose OS:** _Raspberry Pi OS **Lite** (64-bit)_. Lite, not the desktop — Stylus has no UI, and
   a Zero 2 W boots and updates dramatically faster without a desktop it will never draw.
3. **Choose Storage:** your microSD card. ⚠️ Confirm it's the card, not your laptop's own drive.
4. **Next → Edit Settings**, and set:
   - **Hostname:** `marquee-pizero` (reachable as `marquee-pizero.local`)
   - **Username / password:** username `pi` (the shipped systemd unit assumes `pi`; if you pick
     another name you must edit two lines in step 9)
   - **Wireless LAN:** your SSID + password, and set the **Wi-Fi country** or Wi-Fi stays off.
     ⚠️ It must be the **same LAN/subnet** as the Pi 5 and the Hue bridge (checklist GATE 0).
   - **Locale:** your timezone and keyboard layout
   - **Services** tab: **Enable SSH** → _Use password authentication_
5. **Save → Yes → Yes**. Wait ~5 minutes, then eject.

> The Zero 2 W is **2.4GHz-only**. If your router splits its bands into separate names, give Imager
> the 2.4GHz one — a 5GHz-only SSID silently never associates and you'll be hunting a "dead Pi"
> that's actually fine.

## 2. First boot and SSH in

Put the card in, plug the micro-USB power into the port marked **PWR** (the inner one is `USB`, and
powering the wrong port does nothing). Give it **~2 minutes** — a Zero 2 W's first boot is slow.
Then from your laptop:

```
$ ssh pi@marquee-pizero.local
```

Type `yes` to trust it, then your password. (Nothing appears while you type a password — normal.)

> ⚠️ **Include the `pi@`.** Plain `ssh marquee-pizero.local` silently uses your _laptop's_ username
> and every password gets `Permission denied` no matter how correctly you type it.

If `.local` doesn't resolve, find the Pi's IP in your router's client list and `ssh pi@<ip>`.

## 3. Update, and confirm the clock

Every scan event carries an ISO timestamp, so a wrong clock produces confusing downstream logs.

```
$ sudo apt update && sudo apt full-upgrade -y
$ sudo reboot
```

Wait a minute, SSH back in, and confirm `System clock synchronized: yes`:

```
$ timedatectl
```

## 4. Enable I²C

```
$ sudo raspi-config
```

**Interface Options → I2C → Enable** → **Finish** → reboot when it offers. Then install the bus
tools and add yourself to the hardware groups (the `-a` matters — without it you _replace_ your
groups and lock yourself out of `sudo`):

```
$ sudo apt install -y i2c-tools python3-venv python3-dev build-essential git
$ sudo usermod -aG i2c,gpio pi
$ sudo reboot
```

Group changes only take effect on a fresh login, hence the reboot.

> **Why `python3-dev` and `build-essential`?** Blinka depends on `RPi.GPIO` and `rpi_ws281x`, both C
> extensions with no aarch64 wheels — pip compiles them from source. Pi OS Lite ships a compiler but
> not the Python headers, so without these the install dies on
> `fatal error: Python.h: No such file or directory` after several minutes of downloading. (`rpi_ws281x`
> is NeoPixel support Stylus never uses; it's a hard dependency of Blinka, so it still has to build.)

## 5. Wire the reader — **power the Pi off first**

```
$ sudo shutdown -h now
```

Wait for the green LED to stop blinking, then **unplug the power**.

**Set the module to I²C.** Every PN532 board has an interface selector — a pair of **DIP switches**
or **solder-jumper pads**. Set it to **I2C** using the combo printed on your board's silkscreen.
Board revisions label this differently, so trust the silkscreen, not a remembered setting;
`i2cdetect` in step 7 is what confirms you got it right. (Adafruit breakouts default to I²C.)

**Four wires**, PN532 → Pi. Pi pin numbers are physical header positions, counting with **pin 1
nearest the corner/SD card**, odd numbers down the side nearest the board edge:

| PN532 pin | Pi Zero 2 W pin          | Wire       |
| --------- | ------------------------ | ---------- |
| VCC       | **3.3V** (pin 1)         | red        |
| GND       | **GND** (pin 6)          | black      |
| SDA       | **GPIO 2 / SDA** (pin 3) | e.g. blue  |
| SCL       | **GPIO 3 / SCL** (pin 5) | e.g. green |

> ⚠️ **3.3V (pin 1), not 5V.** The Pi's I²C lines are 3.3V and there is no level shifter here.
> Double-check SDA→pin 3 and SCL→pin 5 before you power on — swapping them is the single most
> common reason `i2cdetect` comes back empty.

**Status LED** (optional): LED long leg (anode) → **330Ω resistor** → **GPIO 17 (pin 11)**; short leg
(cathode) → any GND. Configurable via `[led].gpio_pin`.

Power the Pi back on and SSH in.

## 6. Get the code and install

The repo is private, so authenticate first — GitHub no longer accepts account passwords for git:

```
$ sudo apt install -y gh
$ gh auth login
```

**GitHub.com** → **HTTPS** → _"Authenticate Git with your GitHub credentials?"_ **Yes** → **Login
with a web browser**. Open the printed URL on your laptop — **signed in as the repo owner** — and
enter the code.

```
$ cd ~
$ gh repo clone dylanleatham/Marquee
$ cd Marquee/packages/stylus
```

Now install into a **virtual environment**. Raspberry Pi OS Bookworm marks its system Python
"externally managed", so a plain `pip install` refuses with `error: externally-managed-environment`.
The venv is the supported answer (and what the systemd unit's `ExecStart` points at):

```
$ python3 -m venv .venv
$ .venv/bin/pip install --upgrade pip
$ .venv/bin/pip install '.[hardware]'
```

The `hardware` extra is `adafruit-circuitpython-pn532` + `Adafruit-Blinka` — the PN532 driver and the
`board`/`busio`/`digitalio` modules it needs. Stylus's own core is stdlib-only
([ADR 0016](../../docs/adrs/0016-stylus-stdlib-core-and-hardware-seams.md)), which is why there's
nothing else to install and no `pnpm` anywhere in this document. Blinka's build takes a few minutes
on a Zero 2 W — normal.

Confirm Blinka can see the board (this is the import that `create_pn532_reader` does):

```
$ .venv/bin/python -c "import board, busio; print(board.board_id)"
```

It should print something like `RASPBERRY_PI_ZERO_2_W`.

## 7. GATE 6a — does the bus see the reader?

```
$ i2cdetect -y 1
```

You want a device at **`24`** in the grid. This is the gate that separates "wiring is right" from
everything else — **do not move on from an empty grid.** An empty grid means, in order of
likelihood: the module isn't switched to I²C, SDA/SCL are swapped or in the wrong pins, VCC is on
5V or not connected, or I²C isn't enabled (step 4).

## 8. Configure

```
$ cp config.example.toml config.toml
$ nano config.toml
```

Set the downstream URLs to your **Pi 5's** hostname and the shared secret to the same value the
other services use — Stylus posts to each directly, it does not go through Curator:

```toml
[downstream.conductor]
url = "http://marquee-pi5.local:4737/api/scan"
shared_secret = "the-same-secret-everything-else-uses"

[downstream.backdrop]
url = "http://marquee-pi5.local:4740/api/scan"
shared_secret = "the-same-secret-everything-else-uses"

[downstream.amp]                                    # audio — omit only if you haven't deployed Amp
url = "http://marquee-pi5.local:4741/api/scan"
shared_secret = "the-same-secret-everything-else-uses"
```

> **All three, or you get a stand that looks finished and is silent.** Lights and video come from
> Conductor and Backdrop; audio for a `curator:card:` scan comes from Amp ([ADR 0034](../../docs/adrs/0034-amp-sonos-playback-and-card-uri.md)),
> and Amp only ever hears about a scan because this file names it. Nothing downstream complains
> about the omission — Amp sits healthy and idle, `/status` shows `downstreamHealth` all `true` for
> the two that _are_ configured, and every card scan lights the room in silence.
>
> Amp's port really is **4741**, the same number as Stylus's own status server below. Different
> machines, no clash.

Leave `[reader]` debounce at defaults for now — step 11 is where you tune them. Keep
`[led].gpio_pin = 17` unless you wired the LED elsewhere; set `[led].enabled = false` if you didn't
wire one. Save with **Ctrl+O, Enter, Ctrl+X**.

> `config.toml` is gitignored — the secret never gets committed. Only `config.example.toml` is in git.

## 9. GATE 6b — prove the fan-out **before** trusting the antenna

Run Stylus with the **fake** reader and inject a read by hand. This isolates "my URLs and secret are
right" from "the PN532 works" — two failures you very much want to meet one at a time.
`POST /simulate` is rejected with `409` under the real reader, so the `--simulate` flag is required:

```
$ .venv/bin/python -m stylus --simulate --config config.toml
```

Leave it running. In a **second** SSH session, with `URI` set to a real album that reached at least
`awaiting_review` in Curator:

```
$ URI='curator:album:<curatorId>'
$ curl -XPOST localhost:4741/simulate -d "{\"uid\":\"04:A1:B2\",\"uri\":\"$URI\"}"
$ curl localhost:4741/status
$ curl -XPOST localhost:4741/simulate -d '{"clear":true}'
```

**GATE 6b:** the same lights-and-video start/stop you saw in GATE 5, now driven through Stylus's
publish path — and `/status` shows `downstreamHealth` all `true`. A `false` there is a URL, secret,
or reachability problem, not an NFC problem. Ctrl+C when it passes.

## 10. Install the service

The unit file ships in this directory:

```
$ sudo cp ~/Marquee/packages/stylus/marquee-stylus.service /etc/systemd/system/
$ sudo systemctl daemon-reload
$ sudo systemctl enable --now marquee-stylus
$ systemctl status marquee-stylus      # "active (running)"; press q to exit
```

It runs the **real** reader (no `--simulate`), so `/simulate` now returns `409` by design. Watch it
work:

```
$ journalctl -u marquee-stylus -f      # Ctrl+C to stop watching
```

If you used a username other than `pi`, edit `User=`, `Group=`, `WorkingDirectory=` and the two
paths in `ExecStart=` first.

## 11. GATE 7 — the milestone

Write `curator:album:<curatorId>` to an **NTAG213** (runbook A7 covers phone / Flipper / Curator's
generated `.nfc`), stick it on the sleeve, and hold it to the reader.

- `journalctl -u marquee-stylus -f` should show the UID, the parsed URI, and a `start`
- Lights + video become the record; lift it and both fade back after ~2s

**Then tune the mount.** Find where on the stand the sleeve reads reliably, and check the two
debounce failure modes:

| It feels wrong because…                                          | Turn this knob                                            |
| ---------------------------------------------------------------- | --------------------------------------------------------- |
| A sleeve carried _past_ the stand triggers a scan ("ghost read") | `insertion_debounce_polls` 2 → 4 (800ms)                  |
| A settled sleeve flickers start/stop at the edge of range        | `removal_debounce_polls` up from 10                       |
| Lifting a sleeve takes too long to fade out                      | `removal_debounce_polls` down from 10                     |
| A tag **on** the reader is unseen, but works held ~1cm off       | `[rf] gsn_on` / `cw_gsp` **down** — overcoupling, see §12 |

Edit `config.toml`, then `sudo systemctl restart marquee-stylus`. Get the geometry right before you
reach for the debounce numbers — range beats tuning.

**But closer is not automatically better.** Past some coupling the tag detunes the reader's resonant
circuit and swamps its receiver: the reader transmits fine, can't hear the reply, and reports an
empty field. So the failure curve has a wall at _both_ ends, and the near one is the surprising one —
the chip's factory transmit drive overcoupled the built stand so badly it read 0/6 at every distance,
contact included ([#303](https://github.com/dylanleatham/Marquee/issues/303) /
[ADR 0075](../../docs/adrs/0075-stylus-drives-the-pn532-below-its-default-power.md)). If tags fail
when close in, lower `[rf] gsn_on` / `cw_gsp`; if they fail only far away, raise them.

That's issue #52 done.

## 12. Troubleshooting

| Symptom                                                                                                                  | Likely cause / fix                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `i2cdetect -y 1` grid is **empty**                                                                                       | In order: module not switched to I²C (silkscreen), SDA/SCL swapped or off pins 3/5, VCC not on **3.3V pin 1**, I²C not enabled (step 4). Nothing downstream can work until `24` appears.                                                                                                                                                                                                                                                                                                                        |
| `i2cdetect` shows `24`, but Stylus logs `No module named 'board'`                                                        | The hardware extra didn't install, or systemd is running the system Python. Confirm `ExecStart` points at `.venv/bin/python` and re-run `.venv/bin/pip install '.[hardware]'`.                                                                                                                                                                                                                                                                                                                                  |
| `pip install` fails `externally-managed-environment`                                                                     | You're outside the venv. Use `.venv/bin/pip`, not `pip` / `sudo pip` (step 6).                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `pip install '.[hardware]'` fails building `RPi.GPIO` / `rpi_ws281x`: `fatal error: Python.h: No such file or directory` | Missing Python headers. `sudo apt install -y python3-dev build-essential`, then re-run — the downloads are cached, so it's quick. Pi OS Lite ships a compiler but not the headers, and these two Blinka dependencies have no aarch64 wheels.                                                                                                                                                                                                                                                                    |
| Service dies instantly, `journalctl` shows a Permission error on `/dev/i2c-1`                                            | The user isn't in the `i2c` group. `sudo usermod -aG i2c,gpio pi`, then **reboot** — group changes don't apply to an existing login.                                                                                                                                                                                                                                                                                                                                                                            |
| Tag reads (UID in the logs) but nothing happens downstream                                                               | `curl localhost:4741/status` answers this directly. `observed` is what the reader sees right now: `null` = nothing on the stand (range/mount); `observed.uri: null` = a tag is there but its NDEF won't decode; a non-null `observed.uri` that never reaches `lastUri` = it decoded but isn't a `curator:` URI — re-read it with a phone/Flipper and compare to the album's `curatorId`. `lastBadTag` keeps the last refusal after you lift the sleeve. If the URI is right, check `downstreamHealth`.          |
| Lights/video react seconds late, but the stand itself feels responsive                                                   | A publish backlog. `curl localhost:4741/status` → `publishQueue`: a climbing `depth` means the worker is stuck in the §8 retry window for a downstream that isn't answering, and a non-zero `dropped` means the backlog hit its bound and the stalest events were discarded ([#173](https://github.com/dylanleatham/Marquee/issues/173)). Fix the downstream — check `downstreamHealth` for which one. The reader staying responsive while this happens is the intended behaviour, not a symptom.               |
| `journalctl` shows `publish backlog full … dropped the oldest`                                                           | A downstream has been unreachable long enough to queue 64 events. Expected under a real outage; the newest events are kept because §8 requires downstreams to time out their own state. If you see it with everything _up_, something is wedging the publish worker — capture `/status` and file it.                                                                                                                                                                                                            |
| Any scan → **401** in the logs                                                                                           | `X-Trigger-Secret` mismatch. The secret in `config.toml` must equal Conductor's `[auth].shared_secret` **and** Backdrop's — all four services share one value.                                                                                                                                                                                                                                                                                                                                                  |
| `/simulate` returns **409**                                                                                              | Working as intended: you're running the real reader. It only works under `python -m stylus --simulate` (step 9).                                                                                                                                                                                                                                                                                                                                                                                                |
| Sleeve does nothing, but GATE 5 and 6b both passed                                                                       | Isolated to the antenna or the mount. Check `/status` `observed` first: `null` with a tag physically on the reader means the chip sees nothing, so this is coupling, not decoding. Try the tag **held ~1cm off** the reader before moving it closer — if that works and contact doesn't, it's overcoupling (next row). Otherwise geometry, then `insertion_debounce_polls`. Confirm the tag is readable at all by reading it with your phone.                                                                   |
| A tag **on** the reader is never seen, but the same tag works held ~1cm away                                             | **Overcoupling** ([#303](https://github.com/dylanleatham/Marquee/issues/303)). The tag detunes the reader's resonant circuit and swamps its receiver. Lower the transmit drive: `[rf] gsn_on` / `cw_gsp` in `config.toml`, restart, re-test at contact. Do **not** trust the PN532 antenna self-test here — Diagnose `0x07` measures the antenna with no tag in the field and passes cleanly through this fault, as do `i2cdetect`, the firmware read, and the communication-line test.                         |
| Works, then stops after hours; `journalctl` shows repeated read failures                                                 | stylus-spec §12 "PN532 hangs" — the module locked up. The unit's `Restart=always` recovers it; if it recurs often, shorten the poll rate or check the module's power.                                                                                                                                                                                                                                                                                                                                           |
| `journalctl` shows `PN532 init did not complete within 10s` and a restart loop                                           | Working as intended ([#307](https://github.com/dylanleatham/Marquee/issues/307)): the module wedged during bring-up and Stylus exited so `Restart=always` could retry. If it loops, the module is not coming back on its own — **power-cycle it** (pull 3.3V, not just a service restart; the chip keeps its state). A module that needs more than 10s to init is the rarer cause: raise `[reader] init_timeout_ms`.                                                                                            |
| `journalctl` shows `Watchdog timeout` / `watchdog: ... terminating` and a restart                                        | Working as intended ([#308](https://github.com/dylanleatham/Marquee/issues/308)): the poll loop stopped proving it was alive, so systemd killed it and `Restart=always` brought it back. Almost always a wedged PN532 mid-poll — power-cycle the module if it recurs. If it recurs _only while a downstream is down_, that's a false positive: check `WatchdogSec` against the rule in the row below.                                                                                                           |
| Watchdog kills happen whenever Conductor/Backdrop/Amp is down                                                            | A `WatchdogSec` too tight for the §8 retry window. Stylus pings at `WatchdogSec/2` and beats once per publish attempt, so the longest gap is one downstream `timeout_ms` plus the longest retry delay (2s) — and `WatchdogSec` must be more than **twice** that. Shipped: 5s + 2s = 7s vs `WatchdogSec=30`. If you raised a `timeout_ms` past ~12s, raise `WatchdogSec` to match.                                                                                                                               |
| Unit stuck in `activating`, then killed after ~90s                                                                       | `Type=notify` with code that never sends `READY=1` — i.e. a **new unit file against an old checkout**. Copy both together (§13); `git pull` alone isn't enough when the unit changed.                                                                                                                                                                                                                                                                                                                           |
| Service is `active (running)` but the log is silent and no tag ever reads                                                | Since #307 and #308 both landed, this should no longer be reachable — an init hang exits, and a poll-loop hang trips the watchdog. If you see it anyway, the watchdog isn't armed: check `systemctl show marquee-stylus -p Type -p WatchdogUSec` (expect `notify` and `30000000`). A stale unit file is the usual cause — `sudo systemctl daemon-reload` after re-copying. If the journal has no `bringing up the PN532` line at all, the service never reached the reader; look further up for a config error. |
| Nothing after a reboot until you SSH in                                                                                  | Wi-Fi came up after Stylus. The unit has `Wants=network-online.target`, but confirm `systemctl is-enabled systemd-networkd-wait-online` (or NetworkManager's equivalent) is on.                                                                                                                                                                                                                                                                                                                                 |
| The LED never lights                                                                                                     | It's optional and Stylus degrades to logging when GPIO isn't available — `journalctl` will say `LED disabled: …`. Check the 330Ω resistor and that the **long** leg goes to GPIO 17 (pin 11). `[led].enabled = false` silences it entirely.                                                                                                                                                                                                                                                                     |

## 13. Updating Stylus later

```
$ cd ~/Marquee && git pull
$ cd packages/stylus && .venv/bin/pip install '.[hardware]'
$ sudo systemctl restart marquee-stylus
$ cd / && ~/Marquee/packages/stylus/.venv/bin/python \
    -c "import stylus.state_machine as m,inspect;print(inspect.getfile(m))"   # verify — see below
```

If `marquee-stylus.service` itself changed, re-copy it and `sudo systemctl daemon-reload` first.

> ⚠️ **Since [#308](https://github.com/dylanleatham/Marquee/issues/308) the unit and the code are a
> matched pair.** The unit is `Type=notify`, which means systemd waits for a `READY=1` that only the
> new code sends. A **new unit against an old checkout** hangs in `activating` and gets killed at
> `TimeoutStartSec` (~90s) — so if you update the unit, update the venv in the same pass. The
> reverse (old unit, new code) is harmless: the notification simply goes nowhere.

### The middle line is not optional — skipping it looks like it worked ([#201](https://github.com/dylanleatham/Marquee/issues/201))

Stylus is installed into the venv **non-editable**, so
`.venv/lib/python3.13/site-packages/stylus/` holds a full _copy_ of the package. **`git pull` does
not change that copy.**

Pulling and restarting nevertheless appears to work, because the unit runs:

```ini
WorkingDirectory=/home/pi/Marquee/packages/stylus
ExecStart=/home/pi/Marquee/packages/stylus/.venv/bin/python -m stylus --config …/config.toml
```

`python -m` puts the working directory at `sys.path[0]`, so the repo tree shadows site-packages and
the service imports the code you just pulled. That is a **coincidence of this unit's configuration,
not a guarantee** — anything that runs Stylus from a different directory silently gets the stale
copy. No error, no log line.

That is what the verify line above is for. Run from `/`, so nothing shadows:

```
$ cd / && ~/Marquee/packages/stylus/.venv/bin/python \
    -c "import stylus.state_machine as m,inspect;print(inspect.getfile(m))"
```

- `…/site-packages/stylus/state_machine.py` → the install is what runs. Good, **provided you ran the
  `pip install`**.
- `…/packages/stylus/stylus/state_machine.py` → you are seeing the repo tree only because of cwd
  shadowing; the install is stale.

**Real example (2026-08-01).** Deploying the [#198](https://github.com/dylanleatham/Marquee/issues/198)
fix found the two trees four days apart — the repo at `<`, and the installed copy still at `!=` and
still missing the [#176](https://github.com/dylanleatham/Marquee/issues/176) `UriCache` fix. The
stand was one `cd` away from running a build that predated two shipped fixes.

**Fast path when only Python source changed** (no new dependencies — the common case for a bug fix):

```
$ .venv/bin/pip install --no-deps .
```

This replaces just the `stylus` package and skips `[hardware]` entirely, so nothing rebuilds native
wheels. On a Pi Zero that is seconds instead of minutes, which removes the incentive to skip the
step at all.
