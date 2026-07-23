# Integration Contract — `PalettePayload`

This is the shared contract between Palette Press (producer) and Hue Conductor (consumer). Both specs reference this document. Version it — future changes should bump `version` and both apps should accept old versions during transition.

## 1. Payload shape

```typescript
type PalettePayload = {
  version: 1;

  source: {
    type: "album" | "manual" | "test";
    // For type="album":
    spotifyId?: string;
    name?: string; // "Purple Rain"
    artist?: string; // "Prince"
    year?: number;
    artworkUrl?: string; // for debug/UI only; consumer doesn't need to fetch it
  };

  palette: {
    colors: PaletteColor[]; // 1..8; typically 3-5
  };

  pattern: {
    type: "static" | "rotate" | "pulse" | "crossfade";
    params: PatternParams; // shape depends on type
  };

  meta?: {
    generatedAt?: string; // ISO
    generator?: string; // "palette-press@0.1.0"
    audioFeatures?: {
      // optional; present when generator had access
      energy?: number; // 0..1
      valence?: number; // 0..1
      tempo?: number; // BPM
      danceability?: number; // 0..1
    };
  };
};

type PaletteColor = {
  hex: string; // "#RRGGBB", uppercase
  cie_xy?: [number, number]; // optional precomputed CIE xy
  role: "primary" | "secondary" | "accent";
  sourceSwatch?: string; // debug: e.g. "DarkVibrant"
};

type PatternParams =
  | {/* static */}
  | { intervalMs: number; direction: "forward" | "reverse" } // rotate
  | { periodMs: number; minBrightness: number; maxBrightness: number } // pulse
  | { transitionMs: number; holdMs: number }; // crossfade
```

## 2. JSON Schema

Both services import the same `schema.json` and validate at boundaries. Keep it as a versioned file in a shared location (e.g. a small internal npm package, or just synced files).

Sketch:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "marquee/schemas/palette-payload-v1.json",
  "type": "object",
  "required": ["version", "source", "palette", "pattern"],
  "properties": {
    "version": { "const": 1 },
    "source": {
      "type": "object",
      "required": ["type"],
      "properties": {
        "type": { "enum": ["album", "manual", "test"] },
        "spotifyId": { "type": "string" },
        "name": { "type": "string" },
        "artist": { "type": "string" },
        "year": { "type": "integer" },
        "artworkUrl": { "type": "string", "format": "uri" }
      }
    },
    "palette": {
      "type": "object",
      "required": ["colors"],
      "properties": {
        "colors": {
          "type": "array",
          "minItems": 1,
          "maxItems": 8,
          "items": {
            "type": "object",
            "required": ["hex", "role"],
            "properties": {
              "hex": { "type": "string", "pattern": "^#[0-9A-F]{6}$" },
              "cie_xy": {
                "type": "array",
                "minItems": 2,
                "maxItems": 2,
                "items": { "type": "number", "minimum": 0, "maximum": 1 }
              },
              "role": { "enum": ["primary", "secondary", "accent"] },
              "sourceSwatch": { "type": "string" }
            }
          }
        }
      }
    },
    "pattern": {
      "type": "object",
      "required": ["type", "params"],
      "oneOf": [
        {
          "properties": {
            "type": { "const": "static" },
            "params": { "type": "object", "maxProperties": 0 }
          }
        },
        {
          "properties": {
            "type": { "const": "rotate" },
            "params": {
              "type": "object",
              "required": ["intervalMs", "direction"],
              "properties": {
                "intervalMs": { "type": "integer", "minimum": 100 },
                "direction": { "enum": ["forward", "reverse"] }
              }
            }
          }
        },
        {
          "properties": {
            "type": { "const": "pulse" },
            "params": {
              "type": "object",
              "required": ["periodMs", "minBrightness", "maxBrightness"],
              "properties": {
                "periodMs": { "type": "integer", "minimum": 200 },
                "minBrightness": {
                  "type": "number",
                  "minimum": 0,
                  "maximum": 100
                },
                "maxBrightness": {
                  "type": "number",
                  "minimum": 0,
                  "maximum": 100
                }
              }
            }
          }
        },
        {
          "properties": {
            "type": { "const": "crossfade" },
            "params": {
              "type": "object",
              "required": ["transitionMs", "holdMs"],
              "properties": {
                "transitionMs": { "type": "integer", "minimum": 100 },
                "holdMs": { "type": "integer", "minimum": 0 }
              }
            }
          }
        }
      ]
    },
    "meta": { "type": "object" }
  }
}
```

## 3. Reference payload — "Purple Rain"

```json
{
  "version": 1,
  "source": {
    "type": "album",
    "spotifyId": "1C2h7mLntPSeVYciMRTF4a",
    "name": "Purple Rain",
    "artist": "Prince",
    "year": 1984
  },
  "palette": {
    "colors": [
      { "hex": "#4B0082", "role": "primary", "sourceSwatch": "DarkVibrant" },
      { "hex": "#8A2BE2", "role": "secondary", "sourceSwatch": "Vibrant" },
      { "hex": "#D8BFD8", "role": "accent", "sourceSwatch": "LightMuted" },
      { "hex": "#FFD700", "role": "accent", "sourceSwatch": "LightVibrant" }
    ]
  },
  "pattern": {
    "type": "crossfade",
    "params": { "transitionMs": 12000, "holdMs": 45000 }
  },
  "meta": {
    "generatedAt": "2026-07-05T12:00:00Z",
    "generator": "palette-press@0.1.0"
  }
}
```

## 4. Ownership of semantics

- **Palette Press** decides _what colors_ and _what pattern type + params_ to send. It knows about music. Pattern choice is **energy-aware**: it reads a vividness score from the palette itself (vivid → `rotate`/`pulse`, muted → `crossfade`/`static`), and, when `meta.audioFeatures` is present, uses `energy` as a truer read and `tempo` to beat-lock the motion ([ADR 0022](../adrs/0022-palette-derived-motion-energy.md); palette-press-spec §7). `audioFeatures` is optional and hand-authored/analyzer-sourced — **not** auto-fetched from Spotify (deprecated endpoint) — so it's usually absent.
- **Hue Conductor** decides _how to render_ that pattern on specific hardware in a specific room. It knows about lights.
- Roles (`primary`/`secondary`/`accent`) are a hint; the Conductor may map them differently based on room layout (which light is "central" vs. "peripheral"). Treat them as a preference-ordered list and cycle if there are more lights than colors.

## 5. Versioning policy

- Add fields freely (both sides ignore unknown fields).
- Removing or changing a field's meaning = bump `version` and support both.
- New pattern types = add to enum; Conductor should reject unknown pattern types with a helpful 400.
