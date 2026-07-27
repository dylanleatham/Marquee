# Palette Press — Technical Spec

_Presses a palette out of an album, like a record press. Library, not a service._

## 1. Purpose

A Node.js library that takes album art bytes and produces a `PalettePayload` — the palette + pattern payload defined in the integration contract. Consumed by Roadie (inside Curator) during album onboarding.

The library is pure: no I/O beyond image decoding, no network, no filesystem, no persistent state. Given the same inputs and options, always produces the same output — which is what makes downstream caching and golden-file testing trustworthy.

## 2. Success criteria

**Given Purple Rain's cover, the library returns a palette dominated by purples with a gold accent. Given Kind of Blue, a palette dominated by blues. Given a monochrome cover like The White Album, the library returns a graceful "insufficient color data" result that the caller can handle without special-casing.**

Secondary: **the same album art produces the same palette every time.** Determinism is what lets Roadie cache confidently and lets the test suite catch algorithm changes via golden files.

## 3. Scope

### In scope

- Palette extraction from album art (via node-vibrant)
- Hue-aware post-processing: gamut clamping, saturation and brightness floors, contrast filtering, role assignment
- Default pattern selection (energy-aware: static/crossfade for muted palettes, rotate/pulse for vivid ones — [ADR 0033](../adrs/0033-palette-derived-motion-energy.md))
- Emit a well-typed `PalettePayload` matching the integration contract
- Export lower-level functions (raw swatch extraction, post-processing, pattern selection) for testing and advanced use
- Graceful handling of album covers that produce insufficient color data

### Out of scope

