// The grounded, two-pass prompt drafter (roadie-spec §7, LLM path). Pass 1 researches the album's
// real visual identity with Google Search grounding; pass 2 turns that research + the metaprompt
// into N distinct, ready-to-use prompt variants via structured output. Grounding and responseSchema
// can't share one call, hence two passes. Everything here is best-effort: the caller (the drafting
// step) falls back to the deterministic templates on any throw, so a bad key never stalls Roadie.
import type { AlbumMetadata } from "../albums/asset.js";
import {
  albumLine,
  genreLine,
  paletteBlock,
  PROMPT_VARIANTS,
  type DraftedPrompt,
  type PromptType,
  type PaletteColorRef,
  type PromptVariant,
} from "../roadie/prompts.js";
import { GeminiError, type GeminiClient } from "./client.js";
import { METAPROMPTS, VIDEO_ABSTRACT_METAPROMPT } from "./metaprompts.js";

export interface GeminiDraftOptions {
  /** Variants per type (default PROMPT_VARIANTS). */
  n?: number;
  /** Video metaprompt style: "photo" animates the cover (default); "abstract" is motion-design. */
  videoStyle?: "photo" | "abstract";
  /** Timestamp stamped on each draft (injectable for tests). */
  now?: () => string;
}

const RESEARCH_SYSTEM =
  "You are a music visual researcher. Given an album, gather concrete, factual visual details " +
  "about its cover art, booklet/liner artwork, music videos, promotional imagery, and the visual " +
  "aesthetic of its era: tangible subjects, motifs, textures, colors, and art direction. Be " +
  "concise and factual. Do not write image or video prompts yet — just the visual facts.";

// Structured-output schema for one drafting pass: an object with an array of {text, nudge}. The
// count (n) is requested in the user turn and enforced by parseVariants (slice + tolerate fewer),
// not by minItems/maxItems on the schema — the live responseSchema is picky about those, and a hard
// bound isn't worth a 400.
const VARIANTS_SCHEMA = {
  type: "object",
  properties: {
    variants: {
      type: "array",
      items: {
        type: "object",
        properties: {
          text: { type: "string" },
          nudge: { type: "string" },
        },
        required: ["text", "nudge"],
      },
    },
  },
  required: ["variants"],
} as const;

const metapromptFor = (
  type: PromptType,
  videoStyle: "photo" | "abstract",
): string =>
  type === "video" && videoStyle === "abstract"
    ? VIDEO_ABSTRACT_METAPROMPT
    : METAPROMPTS[type];

/** Compose the user turn for the drafting pass: album facts + research + the N-variant override. */
function draftUserPrompt(
  type: PromptType,
  metadata: AlbumMetadata,
  colors: PaletteColorRef[],
  research: string,
  n: number,
): string {
  const animateLine =
    type === "video"
      ? "Each prompt animates the album cover image as its visual reference — explicitly describe " +
        "how to animate elements already present in the cover.\n"
      : "";
  return [
    `Album: ${albumLine(metadata)}`,
    genreLine(metadata),
    `Color palette to draw from:\n${paletteBlock(colors)}`,
    "",
    "Research (real visual facts about THIS album — ground every prompt in these concrete motifs, " +
      "not generic mood or color-only descriptions):",
    research,
    "",
    "OUTPUT OVERRIDE (authoritative — supersedes any earlier instruction about the number of " +
      `options or ready-to-copy formatting): Produce exactly ${n} distinct prompt variants that ` +
      "follow every style rule and negative constraint above. Introduce deliberate variance across " +
      "the variants — vary framing, focal subject, motion emphasis, lighting, and texture so the " +
      `outputs differ meaningfully.\n${animateLine}Return JSON matching the schema: a "variants" ` +
      'array where each item has "text" (the full, ready-to-use prompt) and "nudge" (a short 2–5 ' +
      "word label for that variant's angle).",
  ].join("\n");
}

/** Parse the structured drafting response into validated variants, or throw for the caller to fall back. */
function parseVariants(json: string, n: number): PromptVariant[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new GeminiError("drafting response was not valid JSON");
  }
  const raw = (parsed as { variants?: unknown }).variants;
  if (!Array.isArray(raw))
    throw new GeminiError("drafting response had no variants array");
  const variants = raw
    .map((v) => ({
      text: String((v as PromptVariant)?.text ?? "").trim(),
      nudge: String((v as PromptVariant)?.nudge ?? "").trim(),
    }))
    .filter((v) => v.text.length > 0)
    .slice(0, n);
  if (variants.length === 0)
    throw new GeminiError("drafting response had no usable variants");
  return variants;
}

async function draftOne(
  client: GeminiClient,
  type: PromptType,
  metadata: AlbumMetadata,
  colors: PaletteColorRef[],
  research: string,
  n: number,
  videoStyle: "photo" | "abstract",
  at: string,
): Promise<DraftedPrompt> {
  const json = await client.generateText({
    system: metapromptFor(type, videoStyle),
    prompt: draftUserPrompt(type, metadata, colors, research, n),
    responseSchema: VARIANTS_SCHEMA,
    temperature: 1.0, // lean into variance across the set
  });
  return {
    variants: parseVariants(json, n),
    selectedIndex: 0,
    generator: "gemini",
    generatedAt: at,
  };
}

/**
 * Draft both prompts (video + card art) as grounded LLM variant sets. Throws (for the caller to
 * fall back to templates) if research or either drafting pass fails. The research pass runs once and
 * feeds both types — same facts, different medium.
 */
export async function draftPromptsWithGemini(
  client: GeminiClient,
  metadata: AlbumMetadata,
  colors: PaletteColorRef[],
  opts: GeminiDraftOptions = {},
): Promise<Record<"video" | "cardArt", DraftedPrompt>> {
  const n = opts.n ?? PROMPT_VARIANTS;
  const videoStyle = opts.videoStyle ?? "photo";
  const at = (opts.now ?? (() => new Date().toISOString()))();

  const research = await client.generateText({
    system: RESEARCH_SYSTEM,
    prompt: `Research the visual identity of the album ${albumLine(metadata)}. ${genreLine(metadata)}`,
    grounded: true,
  });

  const [video, cardArt] = await Promise.all([
    draftOne(client, "video", metadata, colors, research, n, videoStyle, at),
    draftOne(client, "cardArt", metadata, colors, research, n, videoStyle, at),
  ]);
  return { video, cardArt };
}

/**
 * Draft one prompt type as a grounded LLM variant set (research + one drafting pass). Used by the
 * on-demand "Regenerate with AI" action. Throws for the caller to surface — a manual regenerate,
 * unlike the pipeline step, has no silent template fallback (the existing draft stays put on error).
 */
export async function draftOnePromptWithGemini(
  client: GeminiClient,
  type: PromptType,
  metadata: AlbumMetadata,
  colors: PaletteColorRef[],
  opts: GeminiDraftOptions = {},
): Promise<DraftedPrompt> {
  const n = opts.n ?? PROMPT_VARIANTS;
  const videoStyle = opts.videoStyle ?? "photo";
  const at = (opts.now ?? (() => new Date().toISOString()))();
  const research = await client.generateText({
    system: RESEARCH_SYSTEM,
    prompt: `Research the visual identity of the album ${albumLine(metadata)}. ${genreLine(metadata)}`,
    grounded: true,
  });
  return draftOne(client, type, metadata, colors, research, n, videoStyle, at);
}
