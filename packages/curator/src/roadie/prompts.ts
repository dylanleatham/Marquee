// Prompt drafting (roadie-spec §7). Two prompts per album — one for the Backdrop visualizer video,
// one for the printed business-card art — from the same inputs (metadata + palette) via different
// templates. Pure, deterministic, no external calls: fast, testable, golden-friendly.
import type { AlbumMetadata } from "../albums/asset.js";

export type PromptType = "video" | "cardArt";

export interface PromptTemplate {
  /** Optional style preamble printed before the album line. */
  preamble: string;
  /** Style body (motion for video, composition for card art) printed after the palette. */
  body: string;
}

/** Motion-oriented templates for the looping visualizer video. Default: abstract_flow. */
export const VIDEO_TEMPLATES: Record<string, PromptTemplate> = {
  abstract_flow: {
    preamble: "",
    body: "Abstract flowing shapes with soft edges, drifting slowly through the palette.",
  },
  particle_drift: {
    preamble: "",
    body: "Slow-moving particles suspended in a gradient field, gently drifting.",
  },
  geometric_pulse: {
    preamble: "",
    body: "Sharp geometric shapes pulsing to an implicit rhythm.",
  },
  analog_film: {
    preamble: "",
    body: "Grainy analog film textures with slow color shifts and gate weave.",
  },
  psychedelic: {
    preamble: "",
    body: "Kaleidoscopic patterns folding and unfolding in symmetry.",
  },
  minimal_gradient: {
    preamble: "",
    body: "Nothing but a slowly shifting color gradient, meditative and calm.",
  },
};

/** Emblem-oriented templates for the static card art. Default: iconic_emblem. */
export const CARD_ART_TEMPLATES: Record<string, PromptTemplate> = {
  iconic_emblem: {
    preamble: "",
    body: "A single evocative image that reads at business-card scale.",
  },
  abstract_scene: {
    preamble: "",
    body: "An abstract composition that captures the album's mood.",
  },
  typographic: {
    preamble: "",
    body: "Bold typography incorporating the album title, playing with palette colors.",
  },
  photograph_style: {
    preamble: "",
    body: "A photorealistic scene evocative of the album's themes.",
  },
  collage: {
    preamble: "",
    body: "A layered collage of textures, shapes, and small motifs.",
  },
};

export const DEFAULT_VIDEO_TEMPLATE = "abstract_flow";
export const DEFAULT_CARD_ART_TEMPLATE = "iconic_emblem";

export interface DraftedPrompt {
  text: string;
  template: string;
  generatedAt: string;
  /** Set when the human copies the prompt to hand to their video/card-art tool (step 7). */
  copiedAt?: string;
}

export type PromptDrafts = Partial<Record<PromptType, DraftedPrompt>>;

/** Minimal palette shape the drafter needs — just the color/role pairs. */
export interface PaletteColorRef {
  hex: string;
  role: string;
}

const paletteBlock = (colors: PaletteColorRef[]): string =>
  colors.map((c) => `  - ${c.hex} (${c.role})`).join("\n");

const albumLine = (m: AlbumMetadata): string => {
  const year = m.year !== undefined ? ` (${m.year})` : "";
  return `"${m.name}" by ${m.artist}${year}`;
};

const genreLine = (m: AlbumMetadata): string =>
  `Genre context: ${m.genres?.length ? m.genres.join(", ") : "unspecified"}.`;

/** Join the non-empty parts of a prompt with blank lines, trimming stray whitespace. */
const assemble = (parts: string[]): string =>
  parts
    .map((p) => p.trim())
    .filter(Boolean)
    .join("\n");

function draftVideo(
  metadata: AlbumMetadata,
  colors: PaletteColorRef[],
  templateName: string,
): DraftedPrompt {
  const tpl =
    VIDEO_TEMPLATES[templateName] ?? VIDEO_TEMPLATES[DEFAULT_VIDEO_TEMPLATE]!;
  const name = VIDEO_TEMPLATES[templateName]
    ? templateName
    : DEFAULT_VIDEO_TEMPLATE;
  const text = assemble([
    tpl.preamble,
    `For the album ${albumLine(metadata)}.`,
    genreLine(metadata),
    `Color palette to draw from:\n${paletteBlock(colors)}`,
    tpl.body,
    "Duration: 3 minutes, seamlessly loopable.",
    "Aspect ratio: 16:9.",
  ]);
  return { text, template: name, generatedAt: "" };
}

function draftCardArt(
  metadata: AlbumMetadata,
  colors: PaletteColorRef[],
  templateName: string,
): DraftedPrompt {
  const tpl =
    CARD_ART_TEMPLATES[templateName] ??
    CARD_ART_TEMPLATES[DEFAULT_CARD_ART_TEMPLATE]!;
  const name = CARD_ART_TEMPLATES[templateName]
    ? templateName
    : DEFAULT_CARD_ART_TEMPLATE;
  const text = assemble([
    tpl.preamble,
    `Business-card sized art for the album ${albumLine(metadata)}.`,
    genreLine(metadata),
    `Color palette to draw from:\n${paletteBlock(colors)}`,
    tpl.body,
    "Dimensions: 1050x600 pixels (business-card landscape at 300 DPI).",
    "Style: iconic, evocative, reads clearly at small size.",
  ]);
  return { text, template: name, generatedAt: "" };
}

export interface DraftOptions {
  videoTemplate?: string;
  cardArtTemplate?: string;
  /** Timestamp stamped on each drafted prompt (injectable for deterministic tests/goldens). */
  now?: () => string;
}

/**
 * Draft both prompts for an album. Deterministic given (metadata, palette, templates); the only
 * non-pure input is `now`, injected so goldens are stable. Unknown template names fall back to the
 * type's default (a redraft with a bad template shouldn't fail the pipeline).
 */
export function draftPrompts(
  metadata: AlbumMetadata,
  colors: PaletteColorRef[],
  opts: DraftOptions = {},
): Required<Pick<PromptDrafts, "video" | "cardArt">> {
  const at = (opts.now ?? (() => new Date().toISOString()))();
  const video = draftVideo(
    metadata,
    colors,
    opts.videoTemplate ?? DEFAULT_VIDEO_TEMPLATE,
  );
  const cardArt = draftCardArt(
    metadata,
    colors,
    opts.cardArtTemplate ?? DEFAULT_CARD_ART_TEMPLATE,
  );
  return {
    video: { ...video, generatedAt: at },
    cardArt: { ...cardArt, generatedAt: at },
  };
}
