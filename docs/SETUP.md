# What you need to set up (your side)

The scaffold is in place. Here's everything that requires _you_ — accounts, tools, hardware,
and decisions I can't make. Ordered so nothing blocks you before you need it.

## A. Toolchain on your workstation (needed before any code — build order steps 0–5)

| Tool                   | Why                                            | How (Windows)                                                                            |
| ---------------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------- |
| **Node.js 20 LTS**     | All four services + libraries                  | https://nodejs.org — pick 20.x. Verify `node -v` → `v20.x`.                              |
| **pnpm 9**             | Monorepo package manager                       | `npm install -g pnpm` (or `corepack enable pnpm`)                                        |
| **Git**                | Version control                                | You have it.                                                                             |
| **ffmpeg**             | Curator video validation + thumbnails (step 7) | `winget install Gyan.FFmpeg`, or from ffmpeg.org. Needed only when you reach video work. |
| **Python 3.11+**       | Stylus only (step 10)                          | https://python.org — needed only when you build the NFC reader.                          |
| **VS Code / your IDE** | —                                              | optional                                                                                 |

Then, in the repo:

```bash
pnpm install       # wires every Node package
pnpm run setup     # checks toolchain, installs git hooks, seeds .env
pnpm run test:fast # should pass the contract tests once deps install
```

## B. Accounts & credentials

1. **Spotify Developer app** — for Curator/Roadie metadata + art (build order step 4).
   - Go to https://developer.spotify.com/dashboard, create an app.
   - You mentioned a "Conflicted Lineup" app — reusing those client credentials is fine.
   - Put `SPOTIFY_CLIENT_ID` / `SPOTIFY_CLIENT_SECRET` into `.env` (already gitignored).
   - This uses the client-credentials flow (no user login) for public catalog reads.
2. **A shared LAN secret** — one random string used by all services (`X-Trigger-Secret`).
   - Generate one: `openssl rand -hex 16` (Git Bash has openssl), put in `.env` as
     `TRIGGER_SHARED_SECRET`, and later into each device's `config.toml`.
3. **GitHub repo** (dev-harness §13) — create a **private** repo, then:
   - `git remote add origin …`, push `main`.
   - Turn on **branch protection** for `main` (require PR, status checks, linear history) per
     dev-harness §7. Do this early so the discipline sticks.
   - The CI workflows (`.github/workflows/*.yml`) run automatically once pushed.

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

## D. Fixture assets you provide (for tests — build order steps 0–2)

Drop small copies of these album covers into `fixtures/artwork/` as JPGs (see
`fixtures/README.md` for the full list and why each one matters). Purple Rain, Kind of Blue,
The White Album, Metallica (Black), Rumours, Unknown Pleasures, plus one recent color-rich and
one recent minimal album. The golden palettes get generated once Palette Press runs, then you
eyeball them once and commit them as the goldens.

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

### What I (Claude) can build without you

Everything in build-order steps 0–9 that doesn't touch physical hardware: the contracts, fakes,
Palette Press (given fixture art), Curator + Roadie + its UI, Backdrop's software (testable with
Playwright + tiny fixture videos), and Conductor's software (testable against `fake-hue-bridge`).
The only things that fundamentally need you are: the **Hue bridge pairing** (physical button),
the **Spotify credentials**, the **video files** from your external tool, and all the **Pi/NFC
hardware** from step 10 on.
