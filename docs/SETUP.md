# Setting up Marquee

Everything a fresh install needs — tools, accounts, decisions, and hardware — ordered so nothing
blocks you before you need it. Most of the system runs and tests without any hardware at all (see
the end of this page).

## A. Toolchain on your workstation (needed before any code — build order steps 0–5)

| Tool                   | Why                                            | How (Windows)                                                                            |
| ---------------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------- |
| **Node.js 22 LTS**     | Every service + library                        | https://nodejs.org — pick 22.x (see `.nvmrc`). Verify `node -v` → `v22.x`.               |
| **pnpm 9**             | Monorepo package manager                       | `npm install -g pnpm` (or `corepack enable pnpm`)                                        |
| **Git**                | Version control                                | You have it.                                                                             |
| **ffmpeg**             | Curator video validation + thumbnails (step 7) | `winget install Gyan.FFmpeg`, or from ffmpeg.org. Needed only when you reach video work. |
| **Python 3.11+**       | Stylus only (step 10)                          | https://python.org — needed only when you build the NFC reader.                          |
| **VS Code / your IDE** | —                                              | optional                                                                                 |

Then, in the repo:

```bash
pnpm install       # wires every Node package
pnpm run setup     # checks toolchain, seeds .env (pnpm install set up the git hooks)
pnpm run test:fast # should pass the contract tests once deps install
```

## B. Accounts & credentials

1. **Spotify Developer app** — for Curator/Roadie metadata + art (build order step 4).
   - Go to https://developer.spotify.com/dashboard, create an app.
   - Put `SPOTIFY_CLIENT_ID` / `SPOTIFY_CLIENT_SECRET` into `.env` (already gitignored).
   - This uses the client-credentials flow (no user login) for public catalog reads.
2. **A shared LAN secret** — one random string used by all services (`X-Trigger-Secret`).
   - Generate one: `openssl rand -hex 16` (Git Bash has openssl), put in `.env` as
     `TRIGGER_SHARED_SECRET`, and later into each device's `config.toml`.
3. **Gemini and Discogs** (optional) — a Gemini API key for drafted visualizer prompts and a
   Discogs personal token for collection import. Both are entered in Curator's settings screen and
   stored outside the repo, in Curator's data directory.

## C. Decisions only you can make

1. **Video generation tool** — the specs assume an _external_ AI video tool with **no API**;
   you copy a prompt, generate a video, and drag the file back into Curator. Which tool
   (Runway, Kling, Sora, Luma, local, …) is up to you — it changes nothing in the code, only
   your workflow. Just confirm it can export **H.264 MP4, 16:9, loopable**.
2. **Card art tool** (optional) — same idea for the printed business-card art. Can be the same
   tool or a different one.
3. **Where the data lives** — Curator writes an **album-assets store** (`~/marquee/album-assets/`,
   small JSON, meant to be git-tracked in _its own_ repo) and a **media store**
   (`~/marquee/media/`, videos/art, never in git). Decide if you want the asset store under
   version control (recommended by the runtime overview) and, if so, make it a separate repo
   from this code repo.
4. **Hostnames** — the specs use `conductor.local`, `backdrop.local`. Decide whether you'll use
   mDNS (`.local`) or static IPs on your LAN. Update `.env` and the `config.toml` files to match.

## D. Fixture covers (optional)

The tests run on committed synthetic covers in `fixtures/synthetic-covers/`. To also run the golden
tests against real art, drop small JPG copies of the fixture albums into `fixtures/artwork/` —
Purple Rain, Kind of Blue, The White Album, Metallica (Black), Rumours, Unknown Pleasures (see
`fixtures/README.md`). That folder is gitignored: real covers are copyrighted and never committed
([ADR 0095](adrs/0095-real-album-covers-are-never-committed.md)).

## E. Hardware — buy in phases (don't buy it all now)

Per `docs/specs/parts-list.md`. **Phases 1–2 need zero new hardware** beyond what you own.

| Phase                      | When          | What to buy                                                                                                                                                | ~Cost           |
| -------------------------- | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| **1 — software**           | now           | nothing (you have Hue bridge, lights, phone, workstation)                                                                                                  | $0              |
| **2 — first light change** | build step 1  | nothing — Conductor talks to your existing Hue bridge                                                                                                      | $0              |
| **3 — display layer**      | build step 8  | Pi 5 (4GB) kit: PSU 27W, active-cooling case, micro-HDMI→HDMI, 128GB high-endurance A2 microSD                                                             | ~$110–140       |
| **4 — physical trigger**   | build step 10 | Pi Zero 2 W (soldered headers), PN532 NFC module (I2C), 16GB microSD, micro-USB PSU, 4× F-F jumpers, LED + 330Ω resistor, NTAG213 25mm stickers (100-pack) | ~$60 + stickers |

Notes:

- Get the **Pi 5 8GB** instead if you want to run Curator + Conductor + Backdrop all on the one
  Pi ("Topology B"). 4GB is fine for Conductor + Backdrop only.
- Buy the **PN532 from a known brand** (Adafruit/Elechouse) — Amazon counterfeits are common.
- You already have: turntable, Hue lights + **Hue Bridge on your LAN**, a TV/display with HDMI,
  a phone with **NFC Tools** (free) for writing tags.

## F. Things you'll do with your hands (later, not now)

- **Pair the Hue bridge** to Conductor (press the bridge link button when the pairing CLI asks).
- **Enable I2C** on the Stylus Pi (`raspi-config`) and wire the PN532 (4 wires, see stylus-spec §4).
- **Write NFC stickers** from your phone (Curator shows a QR with the URI) and stick them on
  sleeves in one consistent spot (e.g. back cover, upper-right).
- **Mount the Pi + PN532** in/under the album stand; tune read range (keep metal away from the antenna).

---

### What runs without hardware

The contracts, Palette Press, Curator + Roadie and its UI, Backdrop's software, and Conductor's
software all run and test without any devices: external dependencies have hand-written fakes under
`packages/fakes/` (Hue bridge, Spotify, Discogs, Gemini, the PN532 reader). What genuinely needs you is the
**Hue bridge pairing** (a physical button), your own **API credentials**, the **video files** from
your external tool, and the **Pi/NFC hardware** for the stand itself.
