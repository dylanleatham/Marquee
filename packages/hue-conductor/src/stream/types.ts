// Shared shapes for the Entertainment streaming effect engine (hue-conductor-spec §9 "streaming
// patterns"). These describe *what to send each frame*; the transport that actually pushes frames to
// the bridge over DTLS is a separate seam (see engine.ts `StreamTransport`) and is deferred to the
// hardware follow-up (ADR 0023). Everything here is pure and deterministic so effects are testable
// and previewable with no bridge.

/**
 * One controllable light in an entertainment area, placed in the room. Hue's entertainment
 * coordinates are roughly `x` ∈ [-1, 1] left→right and `y` ∈ [-1, 1] rear→front (we ignore height —
 * these effects are planar). Spatial effects (wave) read these positions; others just need the set.
 */
export interface StreamLight {
  id: string;
  x: number; // -1 (left) .. 1 (right)
  y: number; // -1 (rear) .. 1 (front)
}

/** One light's color for a single frame, 0–255 per channel. */
export interface LightColor {
  id: string;
  r: number;
  g: number;
  b: number;
}

/** A full frame: exactly one `LightColor` per light in the area, at one instant. */
export type StreamFrame = LightColor[];

/**
 * A pure, deterministic effect: given the elapsed time since the effect started, produce the frame.
 * The same `tMs` always yields the same frame — which is what makes effects unit-testable and lets
 * the preview precompute frames without a bridge.
 */
export interface StreamRenderer {
  frame(tMs: number): StreamFrame;
}
