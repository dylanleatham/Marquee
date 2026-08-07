// The ready toast (ADR 0052) — what "a record is finished" became.
//
// It used to be a screen you landed on. A screen is a stop: you have just signed a record off and
// the next one is what you want, so being made to acknowledge the last one is friction dressed as
// celebration. This is a corner of the collection that fades on its own and never blocks anything.
//
// A module store rather than context or a route: the *room* fires it and the *collection* renders
// it, one navigation apart, so there is no component alive at both ends to hold the state.
import { useSyncExternalStore } from "react";

/** Matches `ppToast`'s 5s in styles.css — the animation fades out, this clears the element after. */
const LIFETIME_MS = 5000;

let current: string | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<() => void>();

const emit = () => {
  for (const l of listeners) l();
};

/** Show it for `<title> is ready`. Re-firing while one is up replaces it and restarts the clock. */
export function showReadyToast(curatorId: string): void {
  if (timer) clearTimeout(timer);
  current = curatorId;
  timer = setTimeout(() => {
    current = null;
    timer = undefined;
    emit();
  }, LIFETIME_MS);
  emit();
}

/** Clear it early — what tapping it does, so the timer can't fire over the screen you just opened. */
export function dismissReadyToast(): void {
  if (timer) clearTimeout(timer);
  timer = undefined;
  current = null;
  emit();
}

const subscribe = (cb: () => void): (() => void) => {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
};

export const readyToastSnapshot = (): string | null => current;

/** The curatorId of the record being celebrated, or null. */
export const useReadyToast = (): string | null =>
  useSyncExternalStore(subscribe, readyToastSnapshot, () => null);
