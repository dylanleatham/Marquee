// @marquee/contracts — the single source of truth for cross-service shapes.
//
// Schemas live in ../schemas/*.json. Run `pnpm --filter @marquee/contracts gen`
// to (re)generate TypeScript types into ./generated from those schemas, then
// re-export them here. Until codegen is wired, hand-written types can live here.
//
// See docs/specs/integration-contract.md for the authoritative contract doc.

export const CONTRACTS_VERSION = 1 as const;

// Hand-written types mirroring the JSON schemas in ../schemas/. Kept in sync by the
// contract tests (which validate real payloads against the schemas). When schema→TS
// codegen is wired (scripts/gen-schemas.mjs), these get replaced by generated exports.

export type PaletteRole = "primary" | "secondary" | "accent";

export interface PaletteColor {
  hex: string; // "#RRGGBB", uppercase
  cie_xy?: [number, number];
  role: PaletteRole;
  sourceSwatch?: string;
}

export type PatternParams =
  | Record<string, never> // static
  | { intervalMs: number; direction: "forward" | "reverse" } // rotate
  | { periodMs: number; minBrightness: number; maxBrightness: number } // pulse
  | { transitionMs: number; holdMs: number } // crossfade
  | { speed?: number; scale?: number; brightness?: number } // aurora (streaming)
  | { speed?: number; intensity?: number } // shimmer (streaming)
  | { speed?: number; angleDeg?: number }; // wave (streaming)

/**
 * Patterns rendered over the CLIP v2 API — the light-by-light commands every bridge speaks. Palette
 * Press derives one of these for every album, and it is what plays unless a human says otherwise.
 */
export type ClipPatternType = "static" | "rotate" | "pulse" | "crossfade";

/**
 * Streaming effects rendered over the Entertainment API (ADR 0023/0024) rather than CLIP. A Conductor
 * without a configured entertainment area falls back to a CLIP pattern, so these are safe to send.
 */
export type StreamPatternType = "aurora" | "shimmer" | "wave";

/** Every motion an album can play, and so every answer the Look tab's picker offers (ADR 0039). */
export type PatternType = ClipPatternType | StreamPatternType;

/** The CLIP patterns, as a runtime list. */
export const CLIP_PATTERN_TYPES: readonly ClipPatternType[] = [
  "static",
  "rotate",
  "pulse",
  "crossfade",
];

/** The streaming effects, as a runtime list — for telling the two halves apart at a boundary. */
export const STREAM_PATTERN_TYPES: readonly StreamPatternType[] = [
  "aurora",
  "shimmer",
  "wave",
];

/** All seven, for validating a pattern override at an API boundary (ADR 0039). */
export const PATTERN_TYPES: readonly PatternType[] = [
  ...CLIP_PATTERN_TYPES,
  ...STREAM_PATTERN_TYPES,
];

export const isStreamPatternType = (type: string): type is StreamPatternType =>
  (STREAM_PATTERN_TYPES as readonly string[]).includes(type);

export const isClipPatternType = (type: string): type is ClipPatternType =>
  (CLIP_PATTERN_TYPES as readonly string[]).includes(type);

/** One tunable knob on a pattern: what it's called, what it means, and its legal range. */
export interface PatternParamSpec {
  key: string;
  label: string;
  min: number;
  max: number;
  /** Slider granularity, and the precision a stored value is expected to have. */
  step: number;
  /** The default this knob sits at when untouched. A param at its default is not stored. */
  default: number;
  /** Plain-language effect of turning it up — the UI shows this, not the units. */
  hint: string;
  /**
   * True where the payload schema demands a whole number (`intervalMs`, `periodMs`, …). Enforced by
   * the validator so a slider can never produce an asset that Conductor's own contract would reject.
   */
  integer?: boolean;
}

