// ⌘⏎ — the primary action of the workstation you are on (curator-ui-ux §9.1, ADR 0044).
//
// The binding needed a decision before it needed a handler: *which* control is primary. That answer
// can't live in `rail.ts` beside the workstation list, because it depends on state the workstation
// owns — Look's primary is "save the palette", and only the palette editor knows whether the draft
// differs from what's stored. So each workstation declares its own, and this is the seam.
//
// Shape notes, both load-bearing:
//
//   * The callable is held in a **ref**, refreshed on every render. It closes over live component
//     state, and a copy captured at registration time would save a stale draft.
//   * The *label* is state, because the bench header renders it — but it is only written when it
//     actually changes, so re-registering every render costs nothing.
//   * The registration API is a separate context from the label, and is stable for the provider's
//     whole life. One combined context would change identity whenever the label did, re-running
//     every registrant's cleanup — release, re-claim, release — in a loop.
import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

export interface PrimaryAction {
  /** Names the effect, not the control: "Save palette", not "Save". Rendered beside ⌘⏎. */
  label: string;
  run: () => void | Promise<void>;
  /**
   * Set when the action exists but can't fire right now. Shown in the header, so a shortcut that
   * won't do anything says so *before* it is pressed rather than swallowing the keystroke
   * (§9.1: "a shortcut never silently does nothing"; §10: a disabled control carries its reason).
   */
  disabledReason?: string;
}

/** What the bench header renders. `null` = this workstation has no primary action. */
export interface PrimaryActionHint {
  label: string;
  disabledReason: string | null;
}

interface PrimaryActionApi {
  claim: (id: symbol, action: PrimaryAction | null) => void;
  release: (id: symbol) => void;
  /** Fire the registered action. Returns false when there was nothing to fire, or it's disabled. */
  fire: () => boolean;
}

const ApiContext = createContext<PrimaryActionApi | null>(null);
const HintContext = createContext<PrimaryActionHint | null>(null);

const sameHint = (a: PrimaryActionHint | null, b: PrimaryActionHint): boolean =>
  a !== null && a.label === b.label && a.disabledReason === b.disabledReason;

export function PrimaryActionProvider({ children }: { children: ReactNode }) {
  const [hint, setHint] = useState<PrimaryActionHint | null>(null);
  const runRef = useRef<(() => void | Promise<void>) | null>(null);
  const ownerRef = useRef<symbol | null>(null);
  const disabledRef = useRef(false);

  const release = useCallback((id: symbol) => {
    // Only the current owner may clear the slot. Switching workstations unmounts the old one and
    // mounts the new one in the same commit, and React runs every cleanup before any new effect —
    // so without this guard the outgoing bench would wipe the incoming bench's registration.
    if (ownerRef.current !== id) return;
    ownerRef.current = null;
    runRef.current = null;
    disabledRef.current = false;
    setHint(null);
  }, []);

  const claim = useCallback(
    (id: symbol, action: PrimaryAction | null) => {
      if (!action) {
        release(id);
        return;
      }
      ownerRef.current = id;
      runRef.current = action.run;
      disabledRef.current = action.disabledReason != null;
      const next: PrimaryActionHint = {
        label: action.label,
        disabledReason: action.disabledReason ?? null,
      };
      // Returning the previous object when nothing changed lets React bail out of the re-render,
      // which is what makes claiming on every render safe.
      setHint((prev) => (sameHint(prev, next) ? prev : next));
    },
    [release],
  );

  const fire = useCallback((): boolean => {
    if (!runRef.current || disabledRef.current) return false;
    void runRef.current();
    return true;
  }, []);

  const api = useMemo<PrimaryActionApi>(
    () => ({ claim, release, fire }),
    [claim, release, fire],
  );

  return (
    <ApiContext.Provider value={api}>
      <HintContext.Provider value={hint}>{children}</HintContext.Provider>
    </ApiContext.Provider>
  );
}

/**
 * Declare this workstation's primary action. Pass `null` — or nothing — when it has none; the
 * header then says so rather than leaving ⌘⏎ to be discovered as a dud.
 *
 * Safe outside a provider: the palette editor and the tag-write section are rendered on their own
 * in tests and could be reused elsewhere, and a missing provider must not throw.
 */
export function usePrimaryAction(action: PrimaryAction | null): void {
  const api = useContext(ApiContext);
  const idRef = useRef<symbol | null>(null);
  idRef.current ??= Symbol("primary-action");
  const id = idRef.current;

  // Deliberately no dependency array: `action.run` is a fresh closure over current state on every
  // render and must be re-registered every time. `claim` only touches state when the label or the
  // reason actually changes, so this cannot loop.
  //
  // **Layout, not passive** (issue #225). A passive effect runs *after* the paint, so the commit
  // that first shows a workstation painted a header reading "No primary action on this workstation"
  // on a bench that has one, and ⌘⏎ pressed in that window was a real dud — the same class as
  // [#119](https://github.com/dylanleatham/Marquee/issues/119), where the queue's key handler was
  // stale in precisely the moment the queue first appeared. React flushes the re-render this
  // schedules before the browser paints, so the header ADR 0044 §2 promises "always" names the
  // action is right in the frame the bench arrives, not the one after.
  useLayoutEffect(() => {
    api?.claim(id, action);
  });

  // Layout for the same reason, in the other direction: a bench that unmounts must not leave a stale
  // label painted beside ⌘⏎. The owner guard in `release` is what keeps the handover safe when both
  // benches' effects run in the one commit.
  useLayoutEffect(() => () => api?.release(id), [api, id]);
}

/** What ⌘⏎ would do right now — for the bench header. */
export function usePrimaryActionHint(): PrimaryActionHint | null {
  return useContext(HintContext);
}

/** Fire the current workstation's primary action. False when there is none, or it's disabled. */
export function useFirePrimaryAction(): () => boolean {
  const api = useContext(ApiContext);
  return useCallback(() => api?.fire() ?? false, [api]);
}
