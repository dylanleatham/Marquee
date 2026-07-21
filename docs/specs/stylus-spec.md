# Stylus — Technical Spec

_The physical device inside the album stand that reads the tagged sleeve and publishes scan events. Named after the needle that reads a record — same metaphor, same job._

## 1. Purpose

A small physical device mounted in the album stand that continuously polls for NFC tags on record sleeves. When it detects a tagged sleeve, it reads the Curator album URI written on the NTAG213 sticker (of the form `curator:album:<curatorId>`) and publishes a `start` event to the runtime services (Conductor for lights, Backdrop for video). When the sleeve is removed, it publishes `stop`.

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

**LED patterns:**

- Slow breathe (2s cycle): IDLE, waiting
- Solid on: PLAYING
- Fast blink (100ms): error posting to downstream (visible signal something is wrong on the network)
- Two short blinks then off: successful `start` published (nice touch, gives you a visual "I heard you")

## 8. HTTP behavior

### Outbound events

To Conductor (`http://conductor.local:4737/api/scan`):

```json
{
  "event": "start",
  "uri": "curator:album:2k7bxq9m",
  "tagUid": "04:A1:B2:C3:D4:E5:F6",
  "readerId": "primary",
  "at": "2026-07-06T20:15:22Z"
}
```

To Backdrop (`http://backdrop.local:4740/api/scan`):
Same payload shape. Backdrop and Conductor both get identical events; they're not synchronized, just fan-out. (Renamed from "Player" — Backdrop is the committed name, runtime-overview §12. The config key `[downstream.player]` is still accepted as a legacy alias; [ADR 0016](../adrs/0016-stylus-stdlib-core-and-hardware-seams.md).)

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

### Inbound status (optional)

Small local HTTP server on port 4741:

- `GET /status` → current state, last UID, last URI, last event timestamp, downstream health
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

[downstream.conductor]
url = "http://conductor.local:4737/api/scan"
timeout_ms = 1000
shared_secret = "..."

[downstream.backdrop]                # "player" is still accepted as a legacy alias (ADR 0016)
url = "http://backdrop.local:4740/api/scan"
timeout_ms = 1000
shared_secret = "..."

[status]
listen_port = 4741

[led]
gpio_pin = 17
enabled = true
```

Shared secret is sent as `X-Trigger-Secret` header; downstream services reject requests without it. Prevents the (unlikely) case of someone on your LAN spamming your Conductor with fake scans.

## 10. Physical placement notes

Not a stand design, but the constraints your stand design needs to accommodate:

- **Read range**: ~4cm max, ~2cm reliably. The sticker on the sleeve and the antenna in the stand must come within that range in the sleeve's normal resting position.
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
- **I2C address collisions.** PN532 defaults to `0x24`. If you add another I2C device later, check its address doesn't clash.
- **Ghost reads.** A sleeve moved past the reader on its way to the turntable might trigger a scan you didn't intend. The insertion debounce (400ms) helps but doesn't fully solve it. If it's annoying in practice, extend `insertion_debounce_polls` to 4 (800ms). Trade-off is slight lag on real scans.
- **The runtime services need to be tolerant of `start` without a paired `stop`.** WiFi drops, the Pi reboots, the reader misses the removal event — many ways to leave downstream services in a "playing" state with no matching stop. Both Conductor and Player should have their own idle timeout (e.g. "if no new event in 90 minutes, return to idle").
- **Same-URI re-scan.** Someone lifts and re-places the same sleeve. Current spec fires stop→start. Might feel jarring for the lights and video. Consider a "if same URI comes back within 5 seconds, treat as no-op" rule. Or don't — it's honest behavior, and only fires when you actually lift the sleeve.
- **Multiple sleeves stacked.** PN532 will read whichever tag is closest and strongest. Behavior is deterministic but non-obvious. Design assumption: one sleeve at a time on the stand.
