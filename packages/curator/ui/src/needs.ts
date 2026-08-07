// What a record still needs (ADR 0052) — the model the collection and the record page share.
//
// The old UI read `roadie.state` and showed the machine's word for it ("awaiting review"). That
// asserted an order the system does not have: nothing requires lights before a visualizer before a
// card. Here the four needs are **independent predicates over the asset**, so "do them in any order"
// is true by construction rather than by promise.
//
// Pure, no React, no DOM — the derivation is the load-bearing part, so it is unit-tested directly.
import type { AlbumSummary, LastError, RoadieState } from "./api";
import { isProcessing } from "./format";

/** The four things a record can still need, plus the two conditions that aren't needs at all. */
export type Need = "lights" | "visualizer" | "card" | "tags";

export type RecordState =
  | { kind: "ready" }
  /** Roadie holds it right now — you can't do anything until it lets go. */
  | { kind: "roadie" }
  /** Roadie gave up. Lives in its own group with a sentence and a way out. */
  | { kind: "stuck"; sentence: string }
  | { kind: "needs"; need: Need };

/**
 * Reading order, not a dependency order. A record shows only its **first** outstanding need — never
 * a count, never "+1" — so this is the tie-break when more than one is missing.
 */
export const NEED_ORDER: Need[] = ["lights", "visualizer", "card", "tags"];

/**
 * The vocabulary, settled with the user over three rounds of review (see the design handoff). These
 * words are not cosmetic: "wants you", "fully lit", "awaiting verification" were all rejected.
 *
 * **Each label names the act you still have to perform, never the artifact.** `visualizer` and `card`
 * happen to read as the artifact because there genuinely isn't one yet. The other two don't:
 * `tags` reads as NEEDS SIGN-OFF because the outstanding act is checking the tags, not burning them,
 * and `lights` reads as NEEDS A LOOK because the palette has existed since seconds after the record
 * landed — what's outstanding is watching it in the room.
 *
 * `lights` was NEEDS LIGHTS until 2026-08-07 and it actively misled: on a 500-record collection it
 * reads as "Roadie never derived a palette", which sent this project's own user looking for a broken
 * pipeline that had in fact finished (ADR 0056). 458 of the 482 records carrying that label had a
 * full four-colour palette at the time.
 */
export const NEED_LABEL: Record<Need, string> = {
  lights: "NEEDS A LOOK",
  visualizer: "NEEDS VISUALIZER",
  card: "NEEDS CARD",
  tags: "NEEDS SIGN-OFF",
};

/** The same four, as the record page's tabs name them. */
export const NEED_TAB_LABEL: Record<Need, string> = {
  lights: "Lights",
  visualizer: "A visualizer",
  card: "A card",
  tags: "Tags",
};

/**
 * Plain English for a failure. Raw codes are allowed in exactly one place in the app — the
 * per-service errors on the System screen, where `connect ECONNREFUSED` is the actionable text. A
 * record that failed gets a sentence that says what to do next.
 *
 * Unknown reasons fall back to the server's message, which is at least a sentence written for a
 * human; an unmapped code would otherwise surface as `spotify_lookup_failed` in the Stuck row.
 */
export function failureSentence(err: LastError | null): string {
  const known: Record<string, string> = {
    spotify_lookup_failed:
      "Roadie couldn't find this anywhere — try a different name, or type the details in yourself",
    album_not_on_spotify:
      "Roadie couldn't find this anywhere — try a different name, or type the details in yourself",
    artwork_download_failed:
      "The sleeve wouldn't download — the cover may have moved. Try again, or upload your own",
    palette_insufficient:
      "There isn't enough colour in this sleeve to light a room — pick the lights by hand",
    discogs_lookup_failed:
      "Discogs wouldn't answer for this pressing — try again in a minute",
  };
  if (!err) return "Something went wrong. Try it again";
  return (
    (err.reason && known[err.reason]) ??
    known[err.message] ??
    err.message ??
    "Something went wrong. Try it again"
  );
}

/**
 * Is this record's lights business finished?
 *
 * Sign-off is the test, not "has a palette" — every record has a palette within seconds of being
 * added, and approving one means having watched it in the room. That is the whole reason the room
 * screen owns the approve button.
 */
const lightsDone = (a: AlbumSummary): boolean =>
  Boolean(a.previewApprovedAt) || a.state === "verified";

/**
 * Are the tags done? Written **and** checked. Verification stays a distinct step because it catches
 * real bugs — a sticker that opens the wrong record looks identical to one that works until you tap
 * it.
 */
const tagsDone = (a: AlbumSummary): boolean =>
  Boolean(a.physicallyVerifiedAt) || (a.tagsWritten && a.state === "verified");

/** Every outstanding need, in reading order. Empty means the record is ready for the stand. */
export function outstandingNeeds(a: AlbumSummary): Need[] {
  const missing: Record<Need, boolean> = {
    lights: !lightsDone(a),
    visualizer: !a.hasVideo,
    card: !a.hasCardArt,
    tags: !tagsDone(a),
  };
  return NEED_ORDER.filter((n) => missing[n]);
}

/**
 * Where a record stands, as the collection draws it.
 *
 * Order matters: a failed record is stuck whatever else is missing, and a record Roadie is holding
 * narrates itself rather than asking for something you can't give it yet.
 */
export function recordState(a: AlbumSummary): RecordState {
  if (a.state === "errored" || a.state === "needs_manual")
    return { kind: "stuck", sentence: failureSentence(a.lastError) };
  if (isProcessing(a.state)) return { kind: "roadie" };
  const [first] = outstandingNeeds(a);
  return first ? { kind: "needs", need: first } : { kind: "ready" };
}

/** The label the grid puts under a tile. Never a count, never a machine state name. */
export function stateLabel(s: RecordState): string {
  switch (s.kind) {
    case "ready":
      return "READY";
    case "roadie":
      return "ROADIE IS ON IT";
    case "stuck":
      return "STUCK";
    case "needs":
      return NEED_LABEL[s.need];
  }
}

/**
 * What Roadie is doing to this record, in words — for the tile that narrates itself in place (S04).
 * Never the state name: "finding the sleeve", not `downloading_art`.
 */
export function roadieNarration(state: RoadieState): string {
  const said: Partial<Record<RoadieState, string>> = {
    fresh: "NEXT IN LINE",
    fetching_metadata: "LOOKING IT UP…",
    downloading_art: "FINDING THE SLEEVE…",
    generating_palette: "PULLING THE LIGHTS…",
    drafting_prompts: "WRITING PROMPTS…",
  };
  return said[state] ?? "ROADIE IS ON IT";
}
