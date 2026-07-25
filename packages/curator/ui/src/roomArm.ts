// The room-arm switch (ADR 0028 / curator-ui-ux §6.3). The listening room may have other people in
// it, so driving the lights and starting music is a side effect on humans — not a rendering choice.
// Bench is the default and the safe path; arming is a single deliberate act at the start of a working
// session rather than a decision re-made at every button.
//
// A module-level store rather than context: the switch is read by controls scattered across the
// detail page, the Demo Room and the status bar, and every one of them must see the same value the
// instant it flips. `useSyncExternalStore` gives that without threading a provider through.
import { useSyncExternalStore } from "react";

export type RoomArm = "bench" | "live";

const KEY = "marquee.roomArm";

/** Shown wherever a hardware control is disabled, so "disabled" always carries its reason (§10). */
export const BENCH_REASON =
  "Room is set to bench-only — arm the room in the status bar to drive the real lights, display and Sonos.";

const listeners = new Set<() => void>();
// Cached so getSnapshot is referentially stable — reading localStorage per call would loop React.
let current: RoomArm | null = null;

function read(): RoomArm {
  if (current !== null) return current;
  try {
    current = localStorage.getItem(KEY) === "live" ? "live" : "bench";
  } catch {
    current = "bench"; // storage blocked/unavailable → the safe default, never the armed one
  }
  return current;
}

/** Flip the switch. Persisted, so it survives a relaunch of the desktop app. */
export function setRoomArm(next: RoomArm): void {
  current = next;
  try {
    localStorage.setItem(KEY, next);
  } catch {
    // Persistence is a convenience; an unwritable store must not break the in-session switch.
  }
  for (const l of listeners) l();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** Test seam: drop the cached value so a fresh localStorage state is picked up. */
export function resetRoomArmCache(): void {
  current = null;
  for (const l of listeners) l();
}

export function useRoomArm(): RoomArm {
  return useSyncExternalStore(subscribe, read, () => "bench");
}

/**
 * Everything a hardware-touching control needs: whether it may fire, and the reason if not.
 * Controls stay visible and disabled rather than disappearing — an absent control is
 * indistinguishable from one that doesn't exist (ADR 0026).
 */
export function useRoomGate(): { armed: boolean; reason: string | null } {
  const arm = useRoomArm();
  return arm === "live"
    ? { armed: true, reason: null }
    : { armed: false, reason: BENCH_REASON };
}
