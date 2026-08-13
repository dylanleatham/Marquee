# Stylus — Technical Spec

_The physical device inside the album stand that reads the tagged sleeve and publishes scan events. Named after the needle that reads a record — same metaphor, same job._

## 1. Purpose

A small physical device mounted in the album stand that continuously polls for NFC tags on record sleeves. When it detects a tagged sleeve, it reads the Curator album URI written on the NTAG213 sticker (of the form `curator:<kind>:<curatorId>`, where kind is `album`, `card` or `demo` — Stylus forwards any of them unchanged and acts on none) and publishes a `start` event to the runtime services (Conductor for lights, Backdrop for video). When the sleeve is removed, it publishes `stop`.

This is the moment where the physical world meets the software system. Everything else you've spec'd is preparation for this thirty-line loop.

## 2. Success criteria

**Place a tagged sleeve on the stand → lights change within 500ms, video starts within 1 second. Remove the sleeve → lights and video return to idle within 2 seconds. Swap to a different tagged sleeve → transition to the new album's assets within 1 second.**

That's the whole test. If it passes, the physical concept works and everything downstream is refinement.

## 3. Scope

### In scope

- Continuous tag polling via PN532
- NDEF parsing to extract Spotify URI
- Debounced state machine: idle → playing → idle, with swap handling
- HTTP publishing to Conductor and Player endpoints
- Local status LED for visual feedback
- Config file for endpoints and tuning
- Runs as a systemd service on boot

### Out of scope