/**
 * The knobs each pattern exposes (ADR 0036 for the streaming half, ADR 0039 for the CLIP half).
 *
 * Declared here, once, because two places have to agree exactly: Curator's server rejects a value
 * outside these bounds, and Curator's UI draws the slider. Two copies of a range is a bug waiting to
 * happen — a UI that offers a value the server refuses is worse than no slider.
 *
 * The streaming entries mirror the renderers' own parameters and defaults in
 * `hue-conductor/src/stream/renderers.ts`, and a test in that package asserts they still match. The
 * CLIP entries have no renderer constant to mirror — the engine plays whatever params the payload
 * carries — so their guard is `palette-payload.schema.json`, which every value here must satisfy.
 *
 * Bounds are usable ranges rather than everything a renderer tolerates. `aurora.speed` accepts any
 * positive number; past ~0.5 it stops reading as an aurora.
 */
export const PATTERN_PARAM_SPECS: Record<PatternType, PatternParamSpec[]> = {
  // Hold the palette across the lights, no motion — nothing to tune.
  static: [],
  rotate: [
    {
      key: "intervalMs",
      label: "Step",
      min: 400,
      max: 6000,
      step: 100,
      default: 1200,
      integer: true,
      hint: "How long each colour holds before the palette steps around the room.",
    },
  ],
  pulse: [
    {
      key: "periodMs",
      label: "Breath",
      min: 400,
      max: 8000,
      step: 100,
      default: 2200,
      integer: true,
      hint: "One full dim-and-rise, in milliseconds.",
    },
    {
      key: "minBrightness",
      label: "Dim to",
      min: 0,
      max: 90,
      step: 5,
      default: 40,
      hint: "How far down the breath goes, as a percentage.",
    },
    {
      key: "maxBrightness",
      label: "Rise to",
      min: 10,
      max: 100,
      step: 5,
      default: 100,
      hint: "How far up the breath goes, as a percentage.",
    },
  ],
  crossfade: [
    {
      key: "transitionMs",
      label: "Fade",
      min: 500,
      max: 20000,
      step: 500,
      default: 8000,
      integer: true,
      hint: "How long the room takes to melt from one colour to the next.",
    },
    {
      key: "holdMs",
      label: "Hold",
      min: 1000,
      max: 120000,
      step: 1000,
      default: 30000,
      integer: true,
      hint: "How long each colour sits before the next fade begins.",
    },
  ],
  aurora: [
    {
      key: "speed",
      label: "Speed",
      min: 0.01,
      max: 0.5,
      step: 0.01,
      default: 0.06,
      hint: "How fast the colours drift and morph.",
    },
    {
      key: "scale",
      label: "Spread",
      min: 0.2,
      max: 4,
      step: 0.1,
      default: 1.2,
      hint: "Higher spreads more distinct colours across the room.",
    },
    {
      key: "brightness",
      label: "Brightness",
      min: 0.1,
      max: 1,
      step: 0.05,
      default: 1,
      hint: "Overall level. Lower for a dimmer room.",
    },
  ],
  shimmer: [
    {
      key: "speed",
      label: "Twinkle speed",
      min: 0.1,
      max: 6,
      step: 0.1,
      default: 1.5,
      hint: "How fast each light flickers.",
    },
    {
      key: "intensity",
      label: "Depth",
      min: 0,
      max: 1,
      step: 0.05,
      default: 0.35,
      hint: "How far the brightness dips. 0 is steady.",
    },
  ],
  wave: [
    {
      key: "speed",
      label: "Sweep speed",
      min: 0.05,
      max: 2,
      step: 0.05,
      default: 0.25,
      hint: "Gradient cycles swept per second.",
    },
    {
      key: "angleDeg",
      label: "Direction",
      min: 0,
      max: 355,
      step: 5,
      default: 0,
      hint: "0° sweeps left→right, 90° rear→front.",
    },
  ],
};

/**
 * Validate a params object for one pattern. Returns the accepted params, or throws with a message
 * naming what was wrong — callers map that to a 400.
 *
 * Values equal to the spec default are dropped rather than stored: an album that has been left alone
 * should carry no params at all, so "untouched" and "explicitly set to the default" don't become two
 * states that look identical but diverge if a default ever changes.
 */
