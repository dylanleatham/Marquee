# Bring-up checklist — first "place record → room reacts"

The tick-along companion to [`runbook.md` Part A](runbook.md#part-a--set-up--install). This is the
milestone in runtime-overview §10 **step 11** ([issue #52](https://github.com/dylanleatham/Marquee/issues/52)):
go from bare Pis to a tagged sleeve driving the lights + video.

**How to use it:** work top-to-bottom. Every phase ends with a **GATE** — a check that must pass before
you move on. If a gate fails, **stop there**; the fix is in that phase or in the linked debug-matrix
row, not further down. The point of gating is that a failure tells you _which layer_ broke while you
still have only one suspect.

Fill in the box below **first** — these are the values you'd otherwise retype (and mistype) at every
step. Keep this file open on your phone/laptop while you work.

---

## The values (fill in once)

| Thing                              | Value                        | Set in                                        |
| ---------------------------------- | ---------------------------- | --------------------------------------------- |
| Shared secret (`X-Trigger-Secret`) | `________________`           | Conductor `[auth]`, Backdrop, Curator, Stylus |
| Pi 5 hostname                      | `marquee-pi5` (or `____`)    | —                                             |
| Pi Zero 2 W hostname               | `marquee-pizero` (or `____`) | —                                             |
| Hue bridge on LAN?                 | ☐ confirmed same subnet      | —                                             |
| Listening room id                  | `________________`           | `PUT /api/settings` (A2.4)                    |
| Test album `curatorId`             | `________________`           | Curator album detail                          |
| → `URI=curator:album:<id>`         | `________________`           | used in every smoke test                      |

Two shell exports make the smoke tests copy-paste (run on the Pi 5 or workstation):

```sh
export SECRET='<your-lan-secret>'
export URI='curator:album:<curatorId>'
export PI5=marquee-pi5
```

---

## Phase 0 — LAN & secret

- [ ] Hue bridge, Pi 5, Pi Zero, and workstation are all on **one LAN/subnet**
- [ ] Picked **one** shared secret; it's written in the box above and will go in **all four** configs
- [ ] Can `ssh` into both Pis by hostname

**GATE 0:** `ping marquee-pi5` and `ping marquee-pizero` both resolve and reply.

---

## Phase 1 — Pi 5 base image · runbook A1

- [ ] Raspberry Pi OS (64-bit) flashed; hostname/SSH/Wi-Fi pre-set in Imager
- [ ] Node 22 + pnpm + git + chromium installed
- [ ] Repo cloned to `/home/pi/Marquee`; `pnpm install` clean
- [ ] `pnpm --filter @marquee/hue-conductor build` and `… @marquee/backdrop build` both succeed

**GATE 1:** `node /home/pi/Marquee/packages/hue-conductor/dist/server.js` starts and logs a port
(then `Ctrl-C` — systemd runs it for real below).

---

## Phase 2 — Conductor / the lights · runbook A2

- [ ] `config.toml` written: `[auth].shared_secret`, `[storage].album_assets_dir`,
      `[runtime].idle_timeout_minutes = 90`
- [ ] Paired the bridge: `pnpm --filter @marquee/hue-conductor pair` → **pressed the link button**
- [ ] `marquee-conductor.service` installed + `systemctl enable --now`
- [ ] Listening room set: `GET /api/rooms` → `PUT /api/settings {"listeningRoomId":"<id>"}` (record id above)

**GATE 2a:** `curl -s http://$PI5:4737/healthz` → `{"ok":true,"paired":true}`.

**GATE 2b (proves the bridge path):**

```sh
curl -s -XPOST http://$PI5:4737/api/test/color -H "X-Trigger-Secret: $SECRET" \
  -H 'content-type: application/json' -d '{"roomId":"<listening-room-id>","hex":"#4B0082"}'
```

→ the room turns **purple**. If not → debug matrix: _"`/api/test/color` does nothing"_.

---

## Phase 3 — Backdrop / the video · runbook A3

- [ ] Config: shared secret + media dir (`/home/pi/marquee-data/media/visualizers`)
- [ ] `marquee-backdrop.service` up (`systemctl enable --now`)
- [ ] Kiosk unit `marquee-kiosk.service` launches Chromium fullscreen on the TV

**GATE 3:** `curl -s http://$PI5:4740/api/status` shows it **up with a browser connected**, and the TV
shows Backdrop's idle gradient. (The video-plays check comes after A4's sync, in the Phase 5 smoke test.)

---

## Phase 4 — Curator + sync · runbook A4

- [ ] Curator `config.toml`: `[conductor]` + `[backdrop]` urls, shared secret, Backdrop `media_dir` (the path **on the Pi**)
- [ ] One album prepared to **at least `awaiting_review`** (has palette + pattern) — else scans give `202 album not ready`
- [ ] A visualizer video attached/spliced to that album — else lights work but no video
- [ ] Curator's `CONDUCTOR_URL` (or `[conductor] url`) set **explicitly** — the localhost default
      leaves the album-assets push off (ADR 0045)
- [ ] Amp's `album_assets_dir` **equals Conductor's** — the default is a different directory that
      nothing writes, so card scans would never resolve an album
- [ ] `POST /api/runtime/sync` — pushes the asset store to Conductor, the projection to Backdrop, and
      (with `media_transfer = "push"`) the videos. Returns a job; poll `GET /api/jobs/:id`
- [ ] Videos on the Pi: covered by the above with `media_transfer = "push"` (ADR 0038); otherwise
      `rsync` videos → Pi's media dir

**GATE 4:** `POST http://<workstation-curator>/api/runtime/verify` reports **no drift** —
`conductor.missing` and `backdrop.discrepancies` both empty.

---

## Phase 5 — Smoke-test the chain _before the stand_ · runbook A5

This is the most important gate: it separates **"the software chain works"** from **"the NFC/mount is
tuned."** No NFC involved yet.

```sh
# Lights — the exact raw scan Stylus will send:
curl -s -XPOST http://$PI5:4737/api/scan -H "X-Trigger-Secret: $SECRET" \
  -H 'content-type: application/json' \
  -d "{\"event\":\"start\",\"uri\":\"$URI\",\"tagUid\":\"test\",\"at\":\"$(date -Iseconds)\"}"
# Video — Backdrop's simulate helper:
curl -s -XPOST http://$PI5:4740/api/admin/simulate-scan -H "X-Trigger-Secret: $SECRET" \
  -H 'content-type: application/json' -d "{\"uri\":\"$URI\"}"
```

- [ ] **Lights change** on the listening room
- [ ] **Video plays** on the TV
- [ ] Conductor confirms it acted: `GET http://$PI5:4737/api/playback/current` **lists the album**
      (`source.name`, `pattern`, `startedAt`). Empty? → read the scan response's `action`/`reason`, then the debug matrix.
- [ ] **Stop** clears it: `POST /api/scan {"event":"stop","at":"…"}` + `POST /api/admin/stop` →
      both fade to idle; `current` empties; `history` shows the playback with a `stoppedAt`

**GATE 5:** a clean start **and** stop through the curl path. Do **not** wire NFC until this passes —
everything past here is antenna/mount, and you want the software ruled out first.

---

## Phase 6 — Stylus on the Pi Zero · runbook A6

**Power off the Pi Zero before wiring.** PN532 must be in **I²C mode** (DIP/jumper per the board's silkscreen).

Full command-by-command version: [`packages/stylus/DEPLOY.md`](../packages/stylus/DEPLOY.md).

- [ ] 4 wires: VCC→**3.3V pin 1** (not 5V!), GND→pin 6, SDA→**GPIO2 pin 3**, SCL→**GPIO3 pin 5**
- [ ] (optional) LED: anode → 330Ω → **GPIO17 pin 11**; cathode → GND
- [ ] I²C enabled (`raspi-config` → Interface → I2C → reboot); user in the `i2c`/`gpio` groups
- [ ] Build prerequisites present: `python3-venv python3-dev build-essential` — Blinka's C extensions
      compile from source, and without the headers the install dies on `Python.h: No such file`
- [ ] Stylus installed in a **venv** with the **hardware extra**: `.venv/bin/pip install '.[hardware]'`
      (`adafruit-circuitpython-pn532`, `Adafruit-Blinka`) — Bookworm refuses a plain `pip install`
- [ ] Config: Conductor + Backdrop URLs + shared secret; `[led].gpio_pin = 17`
- [ ] `marquee-stylus.service` installed from `packages/stylus/` + `systemctl enable --now`

**GATE 6a (bus sees the reader):** `i2cdetect -y 1` shows a device at **0x24**. Empty grid → re-check the
4 wires and the I²C DIP/jumper _before_ anything else.

**GATE 6b (Stylus fan-out wiring — proves config/URLs/secret, _not_ the PN532):** run Stylus with the
**fake** reader — `python -m stylus --simulate` — because `/simulate` is disabled under the real reader
(it returns `409` otherwise). Then inject a read:

```sh
curl -XPOST http://marquee-pizero:4741/simulate -d "{\"uid\":\"04:A1:B2\",\"uri\":\"$URI\"}"
curl -XPOST http://marquee-pizero:4741/simulate -d '{"clear":true}'   # = sleeve lifted
```

→ same start/stop as GATE 5, now driven through Stylus's publish path. This confirms the Conductor/Backdrop
URLs + secret in Stylus's config are right. It does **not** exercise the antenna — that's GATE 7, which
needs a written tag.

Then restart Stylus with the **real** reader (`python -m stylus`, the systemd default) for Phase 7.

---

## Phase 7 — Tag the sleeve + the real scan · runbook A7

- [ ] Wrote `curator:album:<curatorId>` to an **NTAG213** (phone / Flipper / Curator `.nfc` — see A7)
- [ ] **Did NOT** touch lock/CC/password pages
- [ ] Read the tag back and confirmed the URI string matches the album
- [ ] Stuck the tag on the sleeve; mounted Stylus in the stand
- [ ] Tuned read position + debounce: a placed sleeve reads reliably; a lifted sleeve fires `stop`

**GATE 7 — the milestone:** place the tagged sleeve on the stand → **lights + video become the record**;
lift it → **both fade back**. That's issue #52 done.

If the sleeve does nothing but GATE 5/6 passed, it's isolated to NFC read/mount or Stylus→Pi5
reachability — debug matrix: _"Sleeve on stand does nothing, but A5/A6 worked."_

---

## When a gate fails

Every failure has a row in the [runbook debug matrix](runbook.md#debug-matrix). Your two fastest signals
during bring-up:

1. **The scan response's `action`/`reason`** (`202 ignored: no listening room` / `album not synced` /
   `album not ready` each point at a specific phase above).
2. **`GET /api/playback/current`** on Conductor — did it actually resolve and apply the scan?

Full failure-mode table: `docs/specs/runtime-overview.md §9`. Next step after this checklist is the
hardening pass — [**failure-drills.md**](failure-drills.md), the same tick-along format, one drill
per §9 row ([issue #53](https://github.com/dylanleatham/Marquee/issues/53)).