- Album lookup or artwork fetching (caller provides bytes)
- Persistence, caching, or memoization (caller's responsibility)
- **Automatic** audio-feature fetching (Spotify's audio-features endpoint is deprecated). Pattern selection is instead driven by energy read from the palette itself; `audioFeatures` is honored only when a caller hand-authors it — see §7 and [ADR 0033](../adrs/0033-palette-derived-motion-energy.md)
- **Any signal that isn't the cover image.** Colours derived from how a record _sounds_ live in Curator, not here ([ADR 0030](../adrs/0030-palette-from-album-feeling.md) / issue #105): they come from a Gemini call, which is network I/O and non-deterministic, and this library's purity is what makes golden-file testing and downstream caching trustworthy. Curator offers such a palette as a **candidate** beside this one and validates it through the same hand-edit path; `selectDefaultPattern` then runs on whichever palette the user chose, so richer colour signals reach the room without ever reaching this package
- Track-level or per-side palette variation
- HTTP surface, UI, or hosting — this is a library

## 4. Recommended tech stack

- **Runtime**: Node.js 20 LTS, TypeScript
- **Core dependency**: `node-vibrant` (v4+) — the swatch extractor
- **Shared types**: imports `PalettePayload` and related from `@marquee/contracts`
- **Testing**: Vitest, `fast-check` for property-based tests, golden JSON files per fixture album
- **Package**: publishes as `@marquee/palette-press` inside the Marquee monorepo

No server framework. No storage. No UI. This library does one thing.

## 5. Public API

### Primary entry point

```typescript
export async function generatePalette(
  artwork: Buffer,
  metadata: AlbumMetadata,
  options?: GenerateOptions,
): Promise<PalettePayload>;
```

Takes album art bytes (JPEG or PNG), minimal album metadata (used to populate the `source` field on the returned payload), and optional overrides. Returns a fully-formed `PalettePayload` that validates against the integration contract schema.

Throws only on:

- Invalid image bytes (unreadable format)
- Missing required metadata fields

An insufficient palette is a _return value_, not an exception — the caller decides what to do with it.

### Lower-level exports

```typescript
export async function extractRawSwatches(
  artwork: Buffer,
  options?: ExtractOptions,
): Promise<RawSwatches>;

export function postProcessPalette(
  swatches: RawSwatches,
  options?: PostProcessOptions,
  populations?: SwatchPopulations, // added 2026-07-11 — enables dominant-first ordering (§6)
): PaletteResult;

export function selectDefaultPattern(
  palette: Pick<PaletteResult, "colors"> & { insufficient?: boolean },
  opts?: { audioFeatures?: AudioFeatures }, // optional override (§7)
): Pattern;

// Exported too: the palette-energy read that drives selection (§7).
export function paletteEnergy(colors: ReadonlyArray<{ hex: string }>): number;
```

These exist because the testing strategy emphasizes unit tests of pure logic. Exposing each step lets tests exercise it in isolation with fixture inputs and golden outputs, rather than only end-to-end through `generatePalette`.

> **Implementation notes (2026-07-11):**
>
> - `postProcessPalette` takes an optional third `populations` argument (per-swatch pixel
>   counts) used for dominant-first ordering (§6). Omit it and behavior is unchanged. An
>   internal `extractSwatches` returns swatches **and** populations; the documented
>   `extractRawSwatches` still returns RGB-only `RawSwatches`.
> - `generatePalette`'s returned `PalettePayload.palette` carries the insufficient signal as
>   **additive** fields — `insufficient?: true` and `reason?` — when the palette is
>   insufficient. The integration contract ignores unknown fields, so the payload still
>   validates; Roadie reads `palette.insufficient` to set its `palette_insufficient` flag.

### Types

```typescript
type AlbumMetadata = {
  curatorId: string;
  name?: string;
  artist?: string;
  year?: number;
  spotifyUri?: string;
};

type GenerateOptions = ExtractOptions & PostProcessOptions;

type ExtractOptions = {
  maxColorCount?: number; // default 64
  quality?: number; // 1..5, default 3
};

type PostProcessOptions = {
  minSaturation?: number; // 0..1, default 0.15
  saturationBoost?: number; // 0..1, default 0.4 (what to boost to if below floor)
  minBrightness?: number; // 0..1, default 0.25
  minDeltaE?: number; // default 15
  maxColors?: number; // default 4
};

type RawSwatches = {
  vibrant?: RGB;
  lightVibrant?: RGB;
  darkVibrant?: RGB;
  muted?: RGB;
  lightMuted?: RGB;
  darkMuted?: RGB;
};

type RGB = [number, number, number]; // 0..255 each

type PaletteResult = Palette | InsufficientPaletteResult;

type Palette = {
  colors: PaletteColor[]; // 2..maxColors
  insufficient: false;
};

type PaletteColor = {
  hex: string; // "#RRGGBB", uppercase
  cie_xy: [number, number]; // precomputed for Conductor's benefit
  role: "primary" | "secondary" | "accent";
  sourceSwatch: string; // e.g. "DarkVibrant" — debug info
};

type InsufficientPaletteResult = {
  colors: PaletteColor[]; // 0..1 items; whatever survived
  insufficient: true;
  reason: "monochrome" | "all_clamped" | "unusable_art";
};

type Pattern =
  | { type: "static"; params: {} }
  | { type: "crossfade"; params: { transitionMs: number; holdMs: number } }
  | {
      type: "rotate";
      params: { intervalMs: number; direction: "forward" | "reverse" };
    }
  | {
      type: "pulse";
      params: {
        periodMs: number;
        minBrightness: number;
        maxBrightness: number;
      };
    };
```

The `PalettePayload` return type comes from `@marquee/contracts`, so the integration contract is the single source of truth for that shape.

## 6. Color extraction pipeline

Three ordered steps, each testable in isolation.

### Step 1 — extract raw swatches

```typescript
import Vibrant from "node-vibrant";

const rawSwatches = await Vibrant.from(imageBuffer)
  .maxColorCount(64) // higher = more accurate on complex art, slower
  .quality(3) // 1 = best, 5 = fastest; 3 is a fine default
  .getPalette();
```

Vibrant returns up to 6 named swatches: `Vibrant`, `LightVibrant`, `DarkVibrant`, `Muted`, `LightMuted`, `DarkMuted`. Any can be `null` if the image doesn't have that population — which is the first signal of a monochrome or restricted-palette cover.

Optional pre-processing: resize the image to 200×200 before analysis. Vibrant handles larger, but smaller is faster and the extracted palette barely changes.

### Step 2 — Hue-aware post-processing

This is where the difference between a "wow, that's Purple Rain" palette and a "why is the room beige" palette lives. For each candidate swatch, in preference order (`Vibrant`, `DarkVibrant`, `LightVibrant`, `Muted`, `DarkMuted`, `LightMuted`):

1. **In-gamut check.** Convert swatch RGB → CIE xy, test against Hue gamut C polygon (most modern color bulbs). If outside, project to the nearest point on the polygon. If the projection is severe (>10% shift on either axis), drop the swatch — projecting a deep red to something else entirely produces surprising results.
2. **Minimum saturation.** If HSV saturation < `minSaturation` (default 0.15), the light will look nearly white and lose the album mood. Boost to `saturationBoost` (default 0.4), or drop if already close to grey.
3. **Minimum brightness.** Hue can produce dim colors but they get washed out by room ambient. Enforce brightness ≥ `minBrightness` (default 0.25). Common on black-metal or noir jazz covers — boost preserves the _feeling_ while keeping the light visible.
4. **Contrast between swatches.** Compute ΔE between adjacent palette entries. If any pair is under `minDeltaE` (default 15), drop one — otherwise the palette looks uniform on the wall.
5. **Cap at `maxColors`.** Default 4. Room lighting doesn't need more; more just creates dilution.

### Step 3 — ordering and role assignment

> **Updated 2026-07-11 (supersedes the original "Vibrant-first" ordering; see [ADR 0003](../adrs/0003-palette-press-dominant-first-ordering.md)).**
> Roles are still assigned by final position (0 → `primary`, 1 → `secondary`, 2+ → `accent`),
> but the surviving colors are ordered **dominant-color-first**: highest node-vibrant pixel
> **population**, considered only _among the sufficiently-colorful swatches_ (chroma ≥
> `orderColorFloor`, default 0.2), so a dull high-population background can't outrank the
> album's signature color. This is what makes Purple Rain lead with purple and Kind of Blue
> with blue — matching this spec's §2 success criteria and the integration contract's own
> Purple Rain reference payload (whose `primary` is DarkVibrant, not Vibrant). When
> populations aren't supplied, the implementation falls back to the original fixed preference
> order (`Vibrant, DarkVibrant, LightVibrant, Muted, DarkMuted, LightMuted`).

Roles by final position:

- Position 0 → `primary`
- Position 1 → `secondary`
- Position 2+ → `accent`

Conductor uses these as a preference-ordered list when mapping to actual lights — primary tends to land on the main/behind-you light, accents on peripherals.

Each color also carries its `sourceSwatch` name (`"DarkVibrant"`, etc.) for debugging when a palette looks wrong.

## 7. Pattern selection

> **Updated 2026-07-23 (supersedes the original size-only, "no audio features" rules; see
> [ADR 0033](../adrs/0033-palette-derived-motion-energy.md)).** Selection is now **energy-aware**:
> a vivid palette earns lively motion, a muted one keeps the calm defaults it always had.

Deterministic and pure — energy is read from the palette, so the same palette always selects the same
pattern (golden/caching guarantees hold).

**Palette energy** (`paletteEnergy`) scores how vivid a palette reads on the wall, 0..1: a blend of
mean HSV saturation (weight 0.55) and brightness (0.45). Grey/near-black palettes score ~0; saturated,
bright palettes score high.

| Palette                  | Pattern                                                                                             |
| ------------------------ | --------------------------------------------------------------------------------------------------- |
| **insufficient** (any)   | `static` — colors were saturation-boosted to floors, so their energy isn't real                     |
| 1 color, energy < 0.66   | `static`                                                                                            |
| 1 color, energy ≥ 0.66   | `pulse` — breathes; period ≈3000→1400ms and brightness swing widen with energy                      |
| 2+ colors, energy < 0.62 | `crossfade` — `{8000,30000}` (2 colors) / `{12000,45000}` (3+), as before                           |
| 2+ colors, energy ≥ 0.62 | `rotate` — palette walks the room; interval ≈1600→700ms (faster at higher energy), floored at 400ms |

Muted palettes are unchanged from the old rules; only vivid palettes gain motion. Curator's UI still
lets the user override the result on the way to review.

**Optional `audioFeatures` override.** `selectDefaultPattern` accepts an optional `audioFeatures`
(from hand-authored album metadata or a future local analyzer — **not** auto-fetched from Spotify,
whose endpoint is deprecated). When present:

- `energy` (0..1) **replaces** the palette-derived read (a truer signal than the art alone).
- `tempo` (BPM) **tempo-locks** the motion: the rotate interval / pulse period snaps to the nearest
  whole-beat multiple, so the lights move _with_ the record.

Absent — the common case today — the palette drives everything and the payload's `meta.audioFeatures`
is omitted. Track-level or per-side variation remains out of scope (§3).

## 8. Handling insufficient palettes

Some album art genuinely doesn't produce a usable Hue palette — monochrome covers, black-on-black metal albums, minimalist white sleeves. Rather than fail hard, the library returns an `InsufficientPaletteResult` with a reason:

- `monochrome` — the extracted swatches are all very close in hue (indicates a single-color source image)
- `all_clamped` — enough swatches existed but every one failed gamut/saturation/brightness checks
- `unusable_art` — vibrant couldn't extract anything meaningful at all (rare, usually indicates corrupt input)

Roadie translates this into the `palette_insufficient: true` flag on the album's asset file. The album still advances to `awaiting_review`; the human decides whether to hand-craft a palette, override the artwork, or accept the minimal result.

Design intent: an insufficient palette is a valid business outcome, not an error. Throwing would force every caller to try/catch a case that has a legitimate downstream handler.

## 9. Development milestones

Each milestone ends in a state you can demo or test against fixtures.

1. **Bare extraction.** `extractRawSwatches` returns raw swatches for fixture album art via node-vibrant. Success: Purple Rain fixture yields all six named swatches populated.
2. **Post-processing rules.** Implement gamut, saturation, brightness, and contrast filtering. Success: raw palette becomes a 3-4 color, always-Hue-friendly palette. Purple Rain still looks purple.
3. **Insufficient handling.** Detect monochrome and unusable inputs, return `InsufficientPaletteResult` gracefully with correct reason. Success: The White Album fixture returns `insufficient: true, reason: "monochrome"` with no throw.
4. **Role assignment.** Assign primary/secondary/accent based on swatch order. Success: dominant color reliably gets `primary`.
5. **CIE xy conversion.** Precompute `cie_xy` for each surviving color. Success: all palette colors have valid xy coordinates within gamut C.
6. **Default pattern selection.** Implement the rules from §7. Success: 4-color palette produces the correct crossfade params; 1-color palette produces static.
7. **Public entry point.** Wire `generatePalette` end-to-end, return a `PalettePayload` that validates against the contract schema. Success: schema validation passes on all fixture albums.
8. **Golden test coverage.** Save reference palettes for every fixture album. Success: any algorithm regression is caught by a specific golden diff.

## 10. Testing considerations

Per the testing strategy, Palette Press is one of the most testable components in Marquee: pure functions, deterministic, no external I/O.

- **Unit tests** for each post-processing rule in isolation (gamut clamping, saturation boost, brightness floor, contrast filter, role assignment). Table-driven, exhaustive.
- **Golden tests** for each fixture album: run `generatePalette` and compare to committed golden JSON. **Comparison is tolerant, not exact (updated 2026-07-11):** structural aspects that define the experience — number of colors, roles, `insufficient`+`reason`, pattern, source — must match exactly, but each color is compared to its golden by **ΔE (< ~12)** rather than byte-identical hex. This is a deliberate product choice, not a workaround: node-vibrant decodes via **Jimp (pure JS)**, so extraction is deterministic across platforms and exact comparison would pass in CI too — but ΔE tolerance makes a golden fail on a _meaningful_ experience change (a primary flipping purple→orange is ΔE 50+) rather than on a trivial value nudge from a threshold tweak. **Golden tests run in CI** alongside the pure-logic and property tests. Regenerate goldens (`pnpm --filter @marquee/palette-press update-goldens`) after an intentional algorithm change; a human reviews the diff before committing.
- **Property tests** (`fast-check`) for post-processor invariants: any output palette must have all colors in-gamut, above minimum saturation and brightness, above minimum contrast between adjacent colors, correctly ordered by role.
- **Insufficient palette tests** for each `reason` case, using targeted fixtures (monochrome, all-clamped, corrupt input).
- **No integration tests.** This is a library. Consumers test their own integration.

## 11. Known gotchas

- **node-vibrant image backend.** node-vibrant v4 decodes via **Jimp (pure JS)** — no `sharp`, no native binaries — so there's nothing to `rebuild` and decoding is deterministic across platforms. (Corrected 2026-07-11; the original spec assumed a `sharp` native dep that doesn't exist.)
- **Determinism.** node-vibrant results depend on `maxColorCount` and `quality`. Pin them in defaults; don't tweak per-album or golden tests become meaningless.
- **Gamut C assumption.** Post-processing clamps to gamut C (most current color bulbs). If a user's setup includes older bulbs (gamut A or B), Conductor's runtime clamping may shift colors further — this is intentional and correct, but the palette Palette Press produces may look slightly different on those bulbs than in Curator's preview.
- **Insufficient is a signal, not an error.** Callers who wrap `generatePalette` in try/catch will still need to check `.insufficient` on the returned payload's palette. Don't confuse graceful degradation with success.
- **Cover art rights.** The library operates on bytes provided by the caller and doesn't distribute them. Any rights questions live with the caller (Curator/Roadie in Marquee's case).