export function validatePatternParams(
  type: PatternType,
  params: unknown,
): Record<string, number> {
  if (params == null) return {};
  if (typeof params !== "object" || Array.isArray(params))
    throw new Error("params must be an object");
  const specs = PATTERN_PARAM_SPECS[type];
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(
    params as Record<string, unknown>,
  )) {
    const spec = specs.find((s) => s.key === key);
    if (!spec)
      throw new Error(
        specs.length === 0
          ? `${type} takes no params`
          : `unknown param "${key}" for ${type} — expected ${specs.map((s) => s.key).join(", ")}`,
      );
    if (typeof value !== "number" || !Number.isFinite(value))
      throw new Error(`param "${key}" must be a finite number`);
    if (value < spec.min || value > spec.max)
      throw new Error(
        `param "${key}" must be between ${spec.min} and ${spec.max}`,
      );
    // The payload schema types these as integers; a fractional value would pass here and then be
    // rejected downstream by Conductor's own contract, which is a worse place to find out.
    if (spec.integer && !Number.isInteger(value))
      throw new Error(`param "${key}" must be a whole number`);
    if (value !== spec.default) out[key] = value;
  }
  // Cross-knob invariants, checked against the resolved set so a lone `minBrightness` is judged
  // against the default it will actually play beside.
  if (type === "pulse") {
    const r = resolvePatternParams("pulse", out) as {
      minBrightness: number;
      maxBrightness: number;
    };
    if (r.minBrightness >= r.maxBrightness)
      throw new Error('param "minBrightness" must be below "maxBrightness"');
  }
  return out;
}

/**
 * Fill a stored (partial) param set out to the complete params the payload contract requires — the
 * spec default for every knob the human didn't move.
 *
 * Needed because `pattern.params` is *required* per type in `palette-payload.schema.json`: a rotate
 * without `intervalMs` is not a legal payload, however little the human touched.
 */
export function resolvePatternParams(
  type: PatternType,
  stored: Record<string, number> | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const spec of PATTERN_PARAM_SPECS[type])
    out[spec.key] = stored?.[spec.key] ?? spec.default;
  // `direction` is an enum rather than a knob, so it has no spec entry (ADR 0039). Every derived
  // rotate is forward; an overridden one matches until there's a control worth adding for it.
  if (type === "rotate") out.direction = "forward";
  return out;
}

/**
 * Optional per-album audio descriptors (integration-contract §1 `meta.audioFeatures`). Present only
 * when a generator had access — Spotify's audio-features endpoint is deprecated, so today this is a
 * hand-authored / future-analyzer signal, not an automatic one. The producer uses it (when present)
 * to refine pattern params — tempo-locking motion, widening dynamics with energy (ADR 0033). All
 * fields optional; consumers ignore what they don't understand.
 */
export interface AudioFeatures {
  energy?: number; // 0..1
  valence?: number; // 0..1
  tempo?: number; // BPM
  danceability?: number; // 0..1
}

export interface PalettePayload {
  version: 1;
  source: {
    type: "album" | "manual" | "test";
    spotifyId?: string;
    name?: string;
    artist?: string;
    year?: number;
    artworkUrl?: string;
  };
  palette: { colors: PaletteColor[] };
  pattern: {
    type: "static" | "rotate" | "pulse" | "crossfade" | StreamPatternType;
    params: PatternParams;
  };
  /**
   * Play this Entertainment effect *instead of* `pattern`, when the consumer has an entertainment
   * area configured (ADR 0035). Optional and additive: a producer that omits it, or a consumer that
   * ignores it, behaves exactly as before.
   *
   * Carried alongside `pattern` rather than inside it so the fallback is the album's own derived
   * pattern — energy-aware per [ADR 0033] — rather than a generic guess. Setting
   * `pattern.type` to a streaming effect directly still works (the Demo Room and manual `curl` do
   * that); it just cannot express what to play instead when there's no area.
   */
  streaming?: {
    effect: StreamPatternType;
    /** Per-album overrides for that effect's knobs (ADR 0036). Absent keys use the renderer's own
     * default, so `{}` and absent mean the same thing. */
    params?: Record<string, number>;
  };
  meta?: {
    generatedAt?: string;
    generator?: string;
    audioFeatures?: AudioFeatures;
  };
}

