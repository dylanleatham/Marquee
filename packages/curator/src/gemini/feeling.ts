// Colours from what the record *sounds* like, not what its sleeve looks like (ADR 0030, issue #105).
//
// Palette Press reads the cover, and ADR 0022 derives motion energy from those same swatches — so a
// muted sleeve on a ferocious record gets a calm, slow crossfade. This is the escape hatch: two
// grounded Gemini calls that propose colours from the album's sound and subject matter, offered as a
// candidate next to the cover's, never applied on their own.
//
// Everything here throws on failure. Unlike Roadie's drafting step there is no silent fallback — the
// user pressed a button that costs money, so a failure is theirs to see, and the existing palette
// stays exactly as it was.
import type { AlbumMetadata } from "../albums/asset.js";
import { albumLine, genreLine } from "../roadie/prompts.js";
import { GeminiError, type GeminiClient } from "./client.js";

/**
 * Deliberately *not* the prompt drafter's research system prompt. That one gathers facts about cover
 * art, booklets and promotional imagery — the visual identity, which is precisely the signal the
 * cover already gives us. This asks about the record.
 */
const FEELING_SYSTEM =
  "You are a music listener with a strong visual imagination. Given an album, describe how it " +
  "SOUNDS and what it is ABOUT: its mood and emotional register, tempo and intensity, production " +
  "texture (warm/cold, clean/dirty, sparse/dense), lyrical subject matter, the setting or time of " +
  "day it evokes, and its place in its scene or era. Be concrete and factual about the music. " +
  "Deliberately do NOT describe the cover artwork — that is already accounted for elsewhere.";

const COLORS_SYSTEM =
  "You choose lighting colours for a room that should feel like a specific record is playing in " +
  "it. Given research about how an album sounds, pick colours that match the music's feeling. " +
  "These drive real Philips Hue bulbs, so prefer saturated, distinguishable hues over near-blacks, " +
  "near-whites and muddy browns, which a bulb renders as an indistinct dim glow. Order matters: " +
  "the first colour is the dominant one the room mostly sits in.";

const COLORS_SCHEMA = {
  type: "object",
  properties: {
    rationale: { type: "string" },
    colors: {
      type: "array",
      items: {
        type: "object",
        properties: {
          hex: { type: "string" },
          note: { type: "string" },
        },
        required: ["hex"],
      },
    },
  },
  required: ["rationale", "colors"],
} as const;

/** How many colours to ask for. Matches what Palette Press typically yields, so the two compare. */
export const FEELING_COLORS = 4;

export interface FeelingPalette {
  /** One line on why these colours — shown next to the swatches so the choice is legible. */
  rationale: string;
  /** Raw hex strings in dominance order; validated + gamut-clamped by the caller. */
  hexes: string[];
}

function parseFeeling(json: string): FeelingPalette {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new GeminiError("feeling-palette response was not valid JSON");
  }
  const { rationale, colors } = parsed as {
    rationale?: unknown;
    colors?: unknown;
  };
  if (!Array.isArray(colors))
    throw new GeminiError("feeling-palette response had no colors array");
  const hexes = colors
    .map((c) => String((c as { hex?: unknown })?.hex ?? "").trim())
    // Accept only well-formed hex here; sanitizePaletteEdit does the real normalising, but a model
    // that returned prose in the hex field should fail loudly rather than produce a 1-colour palette.
    .filter((h) => /^#?[0-9a-fA-F]{6}$/.test(h))
    .slice(0, FEELING_COLORS);
  if (hexes.length < 2)
    throw new GeminiError(
      "feeling-palette response had fewer than two usable colors",
    );
  return {
    rationale:
      typeof rationale === "string" && rationale.trim()
        ? rationale.trim()
        : "Colours drawn from the album's sound.",
    hexes,
  };
}

/**
 * Two passes, mirroring ADR 0009's shape: a grounded research call about the record, then a
 * structured-output call turning that into colours. Grounding and `responseSchema` can't share one
 * call, which is why it is two.
 */
export async function feelingPaletteWithGemini(
  client: GeminiClient,
  metadata: AlbumMetadata,
): Promise<FeelingPalette> {
  const research = await client.generateText({
    system: FEELING_SYSTEM,
    prompt: `Describe how the album ${albumLine(metadata)} sounds and what it is about. ${genreLine(metadata)}`,
    grounded: true,
  });

  const json = await client.generateText({
    system: COLORS_SYSTEM,
    prompt: [
      `Album: ${albumLine(metadata)}`,
      genreLine(metadata),
      "",
      "How this record sounds:",
      research,
      "",
      `Choose exactly ${FEELING_COLORS} lighting colours for a room playing this record, in ` +
        "dominance order. Return JSON matching the schema: a one-sentence `rationale` explaining " +
        "what about the music these colours capture, and a `colors` array of `{ hex }` in " +
        "#RRGGBB form.",
    ].join("\n"),
    responseSchema: COLORS_SCHEMA,
    temperature: 0.9,
  });

  return parseFeeling(json);
}
