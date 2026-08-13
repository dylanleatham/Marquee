import { type ButtonHTMLAttributes, type ReactNode } from "react";
import { artworkUrl } from "../api";
import { usePending } from "../hooks";

/*
 * `AlbumThumb`, `Cover` and their `useArtStatus` machinery lived here until 2026-08-06, and went
 * with the last screen that mounted them (ADR 0052). Their three-state model — a skeleton while
 * Roadie is still downloading, the cover, or the album's initials — was built for a list of rows on
 * paper stock. The overhaul's screens each need a different absence: the collection falls back to a
 * stripe of the record's own lights, the room's sleeve to a hatch on a dark stage, the toast to
 * nothing at all. One component cannot be all three, and pretending otherwise is how a shared
 * component becomes a pile of flags.
 *
 * What genuinely *was* shared survived as `artworkSrc` below: the freshness token that lets a cover
 * arriving after first paint actually appear (issue #25).
 */

// `StateBadge` lived here until 2026-08-05 (ADR 0052): a pill reading "Awaiting tag write" beside
// every row. It went with the queue — the overhaul does not name a machine state at the user, so a
// component whose entire job was rendering one had nothing left to do. What a record still needs is
// `needs.ts`, and the collection and the record page each draw it their own way.

/**
 * An artwork URL that changes when the artwork does.
 *
 * The endpoint 404s until Roadie downloads the cover, and a static `src` string means a cover that
 * lands *after* first paint never appears — the page polls, but the browser has already cached the
 * miss (issue #25). A `version` token that changes when the art becomes available (the content hash
 * on an asset, the artwork path on a list row) both busts the cache and clears any failure latch.
 */
export const artworkSrc = (
  curatorId: string,
  version?: string | null,
): string =>
  version
    ? `${artworkUrl(curatorId)}?v=${encodeURIComponent(version)}`
    : artworkUrl(curatorId);

/**
 * Open the OS file chooser and hand back what was picked.
 *
 * A detached input rather than a hidden one in the tree: nothing here needs to be tabbed to — the
 * visible button is the control, and it is a real `<button>`. Shared by the visualizer and card
 * panels, which differ only in what they accept.
 */
export function pickFile(accept: string, onFile: (f: File) => void): void {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = accept;
  input.onchange = () => {
    const f = input.files?.[0];
    if (f) onFile(f);
  };
  input.click();
}

export function Spinner() {
  return <span className="pp-spinner" aria-label="loading" />;
}

type AsyncButtonProps = Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "onClick"
> & {
  /** The async action; the button shows a spinner + disables itself until it settles. */
  onClick: () => unknown;
  /** Label shown (with the spinner) while in flight. Defaults to the normal children. */
  pendingLabel?: ReactNode;
  children: ReactNode;
};

/**
 * A button that owns its own in-flight state (issue #62): while its onClick promise is pending it
 * disables itself (blocking double-submits), shows a spinner, and can swap in a "…ing" label. Drop
 * it in for the slow, generative actions — regenerate/splice/generate — and any other run-routed
 * action, so each control gives its own feedback instead of relying on one page-level boolean.
 *
 * **Showing a failure is the caller's job.** This cannot render one — it is a `<button>`, and where
 * the sentence goes is a layout decision only the screen can make — so an `onClick` that can reject
 * must catch and surface it (`run` on the record page, `attempt`/`setSyncProblem` elsewhere). A
 * handler that doesn't gets the rejection logged rather than dropped: the button settling back with
 * no explanation has been a review finding three times, and a silent console is what made it hard to
 * spot each time.
 */
export function AsyncButton({
  onClick,
  pendingLabel,
  children,
  disabled,
  ...rest
}: AsyncButtonProps) {
  const [pending, wrap] = usePending();
  return (
    <button
      {...rest}
      disabled={disabled || pending}
      aria-busy={pending || undefined}
      onClick={() => {
        // Caught here only so a rejected action can't raise an unhandled rejection — and logged,
        // never dropped, so a handler that forgot to surface its own failure is findable. The
        // finally in wrap still clears pending.
        if (!pending)
          void wrap(onClick).catch((err: unknown) =>
            console.error("[curator-ui] a button's action failed:", err),
          );
      }}
    >
      {pending ? (
        <>
          <Spinner /> {pendingLabel ?? children}
        </>
      ) : (
        children
      )}
    </button>
  );
}