// --- Runtime scan events (Stylus → Conductor + Backdrop) ---------------------------------------
// The fan-out signal: Stylus reads a tagged sleeve and POSTs one of these to each runtime service
// (integration-contract §scan, stylus-spec §"Outbound events"). `stop` deliberately carries no
// `uri` — downstream treats it as "return to idle" regardless of what was playing.

/** A sleeve, card or demo tag was placed on the stand. */
export interface ScanStartEvent {
  event: "start";
  /**
   * Curator URI, `curator:<kind>:<curatorId>` where kind is `album` (a record sleeve), `card` (a
   * printed card for a streaming-only album) or `demo` (a tag that plays one chosen track).
   * Conductor and Backdrop treat all three identically (lights + video); only Amp acts on the
   * difference — it stays silent for `album` (you drop the needle on the vinyl), streams the whole
   * album for `card`, and streams the album's chosen track for `demo`. See ADR 0034 / ADR 0058 /
   * `parseCuratorUri`.
   */
  uri: string;
  /**
   * Raw NFC tag UID, e.g. "04:A1:B2:C3:D4:E5:F6". Informational downstream, but a real `start`
   * always carries one — required here to match scan-event.schema.json's `then.required`.
   */
  tagUid: string;
  /** Which physical stand fired this; defaults to "primary". Downstream may ignore it. */
  readerId?: string;
  /** ISO-8601 timestamp the event was produced. */
  at: string;
}

/** The sleeve was removed. No `uri`: return to idle whatever was playing. */
export interface ScanStopEvent {
  event: "stop";
  readerId?: string;
  at: string;
}

export type ScanEvent = ScanStartEvent | ScanStopEvent;

/**
 * A service's answer to a scan. **A 2xx is not proof the room did anything**: Conductor accepts a
 * scan it cannot act on and says so in the body — `action:"ignored"` with the reason, for
 * `no listening room`, `album not synced` and `album not ready` (ADR 0019). A service that simply
 * accepts, as Backdrop does with `{accepted:true}`, carries no `action` at all.
 *
 * The fields are optional because this describes what a caller may rely on across services, not one
 * service's exact payload — Conductor adds `roomId`/`playbackId`, Backdrop adds nothing.
 */
export interface ScanResponse {
  ok?: boolean;
  action?: "playing" | "streaming" | "stopped" | "ignored";
  reason?: string;
  accepted?: boolean;
}

/**
 * The reason a service explicitly ignored a scan, or `null` if it acted on it.
 *
 * The one place the "accepted but did nothing" shape is decoded, so a caller cannot mistake a
 * documented no-op for success — which is exactly what happened in issue #164, where Curator's
 * rehearsal reported "Lights running" over a dark room for every one of Conductor's ignored
 * outcomes. Anything that is not an explicit `ignored` is treated as having run: an unreadable or
 * unfamiliar body is not evidence of a no-op.
 */
export function scanIgnoredReason(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const { action, reason } = body as ScanResponse;
  if (action !== "ignored") return null;
  return typeof reason === "string" && reason.length > 0
    ? reason
    : "the scan was ignored";
}

/**
 * The physical object a scan URI names — all three name the same album, and differ only in what the
 * audio leg does with them:
 *
 * - `album` — a record **sleeve**. Amp stays silent; you drop the needle on the vinyl (ADR 0034).
 * - `card` — a printed **shelf card**. Amp streams the whole album from track 1 (ADR 0034).
 * - `demo` — a **demo tag**. Amp streams the one track chosen for the album (ADR 0058).
 */
