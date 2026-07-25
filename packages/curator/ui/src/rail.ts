// The album-detail rail: five workstations, per ADR 0026 / curator-ui-ux §5. Pure logic — no React,
// no DOM — so the rules that matter (nothing is gated by state; readiness is information, not
// permission) are unit-testable on their own.
import type { AlbumAsset, RoadieState } from "./api";

export type WorkstationId = "look" | "video" | "card" | "preview" | "ship";

export interface Workstation {
  id: WorkstationId;
  label: string;
  /** Route segment under /albums/:curatorId. The rail is routable so back/forward work. */
  segment: string;
  /** One-line description of what this bench is for, shown as the canvas subhead. */
  blurb: string;
}

/**
 * Eight scrolling sections were the wrong unit — with five video prompts and five card-art prompts
 * rendered in full, the page became a document to scroll rather than a bench to work at. These five
 * match how the work actually arrives: "I have the card art, let me go do card things."
 */
export const WORKSTATIONS: Workstation[] = [
  {
    id: "look",
    label: "Look",
    segment: "look",
    blurb: "Palette, pattern, and the cover the palette comes from.",
  },
  {
    id: "video",
    label: "Video",
    segment: "video",
    blurb: "Prompts, generated clips, and the visualizer that ships.",
  },
  {
    id: "card",
    label: "Card",
    segment: "card",
    blurb: "Prompts, candidates, and the printed business-card art.",
  },
  {
    id: "preview",
    label: "Preview",
    segment: "preview",
    blurb: "See it whole — at the bench, or rehearsed in the real room.",
  },
  {
    id: "ship",
    label: "Ship",
    segment: "ship",
    blurb: "Tag payload, sticker bookkeeping, and physical verification.",
  },
];

/**
 * What a workstation currently holds. This is **information, never permission** (ADR 0026): every
 * workstation is always reachable regardless of what this returns.
 */
export type Readiness = "empty" | "ready" | "attached" | "blocked";

/**
 * Per curator-ui-ux §3.4, state is never encoded in colour alone — a dot is not a status, "● Ready"
 * is. Backdrop already shipped a colour-only indicator that was unreadable without colour vision
 * (PR #85); the rail is the same shape of risk, so every dot carries this word.
 */
export const READINESS_LABEL: Record<Readiness, string> = {
  empty: "Empty",
  ready: "Ready",
  attached: "Attached",
  blocked: "Needs attention",
};

/** What each workstation holds right now. Never consulted to decide whether it can be opened. */
export function readiness(id: WorkstationId, asset: AlbumAsset): Readiness {
  const hasPalette = (asset.palette?.colors?.length ?? 0) > 0;
  switch (id) {
    case "look":
      if (asset.palette?.insufficient) return "blocked";
      return hasPalette ? "ready" : "empty";
    case "video":
      if (asset.visualizer) return "attached";
      return asset.videoClips?.length || asset.promptDrafts?.video
        ? "ready"
        : "empty";
    case "card":
      if (asset.cardArt) return "attached";
      return asset.cardArtCandidates?.length || asset.promptDrafts?.cardArt
        ? "ready"
        : "empty";
    case "preview":
      if (asset.verification?.previewApprovedAt) return "attached";
      return hasPalette ? "ready" : "empty";
    case "ship":
      if (asset.verification?.physicallyVerifiedAt) return "attached";
      return asset.tag?.sleeve?.written ? "ready" : "empty";
  }
}

/**
 * Which workstation to open by default. This is the one place `roadie.state` legitimately influences
 * the detail UI: choosing where to land is *emphasis*, not gating (ADR 0026). Anything off the happy
 * path — still processing, errored, needs_manual — starts at Look, which is where the palette and the
 * error banner live.
 */
export function defaultWorkstation(state: RoadieState): WorkstationId {
  switch (state) {
    case "awaiting_video":
      return "video";
    case "awaiting_preview":
      return "preview";
    case "awaiting_tag_write":
    case "awaiting_verify":
    case "verified":
      return "ship";
    default:
      return "look";
  }
}

/** Resolve a URL segment to a workstation, falling back to the state-derived default. */
export function workstationFromSegment(
  segment: string | undefined,
  state: RoadieState,
): WorkstationId {
  const found = WORKSTATIONS.find((w) => w.segment === segment);
  return found ? found.id : defaultWorkstation(state);
}
