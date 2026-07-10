# Parts List

_Consolidated shopping list to build the physical setup for Marquee. Total: ~$180–260 depending on choices, plus stickers._

## 1. Essential — you cannot build the setup without these

### Stylus (goes in the album stand)

| Item                            | Notes                                                              | Est. Cost   | Where                             |
| ------------------------------- | ------------------------------------------------------------------ | ----------- | --------------------------------- |
| Raspberry Pi Zero 2 W           | With soldered headers if you're not soldering yourself             | $15–20      | Adafruit, PiShop.us, Micro Center |
| PN532 NFC module (I2C-capable)  | Elechouse v3 or the "PN532 NFC HAT" both work                      | $8–15       | Amazon, Adafruit                  |
| 16GB microSD card (Class 10)    | For Pi OS. Nothing fancy — this Pi isn't doing much I/O.           | $5–8        | Anywhere                          |
| Micro-USB power supply (5V 2A)  | Any decent one; official Pi supply is fine but overkill for a Zero | $8–10       | Anywhere                          |
| Jumper wires, female-female, 4× | Or a small solder job. 20cm is a good length.                      | $2          | Amazon                            |
| **Subtotal**                    |                                                                    | **~$40–55** |                                   |

### Backdrop / Video Player (goes near your display)

| Item                                   | Notes                                                                                                 | Est. Cost             | Where                          |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------- | --------------------- | ------------------------------ |
| Raspberry Pi 5 (4GB)                   | 4GB is plenty for this workload. Get 8GB if you'll run Topology B (also hosting Curator + Conductor). | $60 (4GB) / $80 (8GB) | Adafruit, PiShop, Micro Center |
| Pi 5 official power supply (27W USB-C) | Don't skimp here — Pi 5 is picky about power.                                                         | $12                   | Same                           |
| Active cooling case (with fan)         | Argon NEO 5, Flirc Pi 5, or the official case + fan                                                   | $10–20                | Same                           |
| Micro HDMI to HDMI cable               | Pi 5 uses micro-HDMI on both output ports                                                             | $5                    | Anywhere                       |
| High-endurance microSD, 128GB, A2      | SanDisk High Endurance or Samsung PRO Endurance                                                       | $20–25                | Amazon                         |
| **Subtotal**                           |                                                                                                       | **~$107–142**         |                                |

### NFC stickers

| Item                         | Notes                                                                                                                                                                 | Est. Cost   | Where            |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | ---------------- |
| NTAG213 stickers, 25mm round | 100-pack. Enough for your current collection with room to grow. Get white-face if you might want to write on them, or clear if you want them invisible on the sleeve. | $10–15      | Amazon, GoToTags |
| **Subtotal**                 |                                                                                                                                                                       | **~$10–15** |                  |

### Essentials total: **~$155–210**

---

## 2. Recommended additions

### For debugging and setup convenience

| Item                                     | Notes                                                                                                                | Est. Cost |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | --------- |
| USB-C to Ethernet adapter                | Wire the Pis in during initial setup; move to WiFi once configured. Saves you from wireless-config-over-serial pain. | $15       |
| USB keyboard + micro-HDMI adapter        | For initial Pi setup when SSH isn't up yet. Or just use headless setup via Pi Imager (skip this).                    | $0–20     |
| Status LED + 330Ω resistor + heat shrink | For the Stylus's LED indicator per the spec. Total pennies from any kit you probably already have.                   | $1        |

### For future-proofing / feels-nice

| Item                     | Notes                                                                                                                                        | Est. Cost                   |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| Bump to Pi 5 8GB         | If you want Topology B (Pi 5 hosts Curator + Conductor + Backdrop as sibling processes). Otherwise 4GB is fine.                              | +$20                        |
| Bump microSD to 256GB    | If your visualizer collection will grow past ~100–150 albums. 500 albums fits comfortably in 128GB, but headroom is cheap.                   | +$10                        |
| 3D-printed enclosures    | For the Pi Zero + PN532 inside the stand, and a nice case for the Pi 5. Search Printables/Thingiverse for "PN532" and "Raspberry Pi 5 case." | $0 if you print it yourself |
| Second Pi Zero 2 W setup | If you'll have a second stand (office, kitchen) — everything doubles for a second Stylus.                                                    | +$40–55                     |

---

## 3. Things you probably already have

- Turntable and Hue lights (givens)
- Hue Bridge (given, on your LAN)
- Home WiFi with decent LAN speed
- A display / TV where Backdrop will output — HDMI input required
- A phone for NFC tag writing (NFC Tools on Android/iOS, free)
- **Your dev workstation** (Windows/Mac/Linux). Curator runs here — no dedicated server needed.

---

## 4. Total for a working setup

Essentials only, using your existing workstation for Curator: **~$155–210**.

That's the whole picture. Curator runs on your workstation; the runtime lives on the Pis in the essentials list.

---

## 5. Order of purchase (don't buy it all at once)

You don't need every piece to start. Suggested phased ordering:

**Phase 1 — Software-only work (weeks of dev possible with just this):**

- Nothing new to buy. You already have the Hue bridge, lights, phone, and an existing dev machine. Build Palette Press library, Curator, and Conductor stub against a mock or real bridge.

**Phase 2 — First real light change:**

- Just Conductor pointing at your existing Hue bridge. Zero new hardware. You want this working before ordering Pis; if the concept doesn't feel right, you learn cheap.

**Phase 3 — Add the display layer:**

- Order: Pi 5 kit (Pi + PSU + case + cable + microSD).
- Skip NFC hardware for now. Test Backdrop end-to-end with `POST /api/scan` triggered manually via `curl`.

**Phase 4 — Add the physical trigger:**

- Order: Pi Zero 2 W + PN532 module + microSD + PSU + jumpers + NFC stickers.
- This is where it stops being software and starts being a project you can show off.

Splitting the order like this means you spend ~$100 in Phase 3 and see it working before committing another ~$60 in Phase 4. If either phase makes you re-think the approach, no sunk cost.

---

## 6. Vendor notes

- **Adafruit** — most expensive but every product has excellent documentation and known-good tutorials. Great for the PN532 specifically, since their CircuitPython library is the standard.
- **Micro Center** — if you have one near you, Pi 5 is often in stock and priced fairly. In-person purchase avoids shipping wait.
- **PiShop.us** — consistent stock, reasonable prices, ships fast.
- **Amazon** — fastest shipping, quality varies. Fine for microSD, cables, and NFC stickers. Riskier for the PN532 (counterfeits exist) — pay a few dollars more for a known brand.
- **AliExpress** — cheapest by far on PN532 modules and NTAG stickers, but 2–4 week shipping. Worth it if you're buying 500+ stickers and don't need them next week.

## 7. Consumables

NTAG213 stickers get "used" per physical object — one per sleeve, and one per card if you're making cards for that album. So the count depends on how many cards you plan to produce:

- Sleeve tags only: ~1 sticker per album, 100 stickers ≈ 100 albums tagged, $10–15
- Sleeves + cards for every album: ~2 stickers per album, so 200 stickers for 100 albums, $20–30
- Order a 200-pack if your collection is over ~100 records or you'll be making cards regularly
- Keep 20% headroom for mistakes and future acquisitions
