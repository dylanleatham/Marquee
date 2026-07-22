# Runbook — hardware bring-up (first "place record → room reacts")

The step-by-step for taking the built software chain onto real hardware (runtime-overview §10 step 11,
issue #52). Everything below has been proven in software against fakes; this is validating it against a
real Hue bridge, real NFC, and a real display. Work top-to-bottom — each step has a check before you
move on, so when something breaks you know which layer it's in.

**Topology** (runtime-overview §7): Curator on your **workstation**; Conductor + Backdrop on the **Pi 5**
by the TV; Stylus on the **Pi Zero 2 W** in the stand. Hue bridge, both Pis, and the workstation must be
on the **same LAN**.

**Default ports**: Conductor `4737`, Curator `4739`, Backdrop `4740`.

**Before you start, pick one shared secret** and use it everywhere (`X-Trigger-Secret`): Curator's
outbound config, Conductor's `[auth].shared_secret`, Backdrop's auth, Stylus's outbound header. This is
LAN "prevent accidents" auth (runtime-overview §8), not real security — but every hop must match or you'll
get 401s.

---

## 0. Deploy the services

- Build each service (`pnpm --filter <pkg> build`) and get it onto its host, or run from source with Node 22.
- Put a `config.toml` next to each package (or use env vars). The keys you need are called out per step below.

## 1. Conductor + Hue bridge (the lights half)

1. **Config** (`packages/hue-conductor/config.toml`):
   ```toml
   [auth]
   shared_secret = "<your-lan-secret>"
   [storage]
   data_dir = "data"                     # bridge cred + settings live here
   album_assets_dir = "/home/pi/marquee/album-assets"   # the rsync target, issue #45
   [runtime]
   idle_timeout_minutes = 90             # safety net for a lost stop
   ```
2. **Start** Conductor, then **pair the bridge**: run the pairing script (`packages/hue-conductor/src/pair.ts`),
   **press the bridge's link button** when prompted. It discovers the bridge, waits for the press, and
   saves the application key to the data dir.
   - Check: `GET /healthz` → `{ ok: true, paired: true }`.
   - Check: `GET /api/rooms` (with the secret header) lists your Hue rooms.
3. **Set the listening room**: `PUT /api/settings { "listeningRoomId": "<roomId from /api/rooms>" }`
   (or set it from Curator's Demo Room). Scans have no room in them — they drive this one.
4. **Smoke the lights alone** (no album needed): `POST /api/test/color { "roomId": "<id>", "hex": "#4B0082" }`
   → that room turns purple. Proves the bridge path end-to-end.

## 2. Backdrop (the video half)

1. **Config**: shared secret + its media dir (where visualizer `.mp4`s live on the Pi).
2. **Start** Backdrop; bring up the kiosk Chromium pointed at it.
   - Check: `GET /healthz` shows it up with the browser connected.

## 3. Curator (workstation) + sync

1. **Config** (`packages/curator/config.toml`): the shared secret, and the downstream URLs:
   ```toml
   [conductor]
   url = "http://<pi5-ip>:4737"
   shared_secret = "<your-lan-secret>"
   [backdrop]
   url = "http://<pi5-ip>:4740"
   shared_secret = "<your-lan-secret>"
   media_dir = "<Backdrop's media dir ON THE PI>"   # roots the library projection's filePath
   ```
2. **Prep one album** so both halves have something to show:
   - Add an album (Spotify / Discogs / manual) and let Roadie reach at least **`awaiting_review`** —
     Conductor needs a **palette + pattern** (present from `awaiting_review` on), or a scan degrades to
     `202 ignored: album not ready` (issue #45).
   - Attach or **splice** a visualizer video (issue #29) so **Backdrop** has a file to play.
3. **Sync to the Pi**:
   - **Asset store → Conductor**: rsync `~/marquee/album-assets/` to the Pi's `album_assets_dir`
     (step 1's path). Conductor reads its synced copy at scan time.
   - **Library → Backdrop**: `POST /api/backdrop/sync` on Curator pushes the URI→file projection to
     Backdrop; the video files themselves go out-of-band (rsync to Backdrop's media dir).
   - Check: `POST /api/backdrop/verify-sync` reports no drift.

## 4. Smoke test the full chain — *without* the stand

Before you walk to the stand, prove the software resolves the album's URI. Fire a scan by hand at **both**
services (this is what Stylus will do). Use the album's `curatorId` (from Curator):

```sh
SECRET=<your-lan-secret>; URI=curator:album:<curatorId>
# start
curl -s -XPOST http://<pi5-ip>:4737/api/scan -H "X-Trigger-Secret: $SECRET" \
  -H 'content-type: application/json' -d "{\"event\":\"start\",\"uri\":\"$URI\",\"tagUid\":\"test\",\"at\":\"$(date -Iseconds)\"}"
curl -s -XPOST http://<pi5-ip>:4740/api/scan -H "X-Trigger-Secret: $SECRET" \
  -H 'content-type: application/json' -d "{\"event\":\"start\",\"uri\":\"$URI\",\"tagUid\":\"test\",\"at\":\"$(date -Iseconds)\"}"
```

- **Lights should change and the video should play.**
- **Confirm Conductor actually acted** (issue #54): `GET http://<pi5-ip>:4737/api/playback/current` →
  should list the album (`source.name`, `pattern`, `startedAt`). If `current` is **empty**, Conductor
  didn't apply it — read its `action`/`reason` from the scan response (`ignored: album not synced` →
  step 3 rsync; `ignored: album not ready` → step 2 palette; `ignored: no listening room` → step 1.3).
- **Stop**: repeat the calls with `{"event":"stop","at":"…"}` → both fade back to idle; `current` empties,
  and `/api/playback/history` shows the playback with a `stoppedAt`.

Getting a clean start/stop here isolates "the software chain works" from "the NFC/mount is tuned" — so the
only unknown left at the stand is the tag read.

## 5. Tag the sleeve

1. In **NFC Tools** on your phone, write the text/URI record `curator:album:<curatorId>` to an NTAG213 sticker.
2. Stick it on the sleeve; mark it written in Curator (bookkeeping — issue #55 finishes this flow in-app).

## 6. Stylus + the real scan

1. Deploy Stylus to the Pi Zero 2 W with the **real PN532 driver** wired in at the hardware seam (it's a
   bench build against a fake today — ADR 0016). Point its outbound at Conductor + Backdrop with the shared secret.
2. Mount it in the stand; tune the antenna position so a placed sleeve reads and a lifted one clears within
   ~2s (debounce ~400ms on read, ~2s on removal — stylus-spec §12).
3. **The moment**: place the tagged sleeve → lights + video become the record. Lift it → both fade back.

---

## Debug matrix

| Symptom | Look at | Likely cause |
| --- | --- | --- |
| `/api/test/color` does nothing | Conductor logs; `GET /api/bridge/status` | Not paired / bridge unreachable — re-run pairing (step 1.2) |
| Scan 401 | the `X-Trigger-Secret` on every hop | Secret mismatch between Stylus/Curator and Conductor/Backdrop |
| Scan `202 ignored: no listening room` | `GET /api/settings` | Listening room not set (step 1.3) |
| Scan `202 ignored: album not synced` | Pi's `album_assets_dir` | rsync didn't land the `{curatorId}.json` (step 3) |
| Scan `202 ignored: album not ready` | Curator: the album's Roadie state | No palette/pattern yet — advance it to `awaiting_review` (step 2) |
| Lights work, no video | Backdrop logs; `POST /api/backdrop/verify-sync` | Library not synced / video file not on Backdrop's SD (step 3) |
| `current` empty but scan returned `playing` | Conductor logs | Bridge call failed mid-apply (409 not paired / 502) — check the bridge |
| Sleeve on stand does nothing, but step 4 curl worked | Stylus logs; LED | NFC read/mount tuning, or Stylus can't reach the Pi 5 |
| Effect stays after lifting the sleeve | — | Missed `stop`; the 90-min idle timeout is the backstop, or `POST /api/scan {event:stop}` manually |

See runtime-overview §9 for the full failure-mode table. When you hit one, `GET /api/playback/current` +
`/history` on Conductor and the scan response's `action`/`reason` are your fastest signal for which layer
is at fault.