- Tag writing (phone handles that, per Curator spec)
- Anything beyond Spotify URI in the NDEF payload
- Multiple stands / multiple readers
- Local asset lookup (the trigger service is a dumb reader; downstream services own asset lookup)
- Physical stand design (that's your workshop's problem, not this spec's)

## 4. Hardware BOM

| Item                                    | Purpose                     | Cost     |
| --------------------------------------- | --------------------------- | -------- |
| Raspberry Pi Zero 2 W                   | Main compute, WiFi built in | ~$15     |
| PN532 NFC module (I2C mode)             | The reader                  | ~$8-15   |
| 16GB microSD                            | Pi OS                       | ~$5      |
| USB-C or micro-USB power supply (5V 2A) | Power                       | ~$8      |
| 4x jumper wires (or short solder job)   | PN532 → Pi                  | ~$1      |
| Small LED + 330Ω resistor               | Status indicator            | ~$1      |
| Enclosure or 3D-printed mount           | Physical integration        | varies   |
| **Total**                               |                             | **~$40** |

**PN532 module selection:** Get one with a switchable interface (I2C / SPI / UART) via DIP switches or solder pads. Set it to **I2C mode**. Adafruit's PN532 Breakout is the gold-standard, but the generic Elechouse or "PN532 NFC HAT" modules on Amazon work fine and are half the price.

**Wiring** (I2C):

| PN532 pin | Pi Zero 2 W pin      |
| --------- | -------------------- |
| VCC       | 3.3V (pin 1)         |
| GND       | GND (pin 6)          |
| SDA       | GPIO 2 / SDA (pin 3) |
| SCL       | GPIO 3 / SCL (pin 5) |

Enable I2C on the Pi: `sudo raspi-config` → Interfacing Options → I2C → Enable.

Status LED to GPIO 17 (pin 11) via a 330Ω resistor to ground. GPIO drives HIGH = LED on. Blink patterns per §7.

**Why Pi Zero 2 W instead of ESP32:**
Better debugging story than a bare microcontroller. Full Linux, SSH, logs, easy library management, room to grow. If you eventually want to shrink to a tiny appliance form factor, migrating a Python HTTP-publishing loop to ESP32 firmware is a weekend, not a rebuild.

**Why PN532 instead of MFRC522:**
PN532 has better NTAG213 support out of the box, has larger read range (4cm vs 2-3cm), and the CircuitPython library is well maintained. Slightly more expensive; worth it.

## 5. Where it fits

```
              ┌─────────────────────────────────┐
              │       album stand (physical)    │
              │                                 │
              │   ┌───────┐                     │
              │   │ sleeve│  NTAG213 sticker    │
              │   │  ▼    │  (Spotify URI)      │
              │   ├───────┤                     │
              │   │ PN532 │◄─── ~2cm read gap   │
              │   ├───────┤                     │
              │   │ Pi 0  │                     │
              │   └───┬───┘                     │
              └──────┼──────────────────────────┘
                     │ WiFi
                     │
              ┌──────┴───────┐  HTTP POST     ┌────────────────────┐
              │ Stylus  │───────────────>│  Hue Conductor     │
              │  (Python)    │                └────────────────────┘
              │              │  HTTP POST     ┌────────────────────┐
              │              │───────────────>│  Video Player      │
              └──────────────┘                │  (reads video from │
                                              │   own SD card)     │
                                              └────────────────────┘
```

**Note on the SD card commitment:** Videos live on the Player's local SD card. The Trigger Service doesn't know about videos, files, or storage — it just publishes URIs. Player looks up the URI in its own local asset store (a synced copy of what Curator produces), finds the corresponding file on its SD card, and plays it. Clean separation, minimal coupling, and the Trigger Service stays under 300 lines of Python.

## 6. Software stack

> **Implementation note (2026-07-21, build step 10, [ADR 0016](../adrs/0016-stylus-stdlib-core-and-hardware-seams.md)):**
> the shipped core is **stdlib-only** — HTTP over `urllib` (not `httpx`; injectable transport) and a
> tiny hand-rolled NDEF URI parser (not `ndeflib`) — so it runs and tests off-hardware with no
> third-party deps. `adafruit-circuitpython-pn532` and the GPIO driver stay behind injectable seams
> (`SimulatedReader` vs the Pi reader; logging LED vs GPIO), imported lazily only on the Pi.

- **Language**: Python 3.11+.
- **NFC library**: `adafruit-circuitpython-pn532`. Best-maintained NTAG213 support in the Python ecosystem.
- **NDEF parsing**: `ndeflib` — small pure-Python NDEF message parser.
- **HTTP client**: `httpx` (async) or `requests` (sync). Sync is fine for this workload — you'll do at most a handful of requests per minute.
- **Config**: `tomllib` (stdlib in 3.11+).
- **Process management**: systemd service, defined in a `.service` file, enabled on boot.
- **Logging**: stdlib `logging` → journal. Follow-up: forward to your existing logs later if you want.

**Why Python, when everything else is Node.js:** The PN532 library ecosystem in Python is a decade ahead of Node's. The Trigger Service is small enough (~300 lines) that language choice here has zero impact on the rest of the stack. Keep this component in Python and don't feel bad about it.

## 7. Detection state machine

Central loop runs at 5 Hz (poll every 200ms). State transitions:

```
      ┌─────────┐
      │  IDLE   │  LED: slow breathe (2s cycle)
      └────┬────┘
           │  tag UID detected (2 consecutive polls, ~400ms)
           │  → read NDEF → parse Spotify URI
           │  → POST start to Conductor + Player
           ▼
      ┌─────────┐
      │ PLAYING │  LED: solid on
      └────┬────┘
           │
           ├─── same tag UID keeps appearing → stay
           │
           ├─── different tag UID detected → SWAP:
           │      POST stop (fire-and-forget)
           │      POST start with new URI
           │      (no need to hit IDLE in between)
           │
           └─── no tag for 10 consecutive polls (~2s)
                → POST stop → back to IDLE
```

**Debounce parameters** (tunable in config):

| Parameter                  | Default | Purpose                                     |
| -------------------------- | ------- | ------------------------------------------- |
| `poll_interval_ms`         | 200     | How often to poll                           |
| `insertion_debounce_polls` | 2       | Positive reads needed before firing `start` |
| `removal_debounce_polls`   | 10      | Missed reads needed before firing `stop`    |
| `swap_debounce_polls`      | 1       | Different UID reads before treating as swap |

Rationale: fast enough that placing a sleeve feels instant, slow enough that a hand hovering over the reader doesn't jitter the state.

`[reader]` carries one knob that isn't a debounce: `init_timeout_ms` (default 10000) bounds the one-time PN532 bring-up so a wedged module becomes a restart instead of a silent `active (running)` — see §12 "PN532 hangs".

> **These are thresholds, not exact counts** ([#198](https://github.com/dylanleatham/Marquee/issues/198)).
> "Reads needed before firing" means **at or past** the threshold: the machine keeps evaluating a
> stable tag on every subsequent poll, not only on the poll where the streak equals the number.
>
> The code read `!=` rather than `<` until 2026-08-01, so the URI was inspected on exactly one poll.
> Because the reader re-reads NDEF on every poll of an undecoded tag (misses are deliberately not
> cached, [#176](https://github.com/dylanleatham/Marquee/issues/176)), a decode that failed while the
> sleeve was still settling left it latched off until physically lifted — on the stand, "this record
> just doesn't work". Firing once is guaranteed by the `PLAYING` transition and `_flagged_bad`, not
> by the comparison.

> **The decoded-URI cache lives for one placement** (2026-08-02). The reader caches successful
> decodes per UID so a settled sleeve costs one NDEF read rather than one every 200ms; that cache is
> **cleared whenever the field goes empty**, so lifting the sleeve guarantees the next placement
> re-reads the tag.
>
> Writing NDEF to a tag does not change its UID. Until this date the cache was cleared only by
> eviction at 8 entries or a service restart, so **re-writing a sticker left Stylus serving the
> previous album indefinitely** — the Flipper showed the new URI, `/status` showed the old one, and
> re-placing the sleeve did not help. This is the same UID-stability trap as
> [#176](https://github.com/dylanleatham/Marquee/issues/176) (which fixed it for cached _misses_),
> seen from the hit side. A dropped read on a motionless sleeve also clears the cache and costs one
> re-read — cheap, and invisible to playback behind the removal debounce.
>
> Residual, by design: a tag re-written **without leaving the field** is not noticed, because §7
> `PLAYING` treats a matching UID as "same sleeve, no change" and never re-inspects the URI.

**LED patterns:**

- Slow breathe (2s cycle): IDLE, waiting
- Solid on: PLAYING
- Fast blink (100ms): error posting to downstream (visible signal something is wrong on the network)
- Two short blinks then off: a `start` was **read and accepted** (nice touch, gives you a visual "I heard you"). Until 2026-08-13 this meant "successfully published"; publishing is asynchronous since [#173](https://github.com/dylanleatham/Marquee/issues/173), so the delivery result isn't known when the sleeve lands. Waiting for it would put the blink seconds after the gesture — delivery failures still show up, as the fast-blink error pattern.

> **Implementation note (2026-07-28, build step 11):** patterns are frames of
> `(brightness, duration)` played on a background thread (`stylus/led.py`); the frame tables are pure
> and unit-tested, only the driver touches GPIO. Two deliberate deviations: the IDLE breathe is a
> **20-step ramp**, not a continuous fade (indistinguishable at arm's length, and it keeps the player
> a simple frame list); and where Blinka can't give us PWM the driver **falls back to on/off**, which
> degrades breathe to a slow blink rather than failing. The start-ack is modelled as a _one-shot_ —
> it plays to completion before the steady pattern resumes, because the app sets START_ACK and
> PLAYING within the same tick and the ack would otherwise never be visible.

## 8. HTTP behavior

### Outbound events

To Conductor (`http://<pi5>:4737/api/scan`):

```json
{
  "event": "start",
  "uri": "curator:album:2k7bxq9m",
  "tagUid": "04:A1:B2:C3:D4:E5:F6",
  "readerId": "primary",
  "at": "2026-07-06T20:15:22Z"
}
```

To Backdrop (`http://<pi5>:4740/api/scan` — same host as Conductor, see §9):
Same payload shape. Backdrop and Conductor both get identical events; they're not synchronized, just fan-out. (Renamed from "Player" — Backdrop is the committed name, runtime-overview §12. The config key `[downstream.player]` is still accepted as a legacy alias; [ADR 0016](../adrs/0016-stylus-stdlib-core-and-hardware-seams.md).)

To Amp (`http://<pi5>:4741/api/scan` — same host again, see §9): same payload once more, and the third leg of the fan-out ([ADR 0034](../adrs/0034-amp-sonos-playback-and-card-uri.md)). Stylus does not gate on the URI kind; it forwards `album`, `card` and `demo` alike and Amp decides — `card` streams the album over Sonos, `demo` streams the album's one chosen track ([ADR 0058](../adrs/0058-a-demo-tag-plays-one-chosen-track.md)), and `album` answers `202 ignored` because you're playing the vinyl.

Also fires:

```json
{ "event": "stop", "readerId": "primary", "at": "2026-07-06T20:47:03Z" }
```

Note: `stop` doesn't carry a `uri` — downstream services should treat it as "return to idle" regardless of what they were doing. Simpler than tracking session correlation.

**On `readerId`**: single-value string that identifies which physical stand fired the event. Defaults to `"primary"` for a single-reader install. Included from day one because adding a second stand later (office, kitchen) is a config change rather than a schema change and downstream event-payload migration. Downstream services can ignore it for now.

### Retry policy

Fire-and-forget with a short retry window:

- 1st try: immediate
- 2nd try: 500ms later
- 3rd try: 2s later
- After that: log warning, give up

Rationale: a scan event that arrives 30 seconds late is worse than no event at all — the record is halfway through and the lights suddenly change. Better to log and move on. Downstream services should be idempotent enough that a missed `stop` isn't catastrophic (they can time out their own state after some idle threshold).

> **Per-downstream timeouts (2026-07-29, measured during step-11 bring-up).** The retry window above
> only makes sense if a single attempt is given long enough to succeed. Conductor's `/api/scan`
> resolves the album **and drives the Hue bridge** before replying — **~2.9s measured** on a Pi Zero
> 2 W over Wi-Fi. The original `timeout_ms = 1000` default therefore failed _every_ scan, and worse,
> spent all three retries doing it: Conductor received and applied the same `start` three times while
> Stylus reported `downstreamHealth: false` for a request that had actually worked. Defaults are now
> **3000ms** (`config.py`), with `config.example.toml` suggesting **5000** for Conductor and **2000**
> for Backdrop, which only accepts and signals the kiosk.
>
> Two consequences worth naming rather than burying. §2's "lights change within 500ms" is **not met
> by the current Conductor** — the bridge round-trip dominates, and that's a Conductor latency
> question, not a Stylus one. And because `Publisher.publish` is synchronous inside the poll loop, a
> slow or dead downstream stalls tag polling for the whole retry window; raising timeouts widens that
> stall. Tracked as a follow-up, not fixed here.
>
> **Resolved 2026-08-13 ([#173](https://github.com/dylanleatham/Marquee/issues/173), [ADR 0082](../adrs/0082-publishing-moves-off-the-poll-loop.md)):** the stall is gone. `Publisher.publish` is unchanged and still sequential, but it is now called by a worker thread draining a bounded FIFO, so the poll loop hands an event over and goes straight back to reading. Worst-case blindness drops from ~87s to one poll interval, and raising a `timeout_ms` no longer widens anything the reader can feel. What it costs: `downstreamHealth` is now the result of the last **completed** publish rather than of the event just fired, and events can be dropped under sustained outage — both visible on `GET /status`.

### Inbound status (optional)

Small local HTTP server on port 4741:

- `GET /status` → two views, deliberately separate:

  | Field                                      | View        | Meaning                                                                                                                                                                                                   |
  | ------------------------------------------ | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | `state`, `lastUid`, `lastUri`, `lastEvent` | the machine | What is **playing**. Null until a scan actually fired.                                                                                                                                                    |
  | `observed: { uid, uri, at } \| null`       | the reader  | What is **on the stand right now**, decoded or not. `uri` is null when the NDEF wouldn't read; the whole object is null when the reader sees nothing.                                                     |
  | `lastBadTag: { uid, uri, at } \| null`     | the reader  | The last tag the machine refused, **kept after the sleeve is lifted**.                                                                                                                                    |
  | `downstreamHealth`                         | publishing  | Per-downstream result of the last **completed** publish — not necessarily of `lastEvent`, since [#173](https://github.com/dylanleatham/Marquee/issues/173) made publishing asynchronous.                  |
  | `publishQueue: { depth, dropped } \| null` | publishing  | Backlog of the publish worker. A climbing `depth` or non-zero `dropped` is a downstream being unreachable. Null only if the publisher has no queue — the service always wires one, `--simulate` included. |
  | `rf: { gsnOn, cwGsp }`                     | the chip    | The PN532 transmit drive in force (§10, [ADR 0075](../adrs/0075-stylus-drives-the-pn532-below-its-default-power.md)). Volatile settings, so this is a different question from what `config.toml` says.    |

  > **Why both.** Until 2026-08-01 only the machine's view existed, so a sleeve sitting on the reader
  > being rejected — an unwritten tag, a garbled NDEF, a URI for another scheme — made `/status`
  > identical to an empty stand. That is precisely the case the endpoint is for, and it cost a real
  > debugging session during the [#198](https://github.com/dylanleatham/Marquee/issues/198) bring-up:
  > the only window into a failing sleeve was `journalctl` on the stand Pi.
  >
  > So: `observed == null` means nothing is on the reader. `observed.uri == null` means a tag is
  > there and its NDEF won't decode. A non-null `observed.uri` that never becomes `lastUri` means the
  > tag decoded but carried something the machine won't act on.

- `GET /healthz` → 200 if the PN532 is responding
- `POST /simulate` → dev-only endpoint to inject fake tag events without physical hardware. Very useful during Player/Conductor testing.

## 9. Configuration

`~/stylus/config.toml`:

```toml
[reader]
id = "primary"                       # identifies this stand in event payloads
poll_interval_ms = 200
insertion_debounce_polls = 2
removal_debounce_polls = 10
swap_debounce_polls = 1
init_timeout_ms = 10000              # bound on the one-time PN532 bring-up — see §12

# Conductor and Backdrop both run on the Pi 5 — same host, different ports. Prefer its IP over a
# `.local` name: mDNS resolves inconsistently across clients.
[downstream.conductor]
url = "http://192.168.1.50:4737/api/scan"
timeout_ms = 5000                    # drives the Hue bridge before replying — see §8
shared_secret = "..."

[downstream.backdrop]                # "player" is still accepted as a legacy alias (ADR 0016)
url = "http://192.168.1.50:4740/api/scan"
timeout_ms = 2000                    # only accepts and signals the kiosk, so it answers fast
shared_secret = "..."

[downstream.amp]                     # audio for a `curator:card:`/`curator:demo:` scan (ADR 0034/0058)
url = "http://192.168.1.50:4741/api/scan"
timeout_ms = 5000                    # resolves the album and drives Sonos over UPnP before replying
shared_secret = "..."

# PN532 transmit drive — NOT the chip's power-on values. See §10 and ADR 0075: the chip default
# overcouples and reads nothing at all. Lower = weaker field = shorter maximum range.
[rf]
gsn_on = 0x84
cw_gsp = 0x18

[status]
listen_port = 4741

[led]
gpio_pin = 17
enabled = true
```

Shared secret is sent as `X-Trigger-Secret` header; downstream services reject requests without it. Prevents the (unlikely) case of someone on your LAN spamming your Conductor with fake scans.

## 10. Physical placement notes

Not a stand design, but the constraints your stand design needs to accommodate:

- **Read range**: ~4cm max, ~2cm reliably — **at a transmit drive that has been tuned for the mount**. Measured on the built stand (2026-08-12, [ADR 0075](../adrs/0075-stylus-drives-the-pn532-below-its-default-power.md)), the range at the chip's _default_ drive is **zero at every distance**, contact included. The sticker and the antenna must come within range in the sleeve's normal resting position, and the drive must be set — see the next bullet.
- **Transmit drive is a tuning parameter, and too much of it is a failure mode.** Above some coupling, a tag detunes the reader's resonant circuit and swamps its receiver: the reader transmits fine and cannot hear the reply, so it reports an empty field. Symptom: a tag lying **on** the reader is invisible while one held further away works. Fix: lower `[rf] gsn_on` / `cw_gsp` in `config.toml`. Stylus defaults to `0x84`/`0x18`, which read 6/6 from contact to 3cm on the built stand, versus 0/6 everywhere for the chip's `0xF4`/`0x3F`. `GET /status` reports the drive in force.
- **A passing PN532 antenna self-test does not mean the reader can read.** Diagnose `0x07` measures antenna current with **no tag in the field**, so it is blind to coupling faults — as are the I²C probe, the firmware read, and the communication-line test. The check that distinguishes them is `observed` on `GET /status` with a tag physically on the reader: `null` means the chip sees nothing at all.
- **Antenna orientation**: PN532's antenna is a flat coil. Read range is maximized when the sticker's coil is parallel to the antenna's coil. Sticker facing the reader flat-on = best; sticker perpendicular = worst.
- **Metal is the enemy**: don't put metal between the antenna and the sticker. Metal shelving, metal brackets, aluminum stand parts near the antenna will kill range. Wood, plastic, cardboard are transparent to 13.56 MHz NFC — fine.
- **Sticker placement on sleeves**: pick one spot and stick to it (literally). Back cover, upper-right corner is a common convention. Consistency matters more than exact location — your stand's reader can be positioned once and works for the whole collection.
- **Heat**: The Pi Zero 2 W runs cool at this workload but check if your enclosure has ventilation. A little airflow is enough.

If you find range is insufficient with a chosen stand geometry, PN532 modules with external antennas exist and can be repositioned inside the stand independently of the Pi. Adafruit sells one specifically for embedded projects.

## 11. Development milestones

> **Status (2026-07-21, build step 10):** the **bench** milestones are done — #3 (state machine),
> #4 (HTTP publisher against a stub), and #8 (LED + status/`simulate` endpoints) — all with unit +
> property tests and a live `--simulate` end-to-end run. #1/#2 (real PN532 read + NDEF off a real
> tag), #6 (mount), #7 (systemd) are **deferred to step 11** (hardware), behind injectable seams.
> #5/#9 (real Conductor/Backdrop): Backdrop's `/api/scan` works today; Conductor's scan handler is a
> filed follow-up (it currently only takes a pre-built palette on `/api/playback`, ADR 0007).
>
> **Update (2026-07-28, build step 11):** the deferred hardware pieces are now **written** —
> `create_pn532_reader` (#1/#2), the GPIO LED driver (§7 patterns), and `marquee-stylus.service`
> (#7), installed via a new `hardware` pip extra. #5/#9 are unblocked: Conductor's scan handler
> landed ([ADR 0019](../adrs/0019-conductor-scan-reads-asset-store.md)). **#6 (mount + range tuning)
> is the only milestone left**, and it is bench-untestable by construction. Deploy procedure and the
> debounce knobs: [`packages/stylus/DEPLOY.md`](../../packages/stylus/DEPLOY.md).
>
> **Update (2026-08-12, [#303](https://github.com/dylanleatham/Marquee/issues/303)):** #6 bit, in
> the direction nobody watches for — **too much** RF power, not too little. In the built mount the
> chip's default transmit drive overcoupled and the stand read nothing at all, at any distance
> (§10, [ADR 0075](../adrs/0075-stylus-drives-the-pn532-below-its-default-power.md)). Drive is now
> configured on every boot and exposed as `[rf]` in `config.toml`, so #6 is a config edit rather
> than a code change — but it is still the open milestone: the values that work are the ones
> measured on _your_ mount.

1. **Basic PN532 read.** Wire it up, get the CircuitPython example to print tag UIDs when you tap a random NTAG. Success: any tag prints its UID.
2. **NDEF read.** Write a Spotify URI to a test NTAG using your phone. Success: your script reads the URI back out.
3. **State machine + logging.** Implement the loop from §7. No HTTP yet. Success: watching the logs, you see "start" and "stop" transitions correctly across insert/remove/swap.
4. **HTTP publisher against a stub.** Wire outbound calls, point at a stub server (`python -m http.server` with a simple echo, or `webhook.site`). Success: scanning a tag shows up as an HTTP request in the stub.
5. **Real endpoints.** Swap stubs for Conductor. Success: place a tagged sleeve → room changes color.
6. **Physical mount.** Put the Pi + PN532 into a first-pass mount inside your stand. Test range with actual sleeves. Iterate on positioning until reliable.
7. **systemd service + auto-start.** Boots into working state on power-up.
8. **LED + status endpoint.** Visual feedback + `/status` for debugging.
9. **Player integration.** Once Player exists (next spec), add its endpoint to config, verify video kicks in on scan.

## 12. Known gotchas

- **Pi Zero 2 W WiFi flakiness on boot.** The Pi occasionally comes up before WiFi is ready. systemd unit should `Wants=network-online.target` and `After=network-online.target`. Add a small retry in Python for the first few POSTs after boot.
- **PN532 hangs.** Some modules occasionally lock up under heavy polling and require a reset. Wrap the read loop in a try/except that on repeated failures, toggles a GPIO tied to the PN532's reset pin (or just power-cycles by exiting the process — systemd will restart it).

  > **Update (2026-08-12, [#307](https://github.com/dylanleatham/Marquee/issues/307), [ADR 0076](../adrs/0076-a-hung-pn532-init-becomes-a-restart.md)):** the bullet above assumes the lock-up surfaces as a _failure_ the read loop can catch. It doesn't always. A wedged module can block **inside** a driver call and never return, and a blocked process is not a dead one — `Restart=always` recovers a process that exits, so it never fires. The service stays `active (running)` with a silent journal, reading nothing, indefinitely.
  >
  > The **one-time init** is now bounded: `busio.I2C`, `PN532_I2C`, `SAM_configuration` and `configure_tx_drive` run together on a daemon thread with a join timeout (`[reader] init_timeout_ms`, default 10s). Past the bound Stylus logs the reason at CRITICAL and calls `os._exit(1)`, converting the hang into exactly the exit `Restart=always` already knows how to recover. The hung thread is never killed — it's blocked in a C-level I²C ioctl where the interpreter never regains control — so the process leaves without it.
  >
  > ~~**A hang in the poll loop is still uncovered**~~ — **closed 2026-08-13** ([#308](https://github.com/dylanleatham/Marquee/issues/308), [ADR 0077](../adrs/0077-the-poll-loop-proves-it-is-alive.md)). A one-shot bound is the wrong shape for a loop; what a loop can offer is a signal that keeps arriving. The unit is now `Type=notify` with `WatchdogSec=30`, Stylus sends `READY=1` once the reader is up and the status port is listening, and `WATCHDOG=1` every `WatchdogSec/2`. A loop blocked in a driver call stops pinging, systemd kills it, and `Restart=always` recovers it — the same conversion #307 does for init, applied to the loop.
  >
  > **The hard part is the false positive, not the false negative.** `publish` runs _inside_ the poll tick and legitimately blocks for tens of seconds when a downstream is down (§8's retry window, [#173](https://github.com/dylanleatham/Marquee/issues/173) — a full outage costs ~43s per publish, ~87s on a swap). A heartbeat sent once per tick would read a **Conductor** outage as a Stylus hang and kill Stylus for it, which fixes nothing. So #308 threaded the heartbeat into the publisher's retry loop as well. [#173](https://github.com/dylanleatham/Marquee/issues/173) then removed the stall entirely by moving publishing onto a worker thread, which both retired that workaround and **inverted** the hazard: a heartbeat on the worker would now let a healthy publisher vouch for a wedged reader. The poll loop is therefore the only heartbeat source, `Publisher` no longer accepts one at all, and the gap `WatchdogSec` must clear is one poll interval rather than a downstream timeout.

- **I2C address collisions.** PN532 defaults to `0x24`. If you add another I2C device later, check its address doesn't clash.
- **Ghost reads.** A sleeve moved past the reader on its way to the turntable might trigger a scan you didn't intend. The insertion debounce (400ms) helps but doesn't fully solve it. If it's annoying in practice, extend `insertion_debounce_polls` to 4 (800ms). Trade-off is slight lag on real scans.
- **The runtime services need to be tolerant of `start` without a paired `stop`.** WiFi drops, the Pi reboots, the reader misses the removal event — many ways to leave downstream services in a "playing" state with no matching stop. Both Conductor and Player should have their own idle timeout (e.g. "if no new event in 90 minutes, return to idle").
- **Same-URI re-scan.** Someone lifts and re-places the same sleeve. Current spec fires stop→start. Might feel jarring for the lights and video. Consider a "if same URI comes back within 5 seconds, treat as no-op" rule. Or don't — it's honest behavior, and only fires when you actually lift the sleeve.
- **Re-writing a sticker you're testing with.** A tag keeps its UID when you write new NDEF to it, so anything Stylus remembers per UID is a candidate for going stale under you. Both directions have bitten this project: cached misses ([#176](https://github.com/dylanleatham/Marquee/issues/176)) and cached hits (§7, 2026-08-02). If a re-written sleeve reports the wrong album, check `observed.uri` on `/status` against what your writer shows — if they disagree, the tag is fine and something upstream of the state machine is stale.
- **Multiple sleeves stacked.** PN532 will read whichever tag is closest and strongest. Behavior is deterministic but non-obvious. Design assumption: one sleeve at a time on the stand.
