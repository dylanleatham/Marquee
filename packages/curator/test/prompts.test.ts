import { describe, it, expect } from "vitest";
import {
  draftPrompts,
  VIDEO_TEMPLATES,
  CARD_ART_TEMPLATES,
} from "../src/roadie/prompts.js";
import type { AlbumMetadata } from "../src/albums/asset.js";

const at = () => "2026-07-11T00:00:00.000Z";
const purpleRain: AlbumMetadata = {
  name: "Purple Rain",
  artist: "Prince",
  year: 1984,
  genres: ["funk", "rock", "pop"],
  source: "spotify",
};
const colors = [
  { hex: "#4B0082", role: "primary" },
  { hex: "#8A2BE2", role: "secondary" },
  { hex: "#FFD700", role: "accent" },
];

describe("draftPrompts", () => {
  it("drafts a video + card-art prompt with defaults (golden)", () => {
    const { video, cardArt } = draftPrompts(purpleRain, colors, { now: at });

    expect(video).toEqual({
      template: "abstract_flow",
      generatedAt: "2026-07-11T00:00:00.000Z",
      text: [
        'For the album "Purple Rain" by Prince (1984).',
        "Genre context: funk, rock, pop.",
        "Color palette to draw from:",
        "  - #4B0082 (primary)",
        "  - #8A2BE2 (secondary)",
        "  - #FFD700 (accent)",
        "Abstract flowing shapes with soft edges, drifting slowly through the palette.",
        "Duration: 3 minutes, seamlessly loopable.",
        "Aspect ratio: 16:9.",
      ].join("\n"),
    });

    expect(cardArt.template).toBe("iconic_emblem");
    expect(cardArt.text).toContain(
      'Business-card sized art for the album "Purple Rain" by Prince (1984).',
    );
    expect(cardArt.text).toContain(
      "Dimensions: 1050x600 pixels (business-card landscape at 300 DPI).",
    );
  });

  it("honors chosen templates per type and lists every documented option", () => {
    const { video, cardArt } = draftPrompts(purpleRain, colors, {
      videoTemplate: "psychedelic",
      cardArtTemplate: "typographic",
      now: at,
    });
    expect(video.template).toBe("psychedelic");
    expect(video.text).toContain("Kaleidoscopic");
    expect(cardArt.template).toBe("typographic");
    expect(cardArt.text).toContain("Bold typography");

    // Templates named in roadie-spec §7 all exist.
    expect(Object.keys(VIDEO_TEMPLATES)).toEqual([
      "abstract_flow",
      "particle_drift",
      "geometric_pulse",
      "analog_film",
      "psychedelic",
      "minimal_gradient",
    ]);
    expect(Object.keys(CARD_ART_TEMPLATES)).toEqual([
      "iconic_emblem",
      "abstract_scene",
      "typographic",
      "photograph_style",
      "collage",
    ]);
  });

  it("falls back to the default when given an unknown template", () => {
    const { video } = draftPrompts(purpleRain, colors, {
      videoTemplate: "does_not_exist",
      now: at,
    });
    expect(video.template).toBe("abstract_flow");
  });

  it("omits the year and marks genres unspecified when absent", () => {
    const minimal: AlbumMetadata = {
      name: "Untitled",
      artist: "Nobody",
      source: "manual",
    };
    const { video } = draftPrompts(minimal, colors, { now: at });
    expect(video.text).toContain('For the album "Untitled" by Nobody.');
    expect(video.text).toContain("Genre context: unspecified.");
    expect(video.text).not.toContain("(undefined)");
  });
});
