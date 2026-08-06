/**
 * The message to show for something thrown.
 *
 * `catch` gives you `unknown`, and casting it to `Error` renders the string "undefined" the one time
 * it matters — when what came back wasn't an `Error`. Every screen wants the same sentence, so it is
 * one function rather than the same ternary written out at each `catch`.
 *
 * Its own module rather than `components/common.tsx`: `hooks.ts` needs it too, and `common.tsx`
 * already imports from `hooks.ts`.
 */
export const errorMessage = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);
