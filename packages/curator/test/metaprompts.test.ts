import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  CARD_ART_METAPROMPT,
  VIDEO_PHOTO_METAPROMPT,
  VIDEO_ABSTRACT_METAPROMPT,
} from "../src/gemini/metaprompts.js";

// Drift guard: the bundled runtime constants must stay byte-for-byte in sync with the canonical,
// human-readable metaprompts in docs/prompts/ (CLAUDE.md: keep the docs honest). If someone edits
// one but not the other, this fails and names the file to reconcile.
const promptsDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "docs",
  "prompts",
);
// Normalize newline style (CRLF → LF) and incidental per-line trailing whitespace: the *content*
// is what must match, not the byte-level newline/trailing-space noise a checkout or editor adds.
const norm = (s: string) =>
  s
    .replace(/\r\n/g, "\n")
    .replace(/ /g, " ") // NBSP → space (docs indentation uses NBSP; content is equivalent)
    .split("\n")
    .map((l) => l.replace(/\s+$/, ""))
    .join("\n")
    .trim();
const read = (name: string) =>
  norm(readFileSync(join(promptsDir, name), "utf8"));

describe("bundled metaprompts match docs/prompts/", () => {
  it.each([
    ["cardArtMetaPrompt.md", CARD_ART_METAPROMPT],
    ["visualizerMetaPromptPhoto.md", VIDEO_PHOTO_METAPROMPT],
    ["visualizerMetaPrompt.md", VIDEO_ABSTRACT_METAPROMPT],
  ])("%s", (file, constant) => {
    expect(norm(constant)).toBe(read(file));
  });
});