export type CuratorUriKind = "album" | "card" | "demo";

/**
 * The kinds as a runtime list, so a caller that must handle every one of them — the contract tests,
 * Curator's tag authoring, the Flipper's kind menu — enumerates rather than restates. Adding a kind
 * here is what makes the round-trip tests cover it.
 */
export const CURATOR_URI_KINDS: readonly CuratorUriKind[] = [
  "album",
  "card",
  "demo",
];

export interface ParsedCuratorUri {
  kind: CuratorUriKind;
  curatorId: string;
}

// Matches every kind; the curatorId is the same 8-char base32-ish id regardless of kind.
const CURATOR_URI = /^curator:(album|card|demo):([a-z0-9]{8})$/;

/**
 * Parse a Curator scan URI into its kind + id, or `null` if it isn't a well-formed
 * `curator:(album|card|demo):<id>`. The one place every service (Conductor, Backdrop, Amp) should
 * decode a scan URI, so the accepted shape stays identical across the fan-out. The id is shared
 * across kinds — same album, different physical object. See ADR 0034 (card) and ADR 0058 (demo).
 */
export function parseCuratorUri(uri: string): ParsedCuratorUri | null {
  const m = CURATOR_URI.exec(uri);
  if (!m) return null;
  return { kind: m[1] as CuratorUriKind, curatorId: m[2] as string };
}

/**
 * Build a Curator scan URI from its kind + id — the inverse of `parseCuratorUri`. Does not validate
 * the id shape (callers that write tags, e.g. Curator's Flipper authoring, validate the curatorId
 * first). `curatorUri("card", id)` is what a card sticker carries, `"demo"` a demo tag, `"album"` a
 * sleeve.
 */
export function curatorUri(kind: CuratorUriKind, curatorId: string): string {
  return `curator:${kind}:${curatorId}`;
}

// --- Backdrop library entries (Curator → Backdrop) ---------------------------------------------
// The map *value* in Backdrop's URI → video-file map (backdrop-spec §9): the `uri` is the map key,
// so it is not repeated in the value here. On the wire (POST /api/library/sync) each element carries
// its own `uri` — that's the shape library-entry.schema.json describes (`{ uri } & LibraryEntry`).
// Curator pushes these; the video files themselves are synced out-of-band (rsync).

export interface LibraryEntry {
  /** Absolute path to the visualizer file on the Backdrop Pi. */
  filePath: string;
  /** Video duration in seconds. Informational today. */
  durationSec?: number;
  /** Content hash so Curator's sync knows when a video changed and needs re-pushing. */
  contentHash?: string;
}

// TODO(build order): also export AlbumAsset (hand-written or generated) once that boundary is
// promoted out of curator/src/albums/asset.ts.

// --- Album → PalettePayload mapping (Curator Demo Room + Conductor /api/scan) -------------------
// The narrow slice of an album asset needed to build the light-show payload. Curator's full
// AlbumAsset satisfies this structurally, so both Curator (Demo Room) and Conductor (which reads the
// synced album-assets store at scan time, issue #45 / ADR 0019) map the same way via one function.

/** The minimum an album must carry to drive a light show. `AlbumAsset` is a structural superset. */
export interface AlbumPaletteInput {
  metadata: { name: string; artist: string; year?: number };
  palette?: {
    colors: Array<{ hex: string; role: string; cie_xy?: [number, number] }>;
  };
  pattern?: { type: string; params: unknown };
  /**
   * The human's per-album motion override (ADR 0039). Absent/null — the default for every album —
   * means the derived `pattern` plays. A streaming value rides alongside `pattern`; a CLIP value
   * replaces it in the payload. Either way the stored `pattern` itself stays derived.
   */
  patternOverride?: string | null;
  /** Tuning for `patternOverride`. Belongs to the current type; cleared when it changes. */
  patternOverrideParams?: Record<string, number>;
  /** @deprecated ADR 0035's field names, read here for assets written before ADR 0039 renamed them. */
  streamingEffect?: string | null;
  /** @deprecated Superseded by `patternOverrideParams` (ADR 0039). */
  streamingParams?: Record<string, number>;
}

/**
 * The album's motion override under either generation's field names (ADR 0039's migration). Conductor
 * reads the synced asset store directly (ADR 0019), so an album last saved before the rename must
 * still play what its owner chose.
 */
export function readPatternOverride(asset: AlbumPaletteInput): {
  type: PatternType | null;
  params: Record<string, number>;
} {
  const raw = asset.patternOverride ?? asset.streamingEffect ?? null;
  if (raw == null || !(PATTERN_TYPES as readonly string[]).includes(raw))
    return { type: null, params: {} };
  const params =
    (asset.patternOverride != null
      ? asset.patternOverrideParams
      : asset.streamingParams) ?? {};
  return { type: raw as PatternType, params };
}

/** The album isn't far enough along to drive a light show (no palette/pattern yet). Callers → 409. */
export class PaletteNotReadyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PaletteNotReadyError";
  }
}

const PALETTE_ROLES: PaletteRole[] = ["primary", "secondary", "accent"];
const asRole = (role: string): PaletteRole =>
  (PALETTE_ROLES as string[]).includes(role) ? (role as PaletteRole) : "accent";

/**
 * Map a stored album into the palette+pattern payload Conductor plays. Throws PaletteNotReadyError if
 * the album has no palette/pattern yet (still in Roadie's pipeline). Roles/pattern-type outside the
 * contract's unions are coerced to safe defaults rather than rejected — the light show is best-effort.
 *
 * A human's `patternOverride` (ADR 0039) is applied here rather than stored: a CLIP override becomes
 * the payload's `pattern`, resolved to the complete params the schema requires; a streaming override
 * rides in the optional `streaming` block and leaves `pattern` as the no-entertainment-area fallback.
 */
export function buildPalettePayload(asset: AlbumPaletteInput): PalettePayload {
  if (!asset.palette || asset.palette.colors.length === 0)
    throw new PaletteNotReadyError("album has no palette yet");
  if (!asset.pattern)
    throw new PaletteNotReadyError("album has no pattern yet");

  const override = readPatternOverride(asset);
  const derivedType = (PATTERN_TYPES as readonly string[]).includes(
    asset.pattern.type,
  )
    ? (asset.pattern.type as PalettePayload["pattern"]["type"])
    : "static";

  // A CLIP override *is* the pattern — there's no fallback question, since every bridge speaks CLIP.
  const clipOverride =
    override.type !== null && isClipPatternType(override.type)
      ? override.type
      : null;
  const type = clipOverride ?? derivedType;
  const params = clipOverride
    ? resolvePatternParams(clipOverride, override.params)
    : (asset.pattern.params as PalettePayload["pattern"]["params"]);

  return {
    version: 1,
    source: {
      type: "album",
      name: asset.metadata.name,
      artist: asset.metadata.artist,
      ...(asset.metadata.year ? { year: asset.metadata.year } : {}),
    },
    palette: {
      colors: asset.palette.colors.map((c) => ({
        hex: c.hex,
        role: asRole(c.role),
        ...(c.cie_xy ? { cie_xy: c.cie_xy } : {}),
      })),
    },
    pattern: {
      type,
      params: params as PalettePayload["pattern"]["params"],
    },
    // A streaming override leaves the derived pattern above in place as the no-entertainment-area
    // fallback (ADR 0035). An unrecognized value was already dropped by readPatternOverride — same
    // best-effort posture as the role/pattern-type coercion above.
    ...(override.type !== null && isStreamPatternType(override.type)
      ? {
          streaming: {
            effect: override.type,
            // Only when there's something to say — an untuned album carries no params key.
            ...(Object.keys(override.params).length > 0
              ? { params: override.params }
              : {}),
          },
        }
      : {}),
  };
}
